import { describe, expect, it, vi } from "vitest";
import { createMemoryStore, defineTool, describeOutcome, resolveEffect } from "../src/index.js";
import { makeChargeTool } from "../examples/charge-tool.js";
import { APIConnectionError, FakeStripe } from "../examples/fake-stripe.js";

const order = { orderId: "o988", amountCents: 1200 };

describe("lost response after the charge committed (LangGraph #8464 scenario)", () => {
  it("baseline: a naive retry-on-error double charges", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["lost_response"];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await stripe.createCharge(order);
        break;
      } catch (e) {
        if (!(e instanceof APIConnectionError)) throw e;
      }
    }
    expect(stripe.countCharges("o988")).toBe(2);
  });

  it("reconciles instead of re-executing: exactly one charge", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["lost_response"];
    const r = await makeChargeTool(stripe)(order);

    expect(stripe.countCharges("o988")).toBe(1);
    expect(r).toMatchObject({ ok: true, outcome: "verified", reason: "reconciled", executions: 1 });
  });

  it("without reconcile(), reports unknown and escalates instead of retrying", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["lost_response"];
    const onEscalate = vi.fn();
    const r = await makeChargeTool(stripe, { reconcile: undefined, onEscalate })(order);

    expect(stripe.countCharges("o988")).toBe(1);
    expect(r).toMatchObject({ ok: false, outcome: "unknown", reason: "ambiguous", escalated: true, executions: 1 });
    expect(onEscalate).toHaveBeenCalledOnce();
  });

  it("keeps the effect blocked after an ambiguous outcome: a follow-up call re-checks, doesn't re-execute or re-escalate", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["lost_response"];
    const onEscalate = vi.fn();
    const charge = makeChargeTool(stripe, { reconcile: undefined, onEscalate });
    await charge(order);
    const second = await charge(order);

    expect(second).toMatchObject({ outcome: "unknown", reason: "ambiguous", executions: 0, escalated: false });
    expect(onEscalate).toHaveBeenCalledOnce();
    expect(stripe.countCharges("o988")).toBe(1);
  });

  it("once reconcile can see it, a follow-up call settles the unresolved effect", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["lost_response"];
    const store = createMemoryStore();
    await makeChargeTool(stripe, { store, reconcile: undefined })(order);
    const later = await makeChargeTool(stripe, { store })(order);

    expect(later).toMatchObject({ ok: true, reason: "reconciled", executions: 0 });
    expect(stripe.countCharges("o988")).toBe(1);
  });

  it("an operator can settle an unresolved effect with resolveEffect()", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["lost_response"];
    const store = createMemoryStore();
    const charge = makeChargeTool(stripe, { store, reconcile: undefined });
    await charge(order);

    expect(await resolveEffect(store, "charge:o988", "verified", { id: "ch_1_o988" })).toBe(true);
    expect(await charge(order)).toMatchObject({ ok: true, reason: "cached", executions: 0 });
  });
});

describe("errors that prove nothing happened", () => {
  it("retries a 429 classified as not_executed, and charges once", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["rate_limited"];
    const r = await makeChargeTool(stripe)(order);

    expect(r).toMatchObject({ ok: true, reason: "verified", executions: 2 });
    expect(stripe.countCharges("o988")).toBe(1);
  });

  it("gives up with 'exhausted' when every attempt is rejected up front", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["rate_limited", "rate_limited", "rate_limited"];
    const r = await makeChargeTool(stripe, { poll: { delayMs: 1 } })(order);

    expect(r).toMatchObject({ ok: false, outcome: "failed", reason: "exhausted", executions: 3 });
    expect(stripe.countCharges("o988")).toBe(0);
  });
});

describe("duplicate calls for the same business effect", () => {
  it("a re-planned call with the same args is served from the store, not re-executed", async () => {
    const stripe = new FakeStripe();
    const charge = makeChargeTool(stripe);
    await charge(order);
    const again = await charge(order);

    expect(again).toMatchObject({ ok: true, reason: "cached", executions: 0 });
    expect(stripe.countCharges("o988")).toBe(1);
  });

  it("two concurrent calls: one executes, the other is told it's in flight", async () => {
    const stripe = new FakeStripe();
    const charge = makeChargeTool(stripe);
    const [a, b] = await Promise.all([charge(order), charge(order)]);

    expect([a.reason, b.reason].sort()).toEqual(["in_flight", "verified"]);
    expect(stripe.countCharges("o988")).toBe(1);
  });
});

describe("recovering a claim left behind by a crashed run", () => {
  const staleClaim = async () => {
    const store = createMemoryStore();
    await store.claim("charge:o988", { state: "claimed", owner: "dead-run", claimedAt: Date.now() - 60_000 });
    return store;
  };

  it("the effect had landed: settles it without executing again", async () => {
    const stripe = new FakeStripe();
    await stripe.createCharge(order);
    const r = await makeChargeTool(stripe, { store: await staleClaim() })(order);

    expect(r).toMatchObject({ ok: true, reason: "reconciled", executions: 0 });
    expect(stripe.countCharges("o988")).toBe(1);
  });

  it("the effect never landed: executes once", async () => {
    const stripe = new FakeStripe();
    const r = await makeChargeTool(stripe, { store: await staleClaim() })(order);

    expect(r).toMatchObject({ ok: true, reason: "verified", executions: 1 });
    expect(stripe.countCharges("o988")).toBe(1);
  });

  it("re-checks authorization before executing on recovery", async () => {
    const stripe = new FakeStripe();
    const r = await makeChargeTool(stripe, { store: await staleClaim(), authorize: () => false })(order);

    expect(r).toMatchObject({ ok: false, reason: "denied", executions: 0 });
    expect(stripe.countCharges("o988")).toBe(0);
  });
});

describe("races and ownership", () => {
  it("two callers finding the same expired claim: only one takes over and executes", async () => {
    const store = createMemoryStore();
    await store.claim("k", { state: "claimed", owner: "dead-run", claimedAt: 0 });
    let runs = 0;
    const tool = defineTool(
      async () => {
        runs += 1;
        return {};
      },
      { name: "t", store, effectKey: () => "k", reconcile: async () => ({ outcome: "failed" }) }
    );
    const results = await Promise.all([tool({}), tool({}), tool({})]);

    expect(runs).toBe(1);
    expect(results.filter((r) => r.reason === "in_flight")).toHaveLength(2);
  });

  it("a live run renews its lease while polling, so nobody can take over mid-verify", async () => {
    let runs = 0;
    let settled = false;
    const tool = defineTool(
      async () => {
        runs += 1;
        return {};
      },
      {
        name: "t",
        effectKey: () => "k",
        leaseMs: 60,
        poll: { attempts: 20, delayMs: 20, backoff: 1 },
        verify: async () => (settled ? "verified" : "unknown"),
        reconcile: async () => ({ outcome: "failed" }),
      }
    );
    const first = tool({});
    await new Promise((r) => setTimeout(r, 150)); // well past one lease
    const second = await tool({});
    settled = true;

    expect(second.reason).toBe("in_flight");
    expect((await first).reason).toBe("verified");
    expect(runs).toBe(1);
  });

  it("expiry uses the lease the claim was written with, not the reader's own setting", async () => {
    const store = createMemoryStore();
    // written by an instance configured with a 60s lease, 1s ago
    await store.claim("k", { state: "claimed", owner: "live", claimedAt: Date.now() - 1_000, leaseMs: 60_000 });
    let runs = 0;
    const shortLeaseInstance = defineTool(
      async () => {
        runs += 1;
        return {};
      },
      { name: "t", store, effectKey: () => "k", leaseMs: 100, reconcile: async () => ({ outcome: "failed" }) }
    );

    expect((await shortLeaseInstance({})).reason).toBe("in_flight");
    expect(runs).toBe(0);
  });

  it("a run that lost its claim can't release or overwrite the new owner's", async () => {
    const store = createMemoryStore();
    await store.claim("k", { state: "claimed", owner: "new-owner", claimedAt: Date.now() });
    expect(await store.release("k", "old-owner")).toBe(false);
    expect(await store.replace("k", "old-owner", { state: "settled", owner: "old-owner", claimedAt: 0 })).toBe(false);
    expect((await store.get("k"))?.owner).toBe("new-owner");
  });
});

describe("hooks that throw", () => {
  it("authorize throwing releases the claim instead of leaving it 'in flight'", async () => {
    let fail = true;
    const tool = defineTool(async () => ({}), {
      name: "t",
      effectKey: () => "k",
      authorize: () => {
        if (fail) throw new Error("policy service down");
        return true;
      },
    });
    await expect(tool({})).rejects.toThrow("policy service down");
    fail = false;
    expect(await tool({})).toMatchObject({ ok: true, executions: 1 });
  });

  it("verify throwing counts as 'unknown' for that poll, not a crash", async () => {
    let polls = 0;
    const tool = defineTool(async () => ({}), {
      name: "t",
      poll: { delayMs: 1 },
      verify: async () => {
        polls += 1;
        if (polls === 1) throw new Error("read timed out");
        return "verified";
      },
    });
    expect(await tool({})).toMatchObject({ ok: true, reason: "verified", executions: 1 });
  });

  it("onEscalate throwing still returns the ambiguous result", async () => {
    const tool = defineTool(
      async () => {
        throw new Error("timeout");
      },
      {
        name: "t",
        onEscalate: () => {
          throw new Error("pager down");
        },
      }
    );
    expect(await tool({})).toMatchObject({ outcome: "unknown", reason: "ambiguous", escalated: true });
  });
});

describe("verification", () => {
  it("polls a pending charge until it settles, without re-executing", async () => {
    const stripe = new FakeStripe();
    const r = await makeChargeTool(stripe)({ ...order, settleMs: 250 });

    expect(r).toMatchObject({ ok: true, reason: "verified", executions: 1 });
    expect(stripe.countCharges("o988")).toBe(1);
  });

  it("a declined charge is reported as failed and not retried", async () => {
    const stripe = new FakeStripe();
    const r = await makeChargeTool(stripe)({ ...order, decline: true });

    expect(r).toMatchObject({ ok: false, outcome: "failed", reason: "failed", executions: 1 });
  });

  it("still pending after polling: unknown, escalated", async () => {
    const stripe = new FakeStripe();
    const r = await makeChargeTool(stripe, { poll: { attempts: 2, delayMs: 10 } })({ ...order, settleMs: 5_000 });

    expect(r).toMatchObject({ ok: false, outcome: "unknown", reason: "ambiguous", escalated: true });
  });

  it("with onUnknown: 'proceed', an unresolved outcome is ok but still reported as unknown", async () => {
    const stripe = new FakeStripe();
    const r = await makeChargeTool(stripe, { onUnknown: "proceed", poll: { attempts: 1 } })({ ...order, settleMs: 5_000 });

    expect(r).toMatchObject({ ok: true, outcome: "unknown", escalated: false });
  });

  it("an unreadable response is treated like a lost one and reconciled", async () => {
    const stripe = new FakeStripe();
    const r = await makeChargeTool(stripe, {
      schema: {
        parse: () => {
          throw new Error("unexpected shape");
        },
      },
    })(order);

    expect(r).toMatchObject({ ok: true, reason: "reconciled", executions: 1 });
    expect(stripe.countCharges("o988")).toBe(1);
  });

  it("without verify(), a clean return is trusted and labelled as such", async () => {
    const tool = defineTool(async () => ({ done: true }), { name: "noop" });
    const r = await tool({});
    expect(r).toMatchObject({ ok: true, outcome: "verified", reason: "trusted" });
  });
});

describe("describeOutcome", () => {
  it("tells the model not to retry or claim success when the outcome is unknown", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["lost_response"];
    const r = await makeChargeTool(stripe, { reconcile: undefined })(order);
    const text = describeOutcome(r, "charge_card");

    expect(text).toMatch(/Do not retry/);
    expect(text).toMatch(/do not tell the user it succeeded/);
  });
});
