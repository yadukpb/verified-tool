import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createFileStore } from "../src/file-store.js";
import { makeChargeTool } from "../examples/charge-tool.js";
import { FakeStripe } from "../examples/fake-stripe.js";

const LEASE_MS = 400;
const root = fileURLToPath(new URL("..", import.meta.url));

it("a process SIGKILLed right after the charge commits is recovered without a second charge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "verified-tool-crash-"));
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", join(root, "examples", "crash-child.ts"), dir],
    { cwd: root, env: { ...process.env, LEASE_MS: String(LEASE_MS) }, encoding: "utf8" }
  );

  expect(child.signal).toBe("SIGKILL");
  const stripe = new FakeStripe(join(dir, "stripe.json"));
  expect(stripe.countCharges("o988")).toBe(1);

  const charge = makeChargeTool(stripe, { store: createFileStore(join(dir, "effects")), leaseMs: LEASE_MS });
  const order = { orderId: "o988", amountCents: 1200 };

  // Restarted immediately: the dead run's claim is still inside its lease.
  const tooSoon = await charge(order);
  expect(tooSoon.reason).toBe("in_flight");

  await new Promise((r) => setTimeout(r, LEASE_MS + 50));
  const recovered = await charge(order);
  expect(recovered).toMatchObject({ ok: true, reason: "reconciled", executions: 0 });
  expect(stripe.countCharges("o988")).toBe(1);

  const later = await charge(order);
  expect(later.reason).toBe("cached");
}, 20_000);

it("file store: concurrent claims from many callers produce exactly one winner", async () => {
  const store = createFileStore(mkdtempSync(join(tmpdir(), "verified-tool-fs-")));
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.claim("k", { state: "claimed", owner: `o${i}`, claimedAt: Date.now() }))
  );
  expect(results.filter((r) => r === null)).toHaveLength(1);
  const winner = await store.get("k");
  expect(results.every((r) => r === null || r.owner === winner?.owner)).toBe(true);
});
