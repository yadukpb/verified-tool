import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { PG_URL, REDIS_URL } from "./fixtures/backends.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const worker = fileURLToPath(new URL("./fixtures/race-worker.ts", import.meta.url));
const INSTANCES = 8;

function runWorker(backend: string, runId: string, startAt: number, mode: string) {
  return new Promise<{ signal: NodeJS.Signals | null; out: { reason: string; executions: number } | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, backend, runId, String(startAt), mode], {
      cwd: root,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (_code, signal) => resolve({ signal, out: stdout.trim() ? JSON.parse(stdout.trim()) : null, stderr }));
  });
}

async function setupExternal(backend: string, runId: string) {
  if (backend === "postgres") {
    const pool = new pg.Pool({ connectionString: PG_URL });
    await pool.query(`CREATE TABLE vt_fx_${runId} (worker int)`);
    return {
      count: async () => Number((await pool.query(`SELECT count(*) AS n FROM vt_fx_${runId}`)).rows[0].n),
      close: () => pool.end(),
    };
  }
  const redis = new Redis(REDIS_URL!);
  return { count: () => redis.llen(`vt-fx:${runId}`), close: () => redis.quit() };
}

for (const backend of ["postgres", "redis"] as const) {
  const enabled = backend === "postgres" ? !!PG_URL : !!REDIS_URL;

  describe.skipIf(!enabled)(`${backend}: separate processes as separate servers`, () => {
    it(`${INSTANCES} instances fire the same effect at the same moment: it happens once`, async () => {
      const runId = `r${Date.now()}${Math.floor(Math.random() * 1e4)}`;
      const external = await setupExternal(backend, runId);
      const startAt = Date.now() + 2500;
      const results = await Promise.all(Array.from({ length: INSTANCES }, () => runWorker(backend, runId, startAt, "race")));
      for (const r of results) expect(r.out, r.stderr).not.toBeNull();

      expect(await external.count()).toBe(1);
      expect(results.reduce((n, r) => n + r.out!.executions, 0)).toBe(1);
      expect(results.every((r) => ["trusted", "in_flight", "cached"].includes(r.out!.reason))).toBe(true);
      await external.close();
    }, 30_000);

    it(`one instance is killed mid-effect; ${INSTANCES - 1} others race to recover it: one reconciles, none re-execute`, async () => {
      const runId = `c${Date.now()}${Math.floor(Math.random() * 1e4)}`;
      const external = await setupExternal(backend, runId);

      const crashed = await runWorker(backend, runId, Date.now(), "crash");
      expect(crashed.signal).toBe("SIGKILL");
      expect(await external.count()).toBe(1);

      // start after the dead instance's 300ms lease has expired
      const startAt = Date.now() + 2500;
      const results = await Promise.all(Array.from({ length: INSTANCES - 1 }, () => runWorker(backend, runId, startAt, "race")));
      for (const r of results) expect(r.out, r.stderr).not.toBeNull();
      const reasons = results.map((r) => r.out!.reason);

      expect(await external.count()).toBe(1);
      expect(results.reduce((n, r) => n + r.out!.executions, 0)).toBe(0);
      expect(reasons.filter((r) => r === "reconciled")).toHaveLength(1);
      expect(reasons.every((r) => ["reconciled", "in_flight", "cached"].includes(r))).toBe(true);
      await external.close();
    }, 30_000);
  });
}
