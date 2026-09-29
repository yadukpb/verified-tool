import { resolveEffect } from "./stores.js";
import type { EffectStore, ReconcileResult, ToolContext, VerifyOutcome } from "./types.js";

/**
 * verify() for anything with a status you can read back: a payment, a job,
 * a deployment. You say which statuses mean done and which mean it didn't
 * happen; everything else is "unknown" and gets polled.
 *
 *   verify: statusCheck((pi) => stripe.paymentIntents.retrieve(pi.id), (pi) => pi.status, {
 *     verified: ["succeeded"],
 *     failed: ["canceled", "requires_payment_method"],
 *   })
 */
export function statusCheck<TArgs, TResult>(
  read: (result: TResult, ctx: ToolContext<TArgs>) => Promise<TResult | undefined>,
  statusOf: (fresh: TResult) => string,
  statuses: { verified: string[]; failed?: string[] }
): (result: TResult, ctx: ToolContext<TArgs>) => Promise<ReconcileResult<TResult>> {
  return async (result, ctx) => {
    const fresh = await read(result, ctx);
    if (fresh === undefined) return { outcome: "unknown" };
    const status = statusOf(fresh);
    const outcome: VerifyOutcome = statuses.verified.includes(status)
      ? "verified"
      : statuses.failed?.includes(status)
        ? "failed"
        : "unknown";
    return { outcome, result: fresh };
  };
}

export interface MarkerOptions<TArgs, TResult> {
  /** Return the args with the marker written into a field that's stored with the object (a body, a description, metadata). */
  inject: (args: TArgs, marker: string) => TArgs;
  /**
   * List the objects the effect could have created, from a source that sees
   * its own writes (list the repo, query your table). Not a search index:
   * an index that lags returns "not found" for something created a second
   * ago, and that absence would trigger a duplicate.
   */
  list: (ctx: ToolContext<TArgs>) => Promise<TResult[]>;
  /** The text of an object to search for the marker. Default: JSON of the whole object. */
  text?: (item: TResult) => string;
  /** How the marker looks. Default: `verified-tool:<effectKey>`. */
  marker?: (effectKey: string) => string;
}

/**
 * For systems with no idempotency key but a way to list what exists
 * (issues, tickets, messages, calendar events, rows). Writes the effect key
 * into what you create, so reconcile() can find it again after a lost
 * response or a crash.
 *
 *   const marker = markerRecipe({ inject: (a, m) => ({ ...a, body: `${a.body}\n\n<!-- ${m} -->` }), list, text: (i) => i.body });
 *   defineTool(marker.wrap(createIssue), { effectKey, reconcile: marker.reconcile });
 */
export function markerRecipe<TArgs, TResult>(options: MarkerOptions<TArgs, TResult>) {
  const markerFor = options.marker ?? ((key: string) => `verified-tool:${key}`);
  const textOf = options.text ?? ((item: TResult) => JSON.stringify(item));
  const keyOf = (ctx: ToolContext<TArgs>) => {
    if (!ctx.effectKey) throw new Error(`markerRecipe needs an effectKey on tool "${ctx.toolName}"`);
    return ctx.effectKey;
  };

  return {
    markerFor,
    wrap(fn: (args: TArgs, ctx: ToolContext<TArgs>) => Promise<TResult>) {
      const wrapped = (args: TArgs, ctx: ToolContext<TArgs>) => fn(options.inject(args, markerFor(keyOf(ctx))), ctx);
      // Lets defineTool reject a missing effectKey when the tool is defined, not on first call.
      return Object.assign(wrapped, { requiresEffectKey: true as const });
    },
    async reconcile(ctx: ToolContext<TArgs>): Promise<ReconcileResult<TResult>> {
      const marker = markerFor(keyOf(ctx));
      const found = (await options.list(ctx)).find((item) => textOf(item).includes(marker));
      return found === undefined ? { outcome: "failed" } : { outcome: "verified", result: found };
    },
  };
}

/**
 * For systems you can't ask, only hear back from: email, SMS, push,
 * outbound webhooks. Returns a handler for your webhook endpoint that
 * settles the effect named in the event. Attach `ctx.effectKey` as metadata
 * when sending (SendGrid custom_args, Postmark Metadata, Twilio
 * StatusCallback query string) so the event can name it.
 *
 *   app.post("/webhooks/email", async (req) => {
 *     await settleEmail(req.body);
 *   });
 *   const settleEmail = settleOnEvent(store, {
 *     effectKey: (e) => e.custom_args?.effectKey,
 *     outcome: (e) => (e.event === "delivered" ? "verified" : e.event === "bounce" ? "failed" : undefined),
 *   });
 */
export function settleOnEvent<TEvent>(
  store: EffectStore,
  options: {
    effectKey: (event: TEvent) => string | undefined;
    /** undefined = this event doesn't settle anything (e.g. "processed", "opened"). */
    outcome: (event: TEvent) => "verified" | "failed" | undefined;
    result?: (event: TEvent) => unknown;
  }
): (event: TEvent) => Promise<boolean> {
  return async (event) => {
    const key = options.effectKey(event);
    const outcome = options.outcome(event);
    if (!key || !outcome) return false;
    return resolveEffect(store, key, outcome, options.result?.(event));
  };
}
