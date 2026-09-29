import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createMemoryStore, defineTool, type EffectRecord, type EffectStore } from "../src/index.js";
import { createFileStore } from "../src/file-store.js";
import { PG_URL, REDIS_URL, postgresBackend, redisBackend } from "./fixtures/backends.js";

const run = `${process.pid}_${Date.now()}`;
const closers: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const close of closers) await close();
});

const backends: { name: string; enabled: boolean; make: () => Promise<EffectStore> }[] = [
  { name: "memory", enabled: true, make: async () => createMemoryStore() },
  { name: "file", enabled: true, make: async () => createFileStore(mkdtempSync(join(tmpdir(), "vt-contract-"))) },
  {
    name: "postgres",
    enabled: !!PG_URL,
    make: async () => {
      const b = await postgresBackend(`vt_contract_${run}_${Math.random().toString(36).slice(2, 8)}`);
      closers.push(b.close);
      return b.store;
    },
  },
  {
    name: "redis",
    enabled: !!REDIS_URL,
    make: async () => {
      const b = redisBackend(`vt-contract:${run}:${Math.random().toString(36).slice(2, 8)}:`);
      closers.push(b.close);
      return b.store;
    },
  },
];

const rec = (owner: string, extra: Partial<EffectRecord> = {}): EffectRecord => ({
  state: "claimed",
  owner,
  claimedAt: 1_700_000_000_000,
  ...extra,
});

for (const b of backends) {
  describe.skipIf(!b.enabled)(`${b.name} store`, () => {
    it("claim succeeds once; later claims get the existing record", async () => {
      const store = await b.make();
      expect(await store.claim("k", rec("a"))).toBeNull();
      expect(await store.claim("k", rec("b"))).toMatchObject({ owner: "a", state: "claimed", claimedAt: 1_700_000_000_000 });
    });

    it("25 concurrent claims: exactly one wins, every loser sees the winner", async () => {
      const store = await b.make();
      const results = await Promise.all(Array.from({ length: 25 }, (_, i) => store.claim("race", rec(`o${i}`))));
      const winner = (await store.get("race"))!.owner;
      expect(results.filter((r) => r === null)).toHaveLength(1);
      expect(results.every((r) => r === null || r.owner === winner)).toBe(true);
    });

    it("replace only for the current owner, and round-trips the result", async () => {
      const store = await b.make();
      await store.claim("k", rec("a"));
      const settled = rec("a", { state: "settled", settledAt: 1_700_000_000_500, result: { id: "ch_1", items: [1, { x: "y" }] } });
      expect(await store.replace("k", "b", settled)).toBe(false);
      expect(await store.replace("k", "a", settled)).toBe(true);
      expect(await store.get("k")).toEqual(settled);
      expect(await store.replace("missing", "a", settled)).toBe(false);
    });

    it("release only for the current owner; the key can be claimed again", async () => {
      const store = await b.make();
      await store.claim("k", rec("a"));
      expect(await store.release("k", "b")).toBe(false);
      expect(await store.release("k", "a")).toBe(true);
      expect(await store.get("k")).toBeUndefined();
      expect(await store.claim("k", rec("c"))).toBeNull();
    });

    it("end to end: a lost response is reconciled, not re-executed", async () => {
      const store = await b.make();
      let effects = 0;
      const tool = defineTool(
        async () => {
          effects += 1;
          throw new Error("timeout after commit");
        },
        { name: "t", store, effectKey: () => "e2e", reconcile: async () => (effects ? { outcome: "verified" } : { outcome: "failed" }) }
      );
      expect(await tool({})).toMatchObject({ reason: "reconciled", executions: 1 });
      expect(await tool({})).toMatchObject({ reason: "cached", executions: 0 });
      expect(effects).toBe(1);
    });
  });
}
