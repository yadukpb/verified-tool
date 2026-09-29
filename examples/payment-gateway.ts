/**
 * A stand-in for a real payment gateway (Stripe-shaped on purpose). The
 * ambiguity here is a REAL race, not a fake coinflip: dispatch() returns
 * immediately with a pending transaction, and the ledger only reflects the
 * true outcome after a delay that simulates webhook/settlement lag. Anyone
 * who has queried Stripe/PayPal/etc right after a charge and gotten
 * "pending" back will recognize this shape.
 */

type LedgerEntry = { status: "pending" | "succeeded" | "declined"; transactionId: string };

const ledger = new Map<string, LedgerEntry>(); // keyed by transactionId
const dispatchedByIdempotencyKey = new Map<string, string>(); // idempotencyKey -> transactionId

export interface PaymentArgs {
  orderId: string;
  amountCents: number;
  /** demo knob: how long real settlement takes for this call */
  settleAfterMs: number;
  /** demo knob: whether this charge is ultimately declined */
  willDecline?: boolean;
  /**
   * Mirrors Stripe's Idempotency-Key header: a real charge on retry with the
   * same key returns the ORIGINAL transaction instead of creating a new one.
   * This is the well-behaved case — plenty of real internal/legacy APIs
   * don't honor this at all, which is a limitation this library can't paper
   * over (see README).
   */
  idempotencyKey: string;
}

export interface PaymentDispatchResult {
  transactionId: string;
}

/** Simulates POST /charges — the gateway accepts the request and returns fast. */
export async function dispatchPayment(args: PaymentArgs): Promise<PaymentDispatchResult> {
  const existing = dispatchedByIdempotencyKey.get(args.idempotencyKey);
  if (existing) {
    return { transactionId: existing }; // downstream honored the idempotency key
  }

  const transactionId = `txn_${args.idempotencyKey}`;
  dispatchedByIdempotencyKey.set(args.idempotencyKey, transactionId);
  ledger.set(transactionId, { status: "pending", transactionId });

  setTimeout(() => {
    ledger.set(transactionId, { status: args.willDecline ? "declined" : "succeeded", transactionId });
  }, args.settleAfterMs);

  return { transactionId };
}

/** Simulates GET /charges/:id — reads whatever the ledger honestly holds right now. */
export async function getPaymentStatus(transactionId: string): Promise<LedgerEntry["status"]> {
  return ledger.get(transactionId)?.status ?? "pending";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
