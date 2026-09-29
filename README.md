# verified-tool

**Stop your AI agent from double-charging, double-sending, or claiming success it can't confirm.**

A small TypeScript wrapper for side-effecting agent tools (payments, emails, tickets, writes). It is framework-agnostic and has no runtime dependencies. After a request may have reached the outside world, it learns more only by *reading* the outside world, never by blindly doing the action again.

```bash
git clone https://github.com/yadukpb/verified-tool && cd verified-tool && npm install
npm run demo          # lost response → naive retry double-charges; this doesn't
npm run demo:crash    # kill -9 right after the charge, restart, recover with no second charge
```

**Try it in the browser:** [interactive demo](https://claude.ai/artifact/Gz7cqZxeq36ZoEfkhaVyBs)

## The failure this is built around

From [langchain-ai/langgraph#8464](https://github.com/langchain-ai/langgraph/issues/8464), reproduced against Stripe test mode:

```
agent:     charge_card(customer="Anil", order_id="o988", amount_gbp=12.0)
stripe:    PaymentIntent #1 succeeded
tool:      raises APIConnectionError (response lost)
langgraph: RetryPolicy re-runs the tools node
stripe:    PaymentIntent #2 succeeded, 1s later
agent:     "Charged 12.00 GBP to customer Anil for order o988 successfully."

expected: 1 charge    actual: 2 charges    agent's report: success
```

The reporter measured this across 5 runs per setup. The default retry policy double-charged 5/5 times. Turning off retries and letting the model handle the error also double-charged 5/5, because **the model re-sent the call itself**, checking first only once in 30 fault runs. Only an idempotency key derived from the business object (not the model's `tool_call_id`, which changes when the model re-plans) prevented it.

A timeout is not a failure. It means *we don't know*. The same thread identifies the rest of what a fix needs: a durable claim before executing, a `reconcile()` read of the external system before any retry, and a fresh authorization check before re-executing after recovery. This library implements those.

## How it decides what to do

```
call(args)
 ├─ effect key already settled?                 → return cached result, execute nothing
 ├─ someone else holds a live claim?            → "in_flight", execute nothing
 ├─ claim expired (a previous run crashed)?     → reconcile() first
 └─ authorize() → execute once
      ├─ returned      → verify() (polled while pending)   → verified | failed | unknown
      ├─ threw, "not_executed" (e.g. 429)  → safe to execute again (up to maxExecutions)
      └─ threw, "ambiguous" (e.g. timeout) → reconcile() → found it: verified
                                                          → proved absent: execute again
                                                          → can't tell: unknown, escalate
```

Every error defaults to **ambiguous**. You opt specific errors into "safe to retry"; you never have to remember to opt them out.

## Usage

```ts
import { defineTool, describeOutcome } from "verified-tool";

const chargeCard = defineTool(
  // ctx.effectKey is forwarded as Stripe's Idempotency-Key, so the provider dedupes too
  (args: { orderId: string; amountCents: number }, ctx) =>
    stripe.paymentIntents.create(
      { amount: args.amountCents, currency: "gbp", metadata: { order_id: args.orderId } },
      { idempotencyKey: ctx.effectKey }
    ),
  {
    name: "charge_card",
    effectKey: (args) => `charge:${args.orderId}`,        // business identity, not tool_call_id
    classifyError: (e) => (e instanceof Stripe.errors.StripeRateLimitError ? "not_executed" : "ambiguous"),
    verify: async (pi) => {
      const fresh = await stripe.paymentIntents.retrieve(pi.id);
      const outcome =
        fresh.status === "succeeded" ? "verified"
        : ["canceled", "requires_payment_method"].includes(fresh.status) ? "failed"
        : "unknown";
      return { outcome, result: fresh };
    },
    reconcile: async ({ args }) => {
      // look it up without the lost response
      const found = await findPaymentIntentByOrder(args.orderId);
      if (!found) return { outcome: "failed" };            // proved it never happened → safe to execute
      return { outcome: found.status === "succeeded" ? "verified" : "unknown", result: found };
    },
    authorize: async ({ args }) => budgets.canCharge(args.orderId),  // re-checked on every real execution
    store: myPostgresEffectStore,                           // see "Stores" below
    onEscalate: (ctx) => pageOnCall(ctx),
  }
);
```

### Giving the result to the model

What the model reads decides whether it retries or tells the user something false. `describeOutcome()` turns a result into explicit instructions:

| reason | the model reads |
|---|---|
| `verified` | charge_card succeeded and the result was confirmed. |
| `reconciled` | charge_card succeeded. The first response was lost, but the result was confirmed by checking the system directly. Do not repeat it. |
| `cached` | charge_card had already been completed earlier, so it was not repeated. |
| `in_flight` | charge_card for this item is already in progress. Do not call it again. |
| `ambiguous` | It is not known whether charge_card took effect. Do not retry it, and do not tell the user it succeeded or failed. A person has been asked to confirm… |

With the Vercel AI SDK:

```ts
import { tool } from "ai";

export const chargeCardTool = tool({
  description: "Charge the customer's card for an order",
  inputSchema: z.object({ orderId: z.string(), amountCents: z.number().int() }),
  execute: async (args) => describeOutcome(await chargeCard(args), "charge_card"),
});
```

The same pattern works in any framework where a tool is an async function returning a string: the OpenAI Agents SDK, LangGraph.js, Mastra, or a hand-rolled loop on the Claude API.

## Outcomes

Every call returns `{ ok, outcome, reason, result, executions, escalated, effectKey }`. `executions` is the number of times your function actually ran, which is the number to watch.

| outcome | reasons | meaning |
|---|---|---|
| `verified` | `verified`, `reconciled`, `cached`, `trusted` | It happened. `trusted` means no `verify()` was configured, so it was taken at face value. |
| `failed` | `failed`, `exhausted`, `denied` | It confirmably did not happen. The claim is released so a later call may try again. |
| `unknown` | `ambiguous`, `in_flight` | We don't know yet. The effect is marked **unresolved**, so nothing re-executes. The next call with the same key re-checks with `reconcile()` (without paging anyone again), or a person settles it with `resolveEffect()`. |

## Stores

The effect store holds claims and settled results by effect key. Each claim carries a random owner token. Taking over, settling, and releasing are compare-and-swap operations on that token, so when two callers race for an expired claim, exactly one wins. A run that lost its claim can't overwrite or release it.

- `createMemoryStore()` is the default. It's fine for a single process, but it can't recover a crash.
- `createFileStore(dir)` (from `verified-tool/file-store`, Node only) survives `kill -9` on one machine. It's what `npm run demo:crash` uses.
- For multiple instances, implement the four-method `EffectStore` interface. In Postgres, `claim` is `INSERT … ON CONFLICT DO NOTHING`, and `replace`/`release` are `UPDATE`/`DELETE … WHERE owner = $expected`. In Redis, `claim` is `SET NX`, and the other two are a small compare-and-set Lua script.

The owner renews its lease before every execution and every verify/reconcile poll. A claim left unrenewed for `leaseMs` (default 30s) is presumed to belong to a crashed run and gets reconciled. So `leaseMs` only has to outlast **one** execution of your tool or one poll, not the whole call.

### Settling by hand

After an `unknown` outcome escalates, the person who checks it records the answer:

```ts
import { resolveEffect } from "verified-tool";
await resolveEffect(store, "charge:o988", "verified", { id: "pi_123" }); // later calls return it as cached
await resolveEffect(store, "charge:o988", "failed");                     // clears it; a later call may execute
```

## What this does not do

- **It doesn't write your `verify()` or `reconcile()`.** They're specific to each tool. Some systems (fire-and-forget webhooks, legacy RPC with no read API) give you no way to check. Then the honest answer is `unknown`, and the library escalates rather than guessing.
- **It can't make a non-idempotent API idempotent.** The claim store stops *this wrapper* from re-executing. If the downstream doesn't honor an idempotency key, a request that was in flight when a process died can still have landed. That's exactly why recovery reconciles before acting.
- **It isn't durable execution.** It doesn't resume your agent's workflow after a crash. It makes each side effect safe to call again. Use [Temporal](https://temporal.io) or [Restate](https://restate.dev) for durable workflows. The two approaches compose.
- **It needs an honest `reconcile()`.** Returning `failed` from reconcile triggers another execution, so it must mean "proven absent", read from a source that sees its own writes. An eventually consistent search index (Stripe's `charges.search`, for one) can miss a charge made a second ago. Return `unknown` if the lookup might be lagging.
- **A single execution longer than `leaseMs` looks like a crash.** Another caller can then take over and reconcile while the first run is still inside your function. Size the lease above your tool's worst-case latency.
- **It doesn't cap how many times a run calls a tool.** Loop and budget limits are a separate concern.

## Prior art

| | verified-tool | Temporal / Restate | kiri-gate | reality-ontology-runtime | idempotency-key libs |
|---|---|---|---|---|---|
| Language | TypeScript | many | Python | Python | many |
| Reconcile before retrying an ambiguous error | yes | you write it in the activity | reversibility gate | yes | no |
| Claim + lease crash recovery | yes | yes (full workflow replay) | — | yes (event-sourced) | no |
| Three-state outcome given to the model | yes | no | — | — | no |
| Drop-in around one function | yes | no, adopt the runtime | yes | no | yes |

[kiri-gate](https://github.com/aryan597/kiri-gate) and [reality-ontology-runtime](https://github.com/leadingproblemsolver/reality-ontology-runtime) come from the authors of the reproductions in LangGraph #8464 and are worth reading. Before this, I couldn't find a TypeScript equivalent.

## Background reading

- [Characterizing False Success in LLM Agents](https://arxiv.org/abs/2606.09863) (arXiv 2606.09863)
- [Verified Tool Calls Improve LLM Agent Reliability Under Non-Atomic Failures](https://arxiv.org/abs/2608.02645) (arXiv 2608.02645)
- [langchain-ai/langgraph#8464](https://github.com/langchain-ai/langgraph/issues/8464): the discussion this design follows

## Development

```bash
npm test            # 28 tests: lost responses, SIGKILL crash recovery, claim races, lease renewal, throwing hooks
npm run typecheck
npm run build
```

MIT
