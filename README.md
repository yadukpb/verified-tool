# verified-tool

**Stop your AI agent from repeating side effects (a second charge, a duplicate ticket, the same email twice) or claiming success it can't confirm.**

A small TypeScript wrapper for any agent tool that changes something outside your process. It is framework-agnostic and has no runtime dependencies. After a request may have reached the outside world, it learns more only by *reading* the outside world, never by blindly doing the action again.

```bash
npm install verified-tool
```

To run the demos:

```bash
git clone https://github.com/yadukpb/verified-tool && cd verified-tool && npm install
npm run demo          # payment: lost response → naive retry double-charges; this doesn't
npm run demo:issue    # ticket: no idempotency key, found again by a marker in its body
npm run demo:email    # email: nothing to check, blocked until the delivery webhook settles it
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

Payments are the example because the evidence is a real double charge, but nothing here is Stripe-specific. The same thread's other reproduction was a GitHub issue created twice through MCP.

## Three kinds of side effect

What you can do after a lost response depends on what the other system lets you ask. There are three cases. Each has a built-in recipe, so you configure it instead of writing it, and a runnable example:

| The system… | Examples | Recipe | Example |
|---|---|---|---|
| **accepts an idempotency key** | Stripe, Adyen, many modern payment and banking APIs | `downstreamIdempotent: true` forwards `ctx.effectKey` as the key, so retrying after a timeout is safe. `statusCheck()` maps the object's status to verified/failed/pending. | [`charge-tool.ts`](examples/charge-tool.ts) |
| **has no idempotency key, but lets you list what exists** | GitHub/Jira issues, Slack messages, calendar events, your own database | `markerRecipe()` writes the effect key *into* what you create (a hidden marker, a unique column), and its `reconcile` lists recent items to find it. | [`issue-tool.ts`](examples/issue-tool.ts) |
| **can't be asked at all, only reports back later** | Email, SMS, push, outbound webhooks | No `reconcile()`, since there's no honest one. A lost response ends `unknown` and stays blocked. `settleOnEvent()` turns the provider's delivered/bounced webhook into a settled effect. | [`email-tool.ts`](examples/email-tool.ts) |

The third row is the one most wrappers get wrong. They either retry (duplicate email) or report success (the agent says "sent" when it doesn't know). Here, the model is told the result is pending, a person is paged, and the webhook settles it:

```
send_email → POST /mail/send timed out
result: unknown (ambiguous), escalated
model sees: "It is not known whether send_email took effect. Do not retry it…"
model tries again anyway: unknown, executions: 0          ← no second email
...provider webhook arrives: delivered → resolveEffect(store, key, "verified")
next call: cached, executions: 0
```

The second row has a trap, which `npm run demo:issue` shows. If `reconcile()` uses a search API, it can return "not found" for an issue created a second ago, because search indexes lag. The wrapper then treats absence as proven and creates a duplicate. List the repo directly, or query your own database. An empty result from an eventually consistent index is not proof.

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
import { defineTool, statusCheck, createPostgresStore } from "verified-tool";

const chargeCard = defineTool(
  // ctx.effectKey is forwarded as Stripe's Idempotency-Key, so Stripe dedupes retries too
  (args: { orderId: string; amountCents: number }, ctx) =>
    stripe.paymentIntents.create(
      { amount: args.amountCents, currency: "gbp", metadata: { order_id: args.orderId } },
      { idempotencyKey: ctx.effectKey }
    ),
  {
    name: "charge_card",
    effectKey: (args) => `charge:${args.orderId}`,        // business identity, not tool_call_id
    downstreamIdempotent: true,                             // Stripe honors the key, so a retry after a timeout is safe
    classifyError: (e) => (e instanceof Stripe.errors.StripeRateLimitError ? "not_executed" : "ambiguous"),
    verify: statusCheck((pi) => stripe.paymentIntents.retrieve(pi.id), (pi) => pi.status, {
      verified: ["succeeded"],
      failed: ["canceled", "requires_payment_method"],
    }),
    authorize: async ({ args }) => budgets.canCharge(args.orderId),  // re-checked on every real execution
    store: createPostgresStore(pool),                       // see "Stores" below
    onEscalate: (ctx) => pageOnCall(ctx),
  }
);
```

For a system without idempotency keys, add a `reconcile()` that looks the effect up without the lost response. See [`markerRecipe`](examples/issue-tool.ts).

### Giving the result to the model

What the model reads decides whether it retries or tells the user something false. `describeOutcome()` turns a result into explicit instructions:

| reason | the model reads |
|---|---|
| `verified` | charge_card succeeded and the result was confirmed. |
| `reconciled` | charge_card succeeded. The first response was lost, but the result was confirmed by checking the system directly. Do not repeat it. |
| `cached` | charge_card had already been completed earlier, so it was not repeated. |
| `in_flight` | charge_card for this item is already in progress. Do not call it again. |
| `ambiguous` | It is not known whether charge_card took effect. Do not retry it, and do not tell the user it succeeded or failed. A person has been asked to confirm… |

In any framework where a tool is an async function, return `describeOutcome(await chargeCard(args), "charge_card")` from it. That covers the OpenAI Agents SDK, LangGraph.js, Mastra, and a hand-rolled loop on the Claude API.

### Vercel AI SDK

`withVerification` wraps an existing `tool({...})`. It keeps the description, schema, approval settings, and so on, and the model receives `{ outcome, reason, message, result }`:

```ts
import { tool } from "ai";
import { withVerification } from "verified-tool/ai-sdk";

export const chargeCard = withVerification(
  tool({
    description: "Charge the customer's card for an order",
    inputSchema: z.object({ orderId: z.string(), amountCents: z.number().int() }),
    execute: (input, { abortSignal }) => stripe.paymentIntents.create(/* … */),
  }),
  { name: "charge_card", effectKey: (input) => `charge:${input.orderId}`, downstreamIdempotent: true, store }
);
```

[`test/ai-sdk.test.ts`](test/ai-sdk.test.ts) runs this inside a real `generateText` loop. The model re-sends the charge after a lost response, as the models in LangGraph #8464 did. A plain tool charges twice; the wrapped one charges once and tells the model not to repeat it.

## MCP: protect any server without changing it

`verified-tool-mcp` sits between an MCP client (Claude Desktop, Claude Code, Cursor, your agent) and any MCP server, and protects the server's write tools. The server doesn't need to change:

```json
{
  "mcpServers": {
    "tickets": {
      "command": "npx",
      "args": ["-y", "-p", "verified-tool", "-p", "@modelcontextprotocol/sdk",
               "verified-tool-mcp", "--config", "/path/to/policy.json",
               "--", "node", "/path/to/your-mcp-server.js"]
    }
  }
}
```

With no config, it reads each tool's MCP annotations:

| Tool annotation | What the proxy does |
|---|---|
| `readOnlyHint: true` | Passes it straight through. |
| `idempotentHint: true` | Retries once after a timeout, since repeating is harmless. |
| anything else (a write) | Runs an identical call once per session. After a timeout or error, identical re-sends are blocked, and the agent is told *"It is not known whether create_issue took effect. Do not retry it…"* A call with different arguments is a new effect. |

A policy file adds recovery for specific tools. This one tells the proxy to write a hidden marker into the issue body and, after a timeout, look for it with the server's own `list_issues` tool:

```json
{
  "timeoutMs": 30000,
  "tools": {
    "create_issue": {
      "effectKey": ["repo", "title"],
      "marker": "body",
      "reconcile": { "tool": "list_issues", "args": { "repo": "{repo}", "state": "open" } }
    },
    "post_comment": { "errorResults": "failed" },
    "get_status": "passthrough"
  }
}
```

[`test/mcp.test.ts`](test/mcp.test.ts) covers each case against a fake GitHub-style MCP server, including one test that runs the actual CLI over stdio against a real server process. To embed the proxy in your own code instead, use `createVerifiedMcpProxy(upstreamClient, options)` from `verified-tool/mcp`.

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
- `createPostgresStore(pool)` and `createRedisStore(eval)` are for multiple instances. Both take the client you already have; the package still has no dependencies.

```ts
import { createPostgresStore, createRedisStore } from "verified-tool";

const pgStore = createPostgresStore(pool);           // any client with pg's query(text, params)
await pgStore.migrate();                             // or copy the CREATE TABLE into your migrations

const redisStore = createRedisStore((script, keys, args) =>
  redis.eval(script, keys.length, ...keys, ...args)  // ioredis; node-redis and Upstash adapters are in the docs
);
```

Both are tested against real Postgres 16 and Redis 7, including a test where 8 separate processes fire the same effect at the same instant (it happens once), and one where an instance is SIGKILLed mid-effect while 7 others race to recover it (one reconciles, none re-execute). Run them with `docker compose up -d && npm run test:db`.

- For anything else, implement the four-method `EffectStore` interface: an atomic insert-if-absent, plus compare-and-swap replace/delete on the owner token.

The owner renews its lease before every execution and every verify/reconcile poll. A claim left unrenewed for `leaseMs` (default 30s) is presumed to belong to a crashed run and gets reconciled. So `leaseMs` only has to outlast **one** execution of your tool or one poll, not the whole call.

### Settling from outside the call

After an `unknown` outcome, whoever finds out records the answer. That can be a person who checked by hand, or a webhook handler (see [`settleFromWebhooks`](examples/email-tool.ts)). `resolveEffect()` takes ownership of the record, so a call still running for that key can't overwrite it.

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
npm test            # unit, AI SDK, MCP and crash tests; the Postgres/Redis tests skip without a database
npm run test:db     # all 84, against real Postgres and Redis (docker compose up -d first)
npm run typecheck
npm run build
```

MIT
