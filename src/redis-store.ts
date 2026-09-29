import type { EffectRecord, EffectStore } from "./types.js";

/**
 * Runs a Lua script. Redis clients spell EVAL differently, so you pass a
 * one-line adapter:
 *
 *   ioredis:     (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args)
 *   node-redis:  (script, keys, args) => client.eval(script, { keys, arguments: args })
 *   Upstash:     (script, keys, args) => redis.eval(script, keys, args)
 */
export type RedisEval = (script: string, keys: string[], args: string[]) => Promise<unknown>;

export interface RedisStoreOptions {
  /** Prepended to every effect key. Default "verified-tool:". */
  prefix?: string;
}

// Each script touches one key, so this works on Redis Cluster too.
const GET = `return redis.call('GET', KEYS[1])`;
const CLAIM = `
local cur = redis.call('GET', KEYS[1])
if cur then return cur end
redis.call('SET', KEYS[1], ARGV[1])
return false`;
const REPLACE = `
local cur = redis.call('GET', KEYS[1])
if not cur or cjson.decode(cur).owner ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;
const RELEASE = `
local cur = redis.call('GET', KEYS[1])
if not cur or cjson.decode(cur).owner ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1`;

/**
 * Effect store for multiple instances sharing one Redis. Each operation is
 * one Lua script, which Redis runs atomically.
 *
 * Use Redis persistence you trust (AOF with fsync) for this data. If Redis
 * loses a settled record, the next call reconciles again, which is safe. If
 * it loses a live claim, a second instance may run the effect concurrently.
 * Leases compare each instance's own clock, as with the Postgres store.
 */
export function createRedisStore(evalScript: RedisEval, options: RedisStoreOptions = {}): EffectStore {
  const prefix = options.prefix ?? "verified-tool:";
  const parse = (raw: unknown): EffectRecord | undefined =>
    typeof raw === "string" ? (JSON.parse(raw) as EffectRecord) : undefined;

  return {
    async get(key) {
      return parse(await evalScript(GET, [prefix + key], []));
    },
    async claim(key, record) {
      return parse(await evalScript(CLAIM, [prefix + key], [JSON.stringify(record)])) ?? null;
    },
    async replace(key, expectedOwner, next) {
      return Number(await evalScript(REPLACE, [prefix + key], [expectedOwner, JSON.stringify(next)])) === 1;
    },
    async release(key, expectedOwner) {
      return Number(await evalScript(RELEASE, [prefix + key], [expectedOwner])) === 1;
    },
  };
}
