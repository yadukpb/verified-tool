import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * A small stand-in for Stripe's charge API with fault injection. Optionally
 * persisted to a JSON file so a separate process (e.g. after a crash) sees
 * the same charges, the way a real external system would.
 */

export class APIConnectionError extends Error {
  name = "APIConnectionError";
}
export class RateLimitError extends Error {
  name = "RateLimitError";
}

export type Fault =
  /** The charge is created, then the response never arrives (a timeout after commit). */
  | "lost_response"
  /** Rejected with 429 before anything is processed. */
  | "rate_limited";

export interface Charge {
  id: string;
  orderId: string;
  amountCents: number;
  createdAt: number;
  settleAt: number;
  decline: boolean;
}

export type ChargeStatus = "pending" | "succeeded" | "declined";

interface State {
  charges: Charge[];
  idempotency: Record<string, string>;
}

export interface CreateChargeParams {
  orderId: string;
  amountCents: number;
  /** Mirrors Stripe's Idempotency-Key header. */
  idempotencyKey?: string;
  /** How long until the charge leaves "pending". */
  settleMs?: number;
  decline?: boolean;
}

export class FakeStripe {
  /** Faults consumed in order, one per createCharge call. */
  faults: Fault[] = [];
  /** Runs right after a new charge is durably written. The crash demo kills the process here. */
  onCommit?: () => void;
  private memory: State = { charges: [], idempotency: {} };

  constructor(private readonly file?: string) {}

  private load(): State {
    if (!this.file) return this.memory;
    if (!existsSync(this.file)) return { charges: [], idempotency: {} };
    return JSON.parse(readFileSync(this.file, "utf8")) as State;
  }

  private save(state: State) {
    if (this.file) writeFileSync(this.file, JSON.stringify(state));
    else this.memory = state;
  }

  static statusOf(c: Charge): ChargeStatus {
    if (Date.now() < c.settleAt) return "pending";
    return c.decline ? "declined" : "succeeded";
  }

  async createCharge(p: CreateChargeParams): Promise<{ id: string; status: ChargeStatus }> {
    const fault = this.faults.shift();
    if (fault === "rate_limited") throw new RateLimitError("429 Too Many Requests (nothing was processed)");

    const state = this.load();
    let charge: Charge | undefined;
    const priorId = p.idempotencyKey ? state.idempotency[p.idempotencyKey] : undefined;
    if (priorId) {
      charge = state.charges.find((c) => c.id === priorId);
    } else {
      charge = {
        id: `ch_${state.charges.length + 1}_${p.orderId}`,
        orderId: p.orderId,
        amountCents: p.amountCents,
        createdAt: Date.now(),
        settleAt: Date.now() + (p.settleMs ?? 0),
        decline: p.decline ?? false,
      };
      state.charges.push(charge);
      if (p.idempotencyKey) state.idempotency[p.idempotencyKey] = charge.id;
      this.save(state);
      this.onCommit?.();
    }

    if (fault === "lost_response") {
      throw new APIConnectionError("Request timed out (the charge may or may not have been created)");
    }
    return { id: charge!.id, status: FakeStripe.statusOf(charge!) };
  }

  async retrieve(id: string): Promise<{ id: string; status: ChargeStatus } | undefined> {
    const c = this.load().charges.find((x) => x.id === id);
    return c && { id: c.id, status: FakeStripe.statusOf(c) };
  }

  /** Like `stripe.charges.search({ query: "metadata['order_id']:'…'" })`. */
  async searchByOrder(orderId: string): Promise<{ id: string; status: ChargeStatus }[]> {
    return this.load()
      .charges.filter((c) => c.orderId === orderId)
      .map((c) => ({ id: c.id, status: FakeStripe.statusOf(c) }));
  }

  countCharges(orderId: string): number {
    return this.load().charges.filter((c) => c.orderId === orderId).length;
  }
}
