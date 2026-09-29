import type { EffectRecord, EffectStore } from "./types.js";

/** Single-process store. Loses everything on restart, so it can't recover from a crash. */
export function createMemoryStore(): EffectStore {
  const records = new Map<string, EffectRecord>();
  return {
    async get(key) {
      return records.get(key);
    },
    async claim(key, record) {
      const existing = records.get(key);
      if (existing) return existing;
      records.set(key, record);
      return null;
    },
    async replace(key, expectedOwner, next) {
      if (records.get(key)?.owner !== expectedOwner) return false;
      records.set(key, next);
      return true;
    },
    async release(key, expectedOwner) {
      if (records.get(key)?.owner !== expectedOwner) return false;
      records.delete(key);
      return true;
    },
  };
}

/**
 * For an operator settling an effect that ended "unknown", once they've
 * checked by hand. "verified" makes later calls return it as cached;
 * "failed" clears it so a later call may execute.
 */
export async function resolveEffect(
  store: EffectStore,
  key: string,
  outcome: "verified" | "failed",
  result?: unknown
): Promise<boolean> {
  const current = await store.get(key);
  if (!current) return false;
  if (outcome === "failed") return store.release(key, current.owner);
  const now = Date.now();
  return store.replace(key, current.owner, {
    state: "settled",
    owner: current.owner,
    claimedAt: now,
    settledAt: now,
    result,
  });
}
