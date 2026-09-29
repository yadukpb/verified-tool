import { Redis } from "ioredis";
import pg from "pg";
import { createPostgresStore, createRedisStore } from "../../src/index.js";

export const PG_URL = process.env.PG_URL;
export const REDIS_URL = process.env.REDIS_URL;

export async function postgresBackend(table: string) {
  const pool = new pg.Pool({ connectionString: PG_URL, max: 20 });
  const store = createPostgresStore(pool, { table });
  await store.migrate();
  return { store, pool, close: () => pool.end() };
}

export function redisBackend(prefix: string) {
  const redis = new Redis(REDIS_URL!);
  const store = createRedisStore((script, keys, args) => redis.eval(script, keys.length, ...keys, ...args), { prefix });
  return { store, redis, close: () => redis.quit() };
}
