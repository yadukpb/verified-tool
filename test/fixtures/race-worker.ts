// One "server instance". Usage: race-worker.ts <postgres|redis> <runId> <startAtMs> <race|crash>
// The external side effect is a row/list entry in the same database, standing in for a third-party API.
import { defineTool } from "../../src/index.js";
import { postgresBackend, redisBackend } from "./backends.js";

const [backend, runId, startAt, mode] = process.argv.slice(2);
const effectKey = "effect:1";

let externalWrite: () => Promise<void>;
let externalCount: () => Promise<number>;
let store, close: () => Promise<unknown>;

if (backend === "postgres") {
  const b = await postgresBackend(`vt_race_${runId}`);
  ({ store, close } = b);
  externalWrite = async () => void (await b.pool.query(`INSERT INTO vt_fx_${runId} (worker) VALUES ($1)`, [process.pid]));
  externalCount = async () => Number((await b.pool.query(`SELECT count(*) AS n FROM vt_fx_${runId}`)).rows[0].n);
} else {
  const b = redisBackend(`vt-race:${runId}:`);
  ({ store, close } = b);
  externalWrite = async () => void (await b.redis.rpush(`vt-fx:${runId}`, String(process.pid)));
  externalCount = async () => b.redis.llen(`vt-fx:${runId}`);
}

const tool = defineTool(
  async () => {
    await externalWrite();
    if (mode === "crash") process.kill(process.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 30));
    return { pid: process.pid };
  },
  {
    name: "race",
    store,
    effectKey: () => effectKey,
    leaseMs: mode === "crash" ? 300 : 10_000,
    reconcile: async () => ((await externalCount()) > 0 ? { outcome: "verified" } : { outcome: "failed" }),
  }
);

await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
const r = await tool({});
console.log(JSON.stringify({ reason: r.reason, executions: r.executions }));
await close();
