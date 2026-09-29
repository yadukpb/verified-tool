# verified-tool

**Stop your AI agent from believing a tool call succeeded when it didn't.**

A small TypeScript wrapper around any async tool function. It doesn't trust the return value — it makes you (optionally) confirm the side effect actually happened, and it's honest about the case where you can't tell yet.

```bash
npm install verified-tool
```

## The problem

Tool-calling agents report success the instant a call returns without an exception. In production that's wrong often enough to matter: the email API accepted the request but the message later bounced; the payment gateway returned `200` but the charge is still pending or gets declined seconds later; the write hit a replica that hasn't caught up yet. The agent tells the user "done" before reality has settled.

This is a named, current failure mode, not a hypothetical:

- ["From Confident Closing to Silent Failure: Characterizing False Success in LLM Agents"](https://arxiv.org/html/2606.09863) — agents that report task completion without confirming the underlying state actually changed.
- ["Verified Tool Calls Improve LLM Agent Reliability Under Non-Atomic Failures"](https://arxiv.org/pdf/2608.02645) — same problem, from the reliability-engineering side.
- [LangGraph issue #8464](https://github.com/langchain-ai/langgraph/issues/8464) — durable tool execution idempotency & retry, open and unresolved.
- [Vercel AI SDK issue #14649](https://github.com/vercel/ai/issues/14649) — a governance/verification hook, requested, unshipped.
- The [Claude Agent SDK docs](https://docs.claude.com) tell you to build this yourself — there's no built-in retry, idempotency, or outcome verification in `tool_runner`.

Nobody has shipped a small, framework-agnostic primitive for this. That's what this is.

## Quickstart

```ts
import { defineTool } from "verified-tool";

const sendPayment = defineTool(dispatchPayment, {
  name: "sendPayment",
  idempotencyKey: (args) => args.orderId,
  policy: { unknown: "retry", failed: "throw" },
  verify: async (result) => {
    const status = await getPaymentStatus(result.transactionId);
    if (status === "succeeded") return "verified";
    if (status === "declined") return "failed";
    return "unknown"; // still settling — we honestly don't know yet
  },
});

const outcome = await sendPayment({ orderId: "order-42", amountCents: 5000 });
// outcome.outcome is "verified" | "failed" | "unknown" — never a guess
```

## Why three states, not a boolean

A boolean `verify()` forces you to guess the instant the true state is ambiguous — which is exactly how "false success" happens in the first place. Most real integrations have a window where you genuinely don't know yet: a webhook hasn't fired, a replica hasn't caught up, a queue hasn't drained. `"unknown"` gives that window somewhere honest to go, instead of silently collapsing into `true`.

```
verified → proceed, tell the agent it worked
failed   → retry, then throw (or escalate) once retries are exhausted
unknown  → your call: retry / escalate to a human / proceed anyway
```

The default policy escalates on `unknown` rather than assuming success. That's a deliberate, conservative default — flip it with `policy: { unknown: "proceed" }` if your use case can tolerate optimism.

## Run the demo

```bash
git clone <this repo>
cd verified-tool
npm install
npm run demo
```

The demo simulates a payment gateway with **real async settlement lag** (not a fake coinflip) — a charge dispatches instantly but the ledger only reflects the true outcome after a delay, exactly like querying Stripe right after a charge. It runs the naive version first (which confidently reports success on a payment that's about to be declined) next to the verified version (which retries through the ambiguous window and correctly refuses to lie).

## API

```ts
defineTool(fn, {
  name: string,
  schema?: { parse(input: unknown): TResult },   // duck-typed to accept a Zod schema directly
  verify?: (result, args) => Promise<"verified" | "failed" | "unknown">,
  idempotencyKey?: (args) => string,
  idempotencyStore?: IdempotencyStore,            // defaults to an in-memory Map — swap in Redis/Postgres for anything that needs to survive a restart
  policy?: { unknown?: "escalate" | "retry" | "proceed", failed?: "retry" | "throw" | "escalate" },
  maxRetries?: number,                            // default 2
  onEscalate?: (ctx) => void | Promise<void>,
  trace?: (event) => void,                        // structured events for every attempt — pipe to whatever logging you already have
})
```

Returns `(args) => Promise<{ ok, outcome, result, attempts, escalated, idempotencyKey }>`.

## What this is not

- **Not durable execution.** It doesn't survive a process crash mid-call. For that, use [Restate](https://restate.dev) or [Temporal](https://temporal.io) — different, harder problem, already solved well by funded infra.
- **Not automatic verification.** `verify()` is yours to write. For webhook-only services with no read-back endpoint, the honest answer is `"unknown"` on essentially every call — that's not a bug, it's the library refusing to fake certainty it doesn't have. See [Limitations](#limitations).
- **Not an idempotency guarantee on its own.** The idempotency key only prevents duplicate side effects if the *downstream* system honors it (Stripe does; a lot of internal/legacy APIs don't). This library can't retrofit idempotency onto an API that doesn't support it.

## Limitations

Being direct about this rather than letting you find out the hard way:

1. **`verify()` is bespoke per tool, always.** This library gives you the type, the retry/escalation policy, and a place to put the check — it does not generate the check. For a real chunk of integrations (fire-and-forget webhooks, some legacy RPC) there is no independent way to confirm state, and `verify()` is honestly unwritable, not just hard.
2. **Idempotency needs a cooperative downstream.** If the API you're calling doesn't support an idempotency key itself, retries can still double-fire the underlying side effect even with this wrapper in front of it.
3. **This solves a different problem than durable execution frameworks.** If your primary risk is the process crashing mid-run, you want Restate/Temporal, not this.

## Prior art / how this differs

| | verified-tool | Temporal / Restate | idempotency-only libs | getmarrow.ai |
|---|---|---|---|---|
| Postcondition verification (3-state) | ✅ | ❌ | ❌ | binary `committed` proof |
| Idempotency keys | ✅ (bring your own store) | ✅ | ✅ | — |
| Survives process crash | ❌ | ✅ | ❌ | — |
| Drop-in on an existing function | ✅ | ❌ (adopt workflow model) | ✅ | ❌ (hosted governance layer) |
| Framework requirement | none | Temporal/Restate runtime | none | Marrow platform |

## License

MIT
