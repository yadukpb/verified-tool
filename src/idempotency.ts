import type { IdempotencyStore, StoredCall } from "./types.js";

/**
 * In-memory default. Fine for a single process / a demo. For anything that
 * needs to survive a restart or be shared across instances, back this
 * interface with Redis/Postgres/whatever you already run — that's the point
 * of it being an interface and not a hardcoded Map.
 */
export function createMemoryIdempotencyStore(): IdempotencyStore {
  const store = new Map<string, StoredCall>();
  return {
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}
