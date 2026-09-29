import { describe, expect, it } from "vitest";
import { createMemoryStore, defineTool, markerRecipe, settleOnEvent, statusCheck } from "../src/index.js";
import { makeChargeTool } from "../examples/charge-tool.js";
import { FakeStripe } from "../examples/fake-stripe.js";

const order = { orderId: "o988", amountCents: 1200 };

describe("downstreamIdempotent", () => {
  it("after a lost response, re-executes with the same key and the provider returns the original charge", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["lost_response"];
    const r = await makeChargeTool(stripe, { reconcile: undefined, downstreamIdempotent: true, poll: { delayMs: 1 } })(order);

    expect(r).toMatchObject({ ok: true, reason: "verified", executions: 2 });
    expect(stripe.countCharges("o988")).toBe(1);
  });

  it("if every attempt stays ambiguous, reports unknown rather than failed", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["lost_response", "lost_response", "lost_response"];
    const r = await makeChargeTool(stripe, { reconcile: undefined, downstreamIdempotent: true, poll: { delayMs: 1 } })(order);

    expect(r).toMatchObject({ ok: false, outcome: "unknown", reason: "ambiguous", executions: 3 });
    expect(stripe.countCharges("o988")).toBe(1);
  });

  it("still checks authorize() before re-executing", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["lost_response"];
    let checks = 0;
    const r = await makeChargeTool(stripe, {
      reconcile: undefined,
      downstreamIdempotent: true,
      poll: { delayMs: 1 },
      authorize: () => ++checks === 1,
    })(order);

    expect(r).toMatchObject({ reason: "denied", executions: 1 });
  });
});

describe("statusCheck", () => {
  const check = statusCheck(async (r: { s: string }) => r, (r) => r.s, { verified: ["ok"], failed: ["gone"] });
  const ctx = { toolName: "t", args: {}, execution: 1 };

  it("maps statuses to outcomes and returns the fresh object", async () => {
    expect(await check({ s: "ok" }, ctx)).toEqual({ outcome: "verified", result: { s: "ok" } });
    expect(await check({ s: "gone" }, ctx)).toMatchObject({ outcome: "failed" });
    expect(await check({ s: "pending" }, ctx)).toMatchObject({ outcome: "unknown" });
  });

  it("an object that can't be read yet is unknown", async () => {
    const missing = statusCheck<object, object>(async () => undefined, () => "", { verified: ["ok"] });
    expect(await missing({}, ctx)).toEqual({ outcome: "unknown" });
  });
});

describe("markerRecipe", () => {
  it("writes the marker in, and finds the object by it", async () => {
    const created: { body: string }[] = [];
    const marker = markerRecipe<{ body: string }, { body: string }>({
      inject: (a, m) => ({ body: `${a.body} [${m}]` }),
      list: async () => created,
    });
    const tool = defineTool(
      marker.wrap(async (a) => {
        created.push(a);
        throw new Error("timeout");
      }),
      { name: "t", effectKey: () => "k1", reconcile: marker.reconcile }
    );

    expect(await tool({ body: "hello" })).toMatchObject({ reason: "reconciled", executions: 1 });
    expect(created).toEqual([{ body: "hello [verified-tool:k1]" }]);
  });

  it("a missing effect key is rejected when the tool is defined, not on first call", () => {
    const marker = markerRecipe<object, object>({ inject: (a) => a, list: async () => [] });
    expect(() => defineTool(marker.wrap(async () => ({})), { name: "t" })).toThrow(/needs an effectKey/);
  });
});

describe("settleOnEvent", () => {
  it("settles on events that decide the outcome, ignores the rest", async () => {
    const store = createMemoryStore();
    await store.claim("k", { state: "unresolved", owner: "x", claimedAt: Date.now() });
    const settle = settleOnEvent<{ key: string; type: string }>(store, {
      effectKey: (e) => e.key,
      outcome: (e) => (e.type === "delivered" ? "verified" : e.type === "bounce" ? "failed" : undefined),
    });

    expect(await settle({ key: "k", type: "opened" })).toBe(false);
    expect((await store.get("k"))?.state).toBe("unresolved");
    expect(await settle({ key: "k", type: "delivered" })).toBe(true);
    expect((await store.get("k"))?.state).toBe("settled");
  });
});
