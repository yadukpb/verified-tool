// Kill -9 the process right after the charge commits, restart, and recover
// without charging again.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeOutcome } from "../src/index.js";
import { createFileStore } from "../src/file-store.js";
import { makeChargeTool } from "./charge-tool.js";
import { FakeStripe } from "./fake-stripe.js";

const LEASE_MS = 1000;
const dir = mkdtempSync(join(tmpdir(), "verified-tool-crash-"));
const child = fileURLToPath(new URL("./crash-child.ts", import.meta.url));

console.log("\nrun 1: charging order o988, process will be SIGKILLed right after Stripe records the charge");
const run = spawnSync(process.execPath, ["--import", "tsx", child, dir], {
  env: { ...process.env, LEASE_MS: String(LEASE_MS) },
});
console.log(`   process ended by: ${run.signal}`);

const stripe = new FakeStripe(join(dir, "stripe.json"));
console.log(`   charges in Stripe: ${stripe.countCharges("o988")}  (the charge landed; our process never learned that)`);

const charge = makeChargeTool(stripe, {
  store: createFileStore(join(dir, "effects")),
  leaseMs: LEASE_MS,
  trace: (e) => {
    if (e.type === "in_flight") console.log("   claim is still within its lease: refusing to act");
    if (e.type === "stale_claim") console.log("   found an expired claim from a dead run: checking Stripe before doing anything");
    if (e.type === "reconcile") console.log(`   reconcile poll ${e.poll}: ${e.outcome}`);
    if (e.type === "execute") console.log(`   execute #${e.execution}`);
  },
});
const order = { orderId: "o988", amountCents: 1200 };

console.log("\nrun 2: restarted immediately");
let r = await charge(order);
console.log(`   result: ${r.reason}`);

console.log(`\nrun 3: restarted after the ${LEASE_MS}ms lease`);
await new Promise((res) => setTimeout(res, LEASE_MS + 100));
r = await charge(order);
console.log(`   result: ${r.outcome} (${r.reason}), executions: ${r.executions}`);
console.log(`   model sees: "${describeOutcome(r, "charge_card")}"`);
console.log(`   charges in Stripe: ${stripe.countCharges("o988")}\n`);
