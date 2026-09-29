/** What actually happened, distinct from what the tool call returned. */
export type VerifyOutcome = "verified" | "failed" | "unknown";

/** Duck-typed to match a Zod schema's `.parse()` without depending on Zod. */
export interface Parser<TResult> {
  parse(input: unknown): TResult;
}

/** Pluggable store for idempotency dedup. Defaults to an in-memory Map. */
export interface IdempotencyStore {
  get(key: string): Promise<StoredCall | undefined>;
  set(key: string, value: StoredCall): Promise<void>;
}

export interface StoredCall {
  outcome: VerifyOutcome;
  result: unknown;
  storedAt: number;
}

export type UnknownPolicy = "escalate" | "retry" | "proceed";
export type FailedPolicy = "retry" | "throw" | "escalate";

export interface Policy {
  /** What to do when verify() can't confirm the state changed (default: "escalate"). */
  unknown?: UnknownPolicy;
  /** What to do once retries on a confirmed failure are exhausted (default: "throw"). */
  failed?: FailedPolicy;
}

export interface EscalationContext<TArgs, TResult> {
  tool: string;
  args: TArgs;
  result: TResult | undefined;
  outcome: VerifyOutcome;
  attempts: number;
  idempotencyKey?: string;
}

export type TraceEvent<TArgs = unknown, TResult = unknown> =
  | { type: "call_start"; tool: string; attempt: number; args: TArgs; timestamp: number }
  | { type: "call_error"; tool: string; attempt: number; error: unknown; timestamp: number }
  | { type: "schema_invalid"; tool: string; attempt: number; error: unknown; timestamp: number }
  | { type: "verify_result"; tool: string; attempt: number; outcome: VerifyOutcome; timestamp: number }
  | { type: "idempotent_hit"; tool: string; idempotencyKey: string; outcome: VerifyOutcome; timestamp: number }
  | { type: "retry"; tool: string; attempt: number; reason: "failed" | "unknown"; timestamp: number }
  | { type: "escalate"; tool: string; attempt: number; outcome: VerifyOutcome; timestamp: number }
  | { type: "settled"; tool: string; attempt: number; outcome: VerifyOutcome; timestamp: number };

export interface DefineToolOptions<TArgs, TResult> {
  name: string;
  /** Validates the raw return value's shape. Accepts a Zod schema directly (duck-typed). */
  schema?: Parser<TResult>;
  /**
   * Confirms whether the side effect actually happened, independent of what fn() returned.
   * Omit this and the tool is trusted at face value the moment it doesn't throw and passes
   * schema — that's an explicit, visible tradeoff, not a silent one.
   */
  verify?: (result: TResult, args: TArgs) => Promise<VerifyOutcome>;
  /** Derives a dedup key from args so retries/duplicate calls don't re-run a side effect. */
  idempotencyKey?: (args: TArgs) => string;
  idempotencyStore?: IdempotencyStore;
  policy?: Policy;
  maxRetries?: number;
  onEscalate?: (ctx: EscalationContext<TArgs, TResult>) => void | Promise<void>;
  trace?: (event: TraceEvent<TArgs, TResult>) => void;
}

export interface ToolCallResult<TResult> {
  ok: boolean;
  outcome: VerifyOutcome;
  result: TResult | undefined;
  attempts: number;
  escalated: boolean;
  idempotencyKey?: string;
}

export class EscalatedError extends Error {
  constructor(public ctx: EscalationContext<unknown, unknown>) {
    super(
      `Tool "${ctx.tool}" escalated after ${ctx.attempts} attempt(s): outcome was "${ctx.outcome}"`
    );
    this.name = "EscalatedError";
  }
}

export class ToolFailedError extends Error {
  constructor(public ctx: EscalationContext<unknown, unknown>) {
    super(
      `Tool "${ctx.tool}" failed after ${ctx.attempts} attempt(s), retries exhausted`
    );
    this.name = "ToolFailedError";
  }
}
