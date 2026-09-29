import { createMemoryIdempotencyStore } from "./idempotency.js";
import {
  EscalatedError,
  ToolFailedError,
  type DefineToolOptions,
  type EscalationContext,
  type ToolCallResult,
  type VerifyOutcome,
} from "./types.js";

/**
 * Wraps an async tool function so its caller (typically an LLM agent loop)
 * gets back a confirmed outcome instead of a bare return value.
 *
 * What this does NOT do: magically verify anything. `verify()` is yours to
 * write, and for a real chunk of integrations (webhook-only delivery, no
 * read-back endpoint) the honest answer is "unknown" every time. That's not
 * a bug in this library — a boolean wrapper would force you to guess true
 * or false in that case, which is exactly how agents end up reporting false
 * success. Three states exist so "we don't actually know" has somewhere to go.
 */
export function defineTool<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  options: DefineToolOptions<TArgs, TResult>
): (args: TArgs) => Promise<ToolCallResult<TResult>> {
  const {
    name,
    schema,
    verify,
    idempotencyKey,
    idempotencyStore = createMemoryIdempotencyStore(),
    policy = {},
    maxRetries = 2,
    onEscalate,
    trace,
  } = options;

  const unknownPolicy = policy.unknown ?? "escalate";
  const failedPolicy = policy.failed ?? "throw";

  const emit = (event: Parameters<NonNullable<typeof trace>>[0]) => trace?.(event);

  async function attemptOnce(
    args: TArgs,
    attempt: number
  ): Promise<{ outcome: VerifyOutcome; result: TResult | undefined }> {
    emit({ type: "call_start", tool: name, attempt, args, timestamp: Date.now() });

    let raw: TResult;
    try {
      raw = await fn(args);
    } catch (error) {
      emit({ type: "call_error", tool: name, attempt, error, timestamp: Date.now() });
      return { outcome: "failed", result: undefined };
    }

    let result: TResult = raw;
    if (schema) {
      try {
        result = schema.parse(raw);
      } catch (error) {
        emit({ type: "schema_invalid", tool: name, attempt, error, timestamp: Date.now() });
        return { outcome: "failed", result: undefined };
      }
    }

    const outcome: VerifyOutcome = verify ? await verify(result, args) : "verified";
    emit({ type: "verify_result", tool: name, attempt, outcome, timestamp: Date.now() });
    return { outcome, result };
  }

  return async function verifiedTool(args: TArgs): Promise<ToolCallResult<TResult>> {
    const key = idempotencyKey?.(args);

    if (key) {
      const cached = await idempotencyStore.get(key);
      if (cached && cached.outcome === "verified") {
        emit({ type: "idempotent_hit", tool: name, idempotencyKey: key, outcome: cached.outcome, timestamp: Date.now() });
        return {
          ok: true,
          outcome: "verified",
          result: cached.result as TResult,
          attempts: 0,
          escalated: false,
          idempotencyKey: key,
        };
      }
    }

    let attempts = 0;
    let last: { outcome: VerifyOutcome; result: TResult | undefined } = {
      outcome: "unknown",
      result: undefined,
    };

    while (attempts <= maxRetries) {
      attempts += 1;
      last = await attemptOnce(args, attempts);

      if (last.outcome === "verified") {
        if (key) await idempotencyStore.set(key, { outcome: "verified", result: last.result, storedAt: Date.now() });
        emit({ type: "settled", tool: name, attempt: attempts, outcome: "verified", timestamp: Date.now() });
        return { ok: true, outcome: "verified", result: last.result, attempts, escalated: false, idempotencyKey: key };
      }

      const shouldRetry =
        (last.outcome === "failed" && attempts <= maxRetries) ||
        (last.outcome === "unknown" && unknownPolicy === "retry" && attempts <= maxRetries);

      if (shouldRetry) {
        emit({ type: "retry", tool: name, attempt: attempts, reason: last.outcome as "failed" | "unknown", timestamp: Date.now() });
        continue;
      }

      break;
    }

    const ctx: EscalationContext<TArgs, TResult> = {
      tool: name,
      args,
      result: last.result,
      outcome: last.outcome,
      attempts,
      idempotencyKey: key,
    };

    if (last.outcome === "unknown" && unknownPolicy === "proceed") {
      emit({ type: "settled", tool: name, attempt: attempts, outcome: "unknown", timestamp: Date.now() });
      return { ok: true, outcome: "unknown", result: last.result, attempts, escalated: false, idempotencyKey: key };
    }

    if (last.outcome === "unknown" && unknownPolicy === "escalate") {
      emit({ type: "escalate", tool: name, attempt: attempts, outcome: "unknown", timestamp: Date.now() });
      await onEscalate?.(ctx);
      return { ok: false, outcome: "unknown", result: last.result, attempts, escalated: true, idempotencyKey: key };
    }

    if (last.outcome === "failed" && failedPolicy === "escalate") {
      emit({ type: "escalate", tool: name, attempt: attempts, outcome: "failed", timestamp: Date.now() });
      await onEscalate?.(ctx);
      return { ok: false, outcome: "failed", result: last.result, attempts, escalated: true, idempotencyKey: key };
    }

    if (last.outcome === "failed" && failedPolicy === "throw") {
      emit({ type: "settled", tool: name, attempt: attempts, outcome: "failed", timestamp: Date.now() });
      throw new ToolFailedError(ctx as EscalationContext<unknown, unknown>);
    }

    emit({ type: "settled", tool: name, attempt: attempts, outcome: last.outcome, timestamp: Date.now() });
    if (last.outcome === "unknown") {
      throw new EscalatedError(ctx as EscalationContext<unknown, unknown>);
    }
    return { ok: false, outcome: last.outcome, result: last.result, attempts, escalated: false, idempotencyKey: key };
  };
}
