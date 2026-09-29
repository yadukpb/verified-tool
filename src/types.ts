/** What actually happened in the world, as opposed to what the call returned. */
export type VerifyOutcome = "verified" | "failed" | "unknown";

/**
 * How a thrown error should be read:
 * - "not_executed": the request provably never took effect (e.g. a 429 or a
 *   connection refused before anything was sent). Safe to execute again.
 * - "ambiguous": the effect may or may not have committed (e.g. a timeout
 *   after the request was sent). Never blindly retried; reconciled instead.
 */
export type ErrorClass = "not_executed" | "ambiguous";

export type Reason =
  | "verified" // executed, then independently confirmed
  | "trusted" // executed, no verify() configured, so taken at face value
  | "cached" // this effect key already settled earlier; nothing re-executed
  | "reconciled" // response was lost or a previous run crashed; reconcile() found the effect
  | "failed" // confirmed the effect did not happen
  | "exhausted" // kept failing before execution until maxExecutions ran out
  | "denied" // authorize() refused
  | "in_flight" // another call holds this effect key right now
  | "ambiguous"; // could not determine whether the effect happened

/** Duck-typed to match a Zod schema's `.parse()` without depending on Zod. */
export interface Parser<T> {
  parse(input: unknown): T;
}

export interface EffectRecord {
  /**
   * claimed: a run is working on it (or crashed while working on it).
   * unresolved: a run finished without learning the outcome; waiting on reconcile or a person.
   * settled: confirmed done.
   */
  state: "claimed" | "unresolved" | "settled";
  /** Random token of the call that holds this record. */
  owner: string;
  /** Last time the owner renewed its lease. */
  claimedAt: number;
  /**
   * The owner's lease length. Stored with the claim so every instance judges
   * expiry the same way, even if they're configured with different leaseMs.
   */
  leaseMs?: number;
  settledAt?: number;
  result?: unknown;
}

/**
 * Durable record of which effects are in progress or done, keyed by effect key.
 * All three writes must be atomic.
 */
export interface EffectStore {
  get(key: string): Promise<EffectRecord | undefined>;
  /** Insert if absent. Returns null on success, or the existing record. */
  claim(key: string, record: EffectRecord): Promise<EffectRecord | null>;
  /** Replace only if the current record's owner is `expectedOwner`. Returns whether it did. */
  replace(key: string, expectedOwner: string, next: EffectRecord): Promise<boolean>;
  /** Delete only if the current record's owner is `expectedOwner`. Returns whether it did. */
  release(key: string, expectedOwner: string): Promise<boolean>;
}

export interface ToolContext<TArgs> {
  toolName: string;
  args: TArgs;
  /** Forward this downstream as an idempotency key (e.g. Stripe's Idempotency-Key header). */
  effectKey?: string;
  /** How many times the wrapped function has actually been invoked in this call so far. */
  execution: number;
}

export interface ReconcileResult<TResult> {
  outcome: VerifyOutcome;
  result?: TResult;
}

export interface EscalationContext<TArgs, TResult> extends ToolContext<TArgs> {
  reason: Reason;
  result?: TResult;
}

export type TraceEvent =
  | { type: "execute"; tool: string; execution: number; timestamp: number }
  | { type: "error"; tool: string; execution: number; errorClass: ErrorClass; error: unknown; timestamp: number }
  | { type: "schema_invalid"; tool: string; execution: number; error: unknown; timestamp: number }
  | { type: "verify"; tool: string; poll: number; outcome: VerifyOutcome; timestamp: number }
  | { type: "reconcile"; tool: string; poll: number; outcome: VerifyOutcome; timestamp: number }
  | { type: "cached"; tool: string; effectKey: string; timestamp: number }
  | { type: "in_flight"; tool: string; effectKey: string; timestamp: number }
  | { type: "stale_claim"; tool: string; effectKey: string; timestamp: number }
  | { type: "unresolved"; tool: string; effectKey: string; timestamp: number }
  | { type: "lost_claim"; tool: string; effectKey: string; timestamp: number }
  | { type: "hook_error"; tool: string; hook: "verify" | "reconcile" | "classifyError" | "onEscalate"; error: unknown; timestamp: number }
  | { type: "denied"; tool: string; timestamp: number }
  | { type: "escalate"; tool: string; reason: Reason; timestamp: number }
  | { type: "settled"; tool: string; outcome: VerifyOutcome; reason: Reason; executions: number; timestamp: number };

export interface PollOptions {
  /** How many times to check before giving up and calling it "unknown". Default 5. */
  attempts?: number;
  delayMs?: number;
  backoff?: number;
}

export interface DefineToolOptions<TArgs, TResult> {
  name: string;
  /**
   * Stable business identity of the side effect, e.g. `charge:${orderId}`.
   * Derive it from the business object, not the model's tool_call_id: when a
   * call errors, models commonly re-issue it with a fresh call id and the
   * same arguments, and only a business key catches that.
   */
  effectKey?: (args: TArgs) => string;
  store?: EffectStore;
  /**
   * How long a claim stays valid without renewal. The owner renews it before
   * every execution and every verify/reconcile poll; a claim that goes
   * unrenewed this long is presumed to belong to a crashed run and gets
   * reconciled. Must be longer than one worst-case execution of the tool or
   * one poll. Default 30s.
   */
  leaseMs?: number;
  schema?: Parser<TResult>;
  /**
   * Given the call's result, check whether the effect really happened. Polled
   * while "unknown". Return `{ outcome, result }` to replace the original
   * response with the fresher state you read (e.g. status "succeeded" rather
   * than the "pending" the create call returned).
   */
  verify?: (
    result: TResult,
    ctx: ToolContext<TArgs>
  ) => Promise<VerifyOutcome | ReconcileResult<TResult>>;
  /**
   * Without a result (the response was lost, or a previous run crashed),
   * look the effect up in the external system by effect key. This is what
   * makes a timed-out write safe: instead of re-executing, the wrapper asks
   * the real system whether the write landed.
   */
  reconcile?: (ctx: ToolContext<TArgs>) => Promise<ReconcileResult<TResult>>;
  /**
   * The system you call deduplicates repeated requests by `ctx.effectKey`
   * (Stripe's Idempotency-Key; an MCP tool annotated `idempotentHint: true`).
   * Then re-executing after an ambiguous error is safe, so it's what happens
   * when reconcile can't settle the question. Still counted against
   * maxExecutions and still checked by authorize(). If every attempt stays
   * ambiguous, the outcome is "unknown", never "failed".
   */
  downstreamIdempotent?: boolean;
  /** Defaults to treating every error as "ambiguous", which is the safe choice for write tools. */
  classifyError?: (error: unknown, ctx: ToolContext<TArgs>) => ErrorClass;
  /**
   * Checked before every actual execution, including re-executions after a
   * recovery. Proving an effect didn't happen isn't the same as still being
   * allowed to perform it.
   */
  authorize?: (ctx: ToolContext<TArgs>) => boolean | Promise<boolean>;
  /** Upper bound on real invocations of the wrapped function per call. Default 3. */
  maxExecutions?: number;
  poll?: PollOptions;
  /** What to report when the outcome stays unknown. Default "escalate". */
  onUnknown?: "escalate" | "proceed";
  onEscalate?: (ctx: EscalationContext<TArgs, TResult>) => void | Promise<void>;
  trace?: (event: TraceEvent) => void;
}

export interface ToolCallResult<TResult> {
  ok: boolean;
  outcome: VerifyOutcome;
  reason: Reason;
  result?: TResult;
  /** Real invocations of the wrapped function during this call. */
  executions: number;
  escalated: boolean;
  effectKey?: string;
}
