import { defineTool, statusCheck, type DefineToolOptions, type VerifyOutcome } from "../src/index.js";
import { FakeStripe, RateLimitError, type ChargeStatus } from "./fake-stripe.js";

export interface ChargeArgs {
  orderId: string;
  amountCents: number;
  settleMs?: number;
  decline?: boolean;
}

export interface ChargeResult {
  id: string;
  status: ChargeStatus;
}

const toOutcome = (status: ChargeStatus): VerifyOutcome =>
  status === "succeeded" ? "verified" : status === "declined" ? "failed" : "unknown";

export function makeChargeTool(
  stripe: FakeStripe,
  overrides: Partial<DefineToolOptions<ChargeArgs, ChargeResult>> = {}
) {
  return defineTool<ChargeArgs, ChargeResult>(
    // Forward the effect key as the idempotency key so the gateway dedupes too.
    (args, ctx) => stripe.createCharge({ ...args, idempotencyKey: ctx.effectKey }),
    {
      name: "charge_card",
      effectKey: (args) => `charge:${args.orderId}`,
      classifyError: (error) => (error instanceof RateLimitError ? "not_executed" : "ambiguous"),
      verify: statusCheck((r) => stripe.retrieve(r.id), (c) => c.status, {
        verified: ["succeeded"],
        failed: ["declined"],
      }),
      // With real Stripe, prefer replaying the request with the same
      // Idempotency-Key (Stripe returns the original response) over
      // charges.search, which is eventually consistent.
      reconcile: async ({ args }) => {
        const found = await stripe.searchByOrder(args.orderId);
        if (found.length === 0) return { outcome: "failed" };
        return { outcome: toOutcome(found[0].status), result: found[0] };
      },
      poll: { attempts: 6, delayMs: 100, backoff: 1.5 },
      ...overrides,
    }
  );
}
