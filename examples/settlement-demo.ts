// Charges that stay "pending" for a while, and one that is declined after
// the API call already returned 200.
import { describeOutcome } from "../src/index.js";
import { makeChargeTool } from "./charge-tool.js";
import { FakeStripe } from "./fake-stripe.js";

const stripe = new FakeStripe();
const charge = makeChargeTool(stripe, {
  trace: (e) => {
    if (e.type === "execute") console.log(`   execute #${e.execution}`);
    if (e.type === "verify") console.log(`   verify poll ${e.poll}: ${e.outcome}`);
  },
});

for (const [label, args] of [
  ["settles after 400ms", { orderId: "o1", amountCents: 5000, settleMs: 400 }],
  ["declined after 200ms", { orderId: "o2", amountCents: 9900, settleMs: 200, decline: true }],
  ["still pending after 10s", { orderId: "o3", amountCents: 700, settleMs: 10_000 }],
] as const) {
  console.log(`\n${label}`);
  const r = await charge(args);
  console.log(`   result: ${r.outcome} (${r.reason}), executions: ${r.executions}`);
  console.log(`   model sees: "${describeOutcome(r, "charge_card")}"`);
}
console.log();
