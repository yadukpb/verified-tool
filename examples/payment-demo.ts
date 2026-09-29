import { defineTool } from "../src/index.js";
import type { TraceEvent } from "../src/types.js";
import { dispatchPayment, getPaymentStatus, sleep, type PaymentArgs } from "./payment-gateway.js";

function log(line: string) {
  console.log(line);
}

function traceLine(e: TraceEvent<unknown, unknown>) {
  if (e.type === "call_start") log(`  · attempt ${e.attempt}: dispatching…`);
  if (e.type === "verify_result") log(`  · attempt ${e.attempt}: verify() → ${e.outcome}`);
  if (e.type === "retry") log(`  · retrying (reason: ${e.reason})`);
  if (e.type === "escalate") log(`  · ESCALATED to human review (outcome: ${e.outcome})`);
  if (e.type === "settled") log(`  · settled: ${e.outcome} after ${e.attempt} attempt(s)`);
}

// --- The naive version: what most agent tool wrappers do today ------------
async function naiveSendPayment(args: PaymentArgs) {
  const { transactionId } = await dispatchPayment(args);
  return { success: true, transactionId }; // <-- lies the instant this returns
}

// --- The verified version ---------------------------------------------------
const sendPayment = defineTool(dispatchPayment, {
  name: "sendPayment",
  idempotencyKey: (args) => args.idempotencyKey,
  maxRetries: 3,
  policy: { unknown: "retry", failed: "throw" },
  trace: traceLine,
  verify: async (result) => {
    await sleep(400); // a real poll interval, not an instant re-check
    const status = await getPaymentStatus(result.transactionId);
    if (status === "succeeded") return "verified";
    if (status === "declined") return "failed";
    return "unknown"; // still pending — we honestly don't know yet
  },
  onEscalate: async (ctx) => {
    log(`  · [human-in-the-loop] would page an approver here for ${ctx.tool}(${JSON.stringify(ctx.args)})`);
  },
});

async function main() {
  log("\n=== 1. Naive wrapper: fast-settling payment ===");
  const naiveResult = await naiveSendPayment({
    orderId: "order-1",
    amountCents: 5000,
    settleAfterMs: 100,
    willDecline: false,
    idempotencyKey: "order-1",
  });
  log(`  naive result: ${JSON.stringify(naiveResult)}  (reported success immediately — happens to be right this time)`);

  log("\n=== 2. Naive wrapper: payment that will actually be DECLINED ===");
  const naiveDeclined = await naiveSendPayment({
    orderId: "order-2",
    amountCents: 12000,
    settleAfterMs: 300,
    willDecline: true,
    idempotencyKey: "order-2",
  });
  log(`  naive result: ${JSON.stringify(naiveDeclined)}  (reported "success: true" — this is FALSE, the charge is about to be declined)`);
  await sleep(500);
  log(`  ground truth a moment later: the transaction actually declined. The agent already told the user it worked.`);

  log("\n=== 3. Verified wrapper: fast-settling payment ===");
  const r1 = await sendPayment({
    orderId: "order-3",
    amountCents: 5000,
    settleAfterMs: 100,
    willDecline: false,
    idempotencyKey: "order-3",
  });
  log(`  final: ${JSON.stringify(r1)}`);

  log("\n=== 4. Verified wrapper: slow-settling payment (genuinely 'unknown' at first) ===");
  const r2 = await sendPayment({
    orderId: "order-4",
    amountCents: 8000,
    settleAfterMs: 1200,
    willDecline: false,
    idempotencyKey: "order-4",
  });
  log(`  final: ${JSON.stringify(r2)}`);

  log("\n=== 5. Verified wrapper: payment that will be DECLINED ===");
  try {
    await sendPayment({
      orderId: "order-5",
      amountCents: 12000,
      settleAfterMs: 300,
      willDecline: true,
      idempotencyKey: "order-5",
    });
  } catch (err) {
    log(`  final: threw ${(err as Error).name} — the agent never got told this succeeded.`);
  }

  log("\n=== 6. Idempotency: calling sendPayment again with the SAME key ===");
  const r3 = await sendPayment({
    orderId: "order-3",
    amountCents: 5000,
    settleAfterMs: 100,
    willDecline: false,
    idempotencyKey: "order-3", // same key as case 3
  });
  log(`  final: ${JSON.stringify(r3)}  (attempts: 0 — served from the idempotency cache, no duplicate charge)`);
}

main();
