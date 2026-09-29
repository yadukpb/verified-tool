// A support agent emails a refund confirmation. The provider has no
// "did this send?" API, only delivery webhooks.
import { createMemoryStore, describeOutcome } from "../src/index.js";
import { makeEmailTool, settleFromWebhooks } from "./email-tool.js";
import { FakeMailer, MailerTimeoutError } from "./fake-mailer.js";

const email = { refId: "order-7", to: "anil@example.com", subject: "Your refund", body: "£12.00 is on its way." };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("\n1) Naive tool with retry-on-error");
{
  const mailer = new FakeMailer();
  mailer.faults = ["lost_response"];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await mailer.send({ ...email, metadata: {} });
      console.log(`   attempt ${attempt}: sent`);
      break;
    } catch (e) {
      if (!(e instanceof MailerTimeoutError)) throw e;
      console.log(`   attempt ${attempt}: ${e.message} -> retrying`);
    }
  }
  console.log(`   emails Anil received: ${mailer.count(email.to, email.subject)}   <- duplicate`);
}

console.log("\n2) verified-tool: no reconcile (there's nothing to ask), settled by the delivery webhook");
{
  const mailer = new FakeMailer(400);
  mailer.faults = ["lost_response"];
  const store = createMemoryStore();
  settleFromWebhooks(mailer, store);
  const send = makeEmailTool(mailer, store, {
    onEscalate: (ctx) => console.log(`   escalated: ${ctx.toolName} to ${ctx.args.to}`),
  });

  const r = await send(email);
  console.log(`   result: ${r.outcome} (${r.reason})`);
  console.log(`   model sees: "${describeOutcome(r, "send_email")}"`);

  const retry = await send(email);
  console.log(`   model tries again anyway: ${retry.outcome} (${retry.reason}), executions: ${retry.executions}`);

  await sleep(500);
  console.log("   ...provider webhook arrives: delivered");
  const later = await send(email);
  console.log(`   next call: ${later.reason}, executions: ${later.executions}`);
  console.log(`   model sees: "${describeOutcome(later, "send_email")}"`);
  console.log(`   emails Anil received: ${mailer.count(email.to, email.subject)}\n`);
}
