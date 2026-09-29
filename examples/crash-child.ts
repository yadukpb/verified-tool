// Charges a card, then gets SIGKILLed the instant the charge is written:
// after the external side effect, before the wrapper can record the result.
// Used by `npm run demo:crash` and by test/crash.test.ts.
import { join } from "node:path";
import { createFileStore } from "../src/file-store.js";
import { makeChargeTool } from "./charge-tool.js";
import { FakeStripe } from "./fake-stripe.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: crash-child.ts <workdir>");

const stripe = new FakeStripe(join(dir, "stripe.json"));
stripe.onCommit = () => process.kill(process.pid, "SIGKILL");

const charge = makeChargeTool(stripe, {
  store: createFileStore(join(dir, "effects")),
  leaseMs: Number(process.env.LEASE_MS ?? 500),
});

await charge({ orderId: "o988", amountCents: 1200 });
