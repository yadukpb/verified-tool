import { defineTool } from "./defineTool.js";
import { describeOutcome } from "./describe.js";
import type { DefineToolOptions, Reason, VerifyOutcome } from "./types.js";

/** What the model receives as the tool result. */
export interface VerifiedToolOutput<TResult> {
  outcome: VerifyOutcome;
  reason: Reason;
  /** Plain-language instructions: what happened and whether to retry. */
  message: string;
  result?: TResult;
}

type AnyExecute = (input: any, options: any) => unknown;
// The AI SDK's Tool type is a union; a plain Omit would flatten it into something `tools: {}` rejects.
// Only this part distributes; input/output are computed once for the whole tool.
type Wrapped<T, TIn, TOut> = T extends unknown
  ? Omit<T, "execute"> & { execute: (input: TIn, callOptions: any) => Promise<TOut> }
  : never;
// Read from execute's own signature; a structural `infer` match loses the type when strict mode is off.
type ExecuteOf<T> = [T] extends [{ execute?: infer E }] ? NonNullable<E> : never;
type InputOf<T> = ExecuteOf<T> extends (...args: any[]) => any ? Parameters<ExecuteOf<T>>[0] : never;
type OutputOf<T> = ExecuteOf<T> extends (...args: any[]) => any ? Awaited<ReturnType<ExecuteOf<T>>> : never;

/**
 * Wraps a Vercel AI SDK `tool({...})` so its execute goes through
 * defineTool. Everything else on the tool (description, inputSchema,
 * approval, toModelOutput) is kept. The model receives
 * `{ outcome, reason, message, result }`, where `message` tells it plainly
 * whether it may retry and what it may tell the user.
 *
 *   const chargeCard = withVerification(
 *     tool({ description, inputSchema, execute: (input) => stripe.paymentIntents.create(...) }),
 *     { name: "charge_card", effectKey: (input) => `charge:${input.orderId}`, reconcile, store }
 *   );
 *
 * The AI SDK's per-call options (toolCallId, abortSignal, messages) are
 * passed through to your execute unchanged. Streaming (async generator)
 * execute functions aren't supported: a streamed side effect has no single
 * result to verify.
 */
export function withVerification<T extends { execute?: AnyExecute }>(
  tool: T,
  options: DefineToolOptions<InputOf<T>, OutputOf<T>>
): Wrapped<T, InputOf<T>, VerifiedToolOutput<OutputOf<T>>> {
  const execute = tool.execute;
  if (!execute) throw new Error(`Tool "${options.name}" has no execute function to wrap`);

  // defineTool calls fn(args, ctx); the AI SDK's own per-call options ride
  // alongside the input object for this one call.
  const callOptions = new WeakMap<object, unknown>();

  const verified = defineTool<InputOf<T>, OutputOf<T>>(async (input) => {
    const out = await execute(input, callOptions.get(input as object));
    if (out && typeof out === "object" && Symbol.asyncIterator in out) {
      throw new Error(`Tool "${options.name}" streams its result; withVerification needs a single result`);
    }
    return out as OutputOf<T>;
  }, options);

  return {
    ...tool,
    async execute(input: InputOf<T>, opts: unknown): Promise<VerifiedToolOutput<OutputOf<T>>> {
      callOptions.set(input as object, opts);
      const r = await verified(input);
      return { outcome: r.outcome, reason: r.reason, message: describeOutcome(r, options.name), result: r.result };
    },
  } as unknown as Wrapped<T, InputOf<T>, VerifiedToolOutput<OutputOf<T>>>;
}
