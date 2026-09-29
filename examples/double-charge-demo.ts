// The scenario reported in langchain-ai/langgraph#8464: the charge goes
// through, the response is lost to a timeout, the framework retries, and the
// customer is charged twice while the agent reports success.
import { describeOutcome } from "../src/index.js";
import { makeChargeTool } from "./charge-tool.js";
import { APIConnectionError, FakeStripe } from "./fake-stripe.js";

const order = { orderId: "o988", amountCents: 1200 };

console.log("\n1) Naive tool with retry-on-error (what a default retry policy does)");
{
  const stripe = new FakeStripe();
  stripe.faults = ["lost_response"];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await stripe.createCharge(order);
      console.log(`   attempt ${attempt}: ok`);
      break;
    } catch (e) {
      if (!(e instanceof APIConnectionError)) throw e;
      console.log(`   attempt ${attempt}: ${e.message} -> retrying`);
    }
  }
  console.log(`   agent says: "Charged £12.00 successfully."`);
  console.log(`   charges in Stripe: ${stripe.countCharges("o988")}   <- customer double charged`);
}

console.log("\n2) verified-tool with reconcile()");
{
  const stripe = new FakeStripe();
  stripe.faults = ["lost_response"];
  const charge = makeChargeTool(stripe, {
    trace: (e) => {
      if (e.type === "execute") console.log(`   execute #${e.execution}`);
      if (e.type === "error") console.log(`   error (${e.errorClass}): not retrying blindly, checking Stripe instead`);
      if (e.type === "reconcile") console.log(`   reconcile poll ${e.poll}: ${e.outcome}`);
    },
  });
  const r = await charge(order);
  console.log(`   result: ${r.outcome} (${r.reason}), executions: ${r.executions}`);
  console.log(`   model sees: "${describeOutcome(r, "charge_card")}"`);
  console.log(`   charges in Stripe: ${stripe.countCharges("o988")}`);
}

console.log("\n3) verified-tool with no way to check (no reconcile)");
{
  const stripe = new FakeStripe();
  stripe.faults = ["lost_response"];
  const charge = makeChargeTool(stripe, {
    reconcile: undefined,
    onEscalate: (ctx) => console.log(`   escalated to a person: ${ctx.toolName} ${JSON.stringify(ctx.args)}`),
  });
  const r = await charge(order);
  console.log(`   result: ${r.outcome} (${r.reason}), executions: ${r.executions}`);
  console.log(`   model sees: "${describeOutcome(r, "charge_card")}"`);
  console.log(`   charges in Stripe: ${stripe.countCharges("o988")}`);
}
console.log();
