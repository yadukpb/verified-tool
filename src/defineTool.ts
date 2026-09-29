import { createMemoryStore } from "./stores.js";
import type {
  DefineToolOptions,
  EffectRecord,
  ErrorClass,
  Reason,
  ReconcileResult,
  ToolCallResult,
  ToolContext,
  TraceEvent,
  VerifyOutcome,
} from "./types.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** Thrown internally when another call has taken over our claim; we stop touching the effect. */
class LostClaim extends Error {}

/**
 * Wraps a side-effecting tool so the agent gets back what actually happened
 * rather than what the call returned.
 *
 * The rule it enforces: after the request may have reached the outside world,
 * the only way to learn more is to read the outside world (verify /
 * reconcile). Re-executing is allowed only when an error proves the request
 * never took effect, or reconcile proves it didn't.
 */
export function defineTool<TArgs, TResult>(
  fn: (args: TArgs, ctx: ToolContext<TArgs>) => Promise<TResult>,
  options: DefineToolOptions<TArgs, TResult>
): (args: TArgs) => Promise<ToolCallResult<TResult>> {
  const {
    name,
    effectKey,
    store = createMemoryStore(),
    leaseMs = 30_000,
    schema,
    verify,
    reconcile,
    classifyError,
    downstreamIdempotent = false,
    authorize,
    maxExecutions = 3,
    poll = {},
    onUnknown = "escalate",
    onEscalate,
    trace,
  } = options;

  if ((fn as { requiresEffectKey?: boolean }).requiresEffectKey && !effectKey) {
    throw new Error(`Tool "${name}" uses markerRecipe, which needs an effectKey option`);
  }

  const pollAttempts = Math.max(1, poll.attempts ?? 5);
  const pollDelayMs = poll.delayMs ?? 250;
  const pollBackoff = poll.backoff ?? 1.5;

  const emit = (event: DistributiveOmit<TraceEvent, "tool" | "timestamp">) =>
    trace?.({ ...event, tool: name, timestamp: Date.now() } as TraceEvent);

  return async function verifiedTool(args: TArgs): Promise<ToolCallResult<TResult>> {
    const key = effectKey?.(args);
    const owner = globalThis.crypto.randomUUID();
    let executions = 0;
    // Set when we re-execute without proof the previous attempt didn't land.
    let unprovenRetry = false;
    const ctx = (): ToolContext<TArgs> => ({ toolName: name, args, effectKey: key, execution: executions });
    const record = (state: EffectRecord["state"], extra: Partial<EffectRecord> = {}): EffectRecord => ({
      state,
      owner,
      claimedAt: Date.now(),
      leaseMs,
      ...extra,
    });

    const inFlight = (): ToolCallResult<TResult> => ({
      ok: false,
      outcome: "unknown",
      reason: "in_flight",
      executions,
      escalated: false,
      effectKey: key,
    });

    /** Extends our lease. If someone else took the claim over, stop here. */
    async function renew() {
      if (key && !(await store.replace(key, owner, record("claimed")))) {
        emit({ type: "lost_claim", effectKey: key });
        throw new LostClaim();
      }
    }

    async function finish(
      outcome: VerifyOutcome,
      reason: Reason,
      result?: TResult,
      escalate = true
    ): Promise<ToolCallResult<TResult>> {
      // Only the owner may settle; a stale run that lost its claim writes nothing.
      if (key) {
        if (outcome === "verified") {
          await store.replace(key, owner, record("settled", { settledAt: Date.now(), result }));
        } else if (outcome === "failed") {
          await store.release(key, owner);
        } else {
          // Keep the effect blocked until reconcile or a person settles it.
          await store.replace(key, owner, record("unresolved"));
        }
      }

      let escalated = false;
      if (reason === "ambiguous" && onUnknown === "escalate" && escalate) {
        escalated = true;
        emit({ type: "escalate", reason });
        try {
          await onEscalate?.({ ...ctx(), reason, result });
        } catch (error) {
          emit({ type: "hook_error", hook: "onEscalate", error });
        }
      }

      emit({ type: "settled", outcome, reason, executions });
      const ok = outcome === "verified" || (reason === "ambiguous" && onUnknown === "proceed");
      return { ok, outcome, reason, result, executions, escalated, effectKey: key };
    }

    async function pollUntilKnown(
      check: () => Promise<ReconcileResult<TResult>>,
      kind: "verify" | "reconcile"
    ): Promise<ReconcileResult<TResult>> {
      let delay = pollDelayMs;
      let last: ReconcileResult<TResult> = { outcome: "unknown" };
      for (let i = 1; i <= pollAttempts; i++) {
        await renew();
        try {
          last = await check();
        } catch (error) {
          // A read that fails tells us nothing about the effect.
          emit({ type: "hook_error", hook: kind, error });
          last = { outcome: "unknown" };
        }
        emit({ type: kind, poll: i, outcome: last.outcome });
        if (last.outcome !== "unknown") return last;
        if (i < pollAttempts) {
          await sleep(delay);
          delay *= pollBackoff;
        }
      }
      return last;
    }

    /** After a lost/unreadable response: a final result, or "retry" if reconcile proved nothing happened. */
    async function resolveAmbiguity(escalate = true): Promise<ToolCallResult<TResult> | "retry"> {
      const rec = reconcile
        ? await pollUntilKnown(() => reconcile(ctx()), "reconcile")
        : ({ outcome: "unknown" } as ReconcileResult<TResult>);
      if (rec.outcome === "verified") return finish("verified", "reconciled", rec.result);
      if (rec.outcome === "failed") return "retry";
      if (downstreamIdempotent) {
        unprovenRetry = true;
        return "retry";
      }
      return finish("unknown", "ambiguous", undefined, escalate);
    }

    function classify(error: unknown): ErrorClass {
      if (!classifyError) return "ambiguous";
      try {
        return classifyError(error, ctx());
      } catch (hookError) {
        emit({ type: "hook_error", hook: "classifyError", error: hookError });
        return "ambiguous";
      }
    }

    try {
      if (key) {
        const existing = await store.claim(key, record("claimed"));
        if (existing) {
          if (existing.state === "settled") {
            emit({ type: "cached", effectKey: key });
            return {
              ok: true,
              outcome: "verified",
              reason: "cached",
              result: existing.result as TResult,
              executions: 0,
              escalated: false,
              effectKey: key,
            };
          }
          const expired = Date.now() - existing.claimedAt >= (existing.leaseMs ?? leaseMs);
          if (existing.state === "claimed" && !expired) {
            emit({ type: "in_flight", effectKey: key });
            return inFlight();
          }
          // Either an earlier run finished without an answer, or it died holding the claim.
          // Take over atomically so only one caller does the recovery.
          if (!(await store.replace(key, existing.owner, record("claimed")))) {
            emit({ type: "in_flight", effectKey: key });
            return inFlight();
          }
          emit({ type: existing.state === "unresolved" ? "unresolved" : "stale_claim", effectKey: key });
          // An unresolved effect was already escalated once; don't page again for the same thing.
          const recovered = await resolveAmbiguity(existing.state !== "unresolved");
          if (recovered !== "retry") return recovered;
        }
      }

      while (executions < maxExecutions) {
        await renew();
        // Everything that reaches this point has proven nothing happened yet,
        // so if authorize throws it is safe to let go of the claim.
        let allowed: boolean;
        try {
          allowed = authorize ? await authorize(ctx()) : true;
        } catch (error) {
          if (key) await store.release(key, owner);
          throw error;
        }
        if (!allowed) {
          emit({ type: "denied" });
          return finish("failed", "denied");
        }

        executions += 1;
        emit({ type: "execute", execution: executions });

        let raw: TResult;
        try {
          raw = await fn(args, ctx());
        } catch (error) {
          const errorClass = classify(error);
          emit({ type: "error", execution: executions, errorClass, error });
          if (errorClass === "not_executed") {
            if (executions < maxExecutions) await sleep(pollDelayMs);
            continue;
          }
          const resolved = await resolveAmbiguity();
          if (resolved === "retry") {
            if (executions < maxExecutions) await sleep(pollDelayMs);
            continue;
          }
          return resolved;
        }

        let result = raw;
        if (schema) {
          try {
            result = schema.parse(raw);
          } catch (error) {
            // The call went through; we just can't read what came back.
            emit({ type: "schema_invalid", execution: executions, error });
            const resolved = await resolveAmbiguity();
            if (resolved === "retry") continue;
            return resolved;
          }
        }

        if (!verify) return finish("verified", "trusted", result);

        const checked = await pollUntilKnown(async () => {
          const v = await verify(result, ctx());
          return typeof v === "string" ? { outcome: v } : v;
        }, "verify");
        const latest = checked.result ?? result;
        if (checked.outcome === "verified") return finish("verified", "verified", latest);
        if (checked.outcome === "failed") return finish("failed", "failed", latest);
        return finish("unknown", "ambiguous", latest);
      }

      return unprovenRetry ? finish("unknown", "ambiguous") : finish("failed", "exhausted");
    } catch (error) {
      if (error instanceof LostClaim) return inFlight();
      throw error;
    }
  };
}
