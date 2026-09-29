# verified-tool on LIMBO

[LIMBO](https://github.com/jaxblack/limbo-bench) ([arXiv 2609.29095](https://arxiv.org/abs/2609.29095)) measures what agents do when a write fails but may already have taken effect. It found that the tool's contract explains most duplicate side effects, and that giving every write an idempotency key (`keys_everywhere`) cut duplicates from 28% to 4%. That condition changes the services themselves.

This directory asks the question a team can act on: **without changing the services, how much of that does an idempotency gateway in front of them recover?**

## What runs

Every tool call goes through the `verified-tool-mcp` gateway, sitting in front of LIMBO's own MCP server (`limbo.mcp_proxy`):

```
LIMBO agent loop ──MCP──▶ verified-tool-mcp ──MCP──▶ limbo.mcp_proxy ──HTTP──▶ LIMBO sandbox (vanilla policy)
```

Everything except the gateway is LIMBO's: the worlds, fault injection, system prompt, observation formatting, loop limits and grader. Each run replays **the exact episodes LIMBO published** for a model's `vanilla` condition in experiment E2 (same world seed, task, focal write, fault mode, paraphrase and replicate). So the comparison rows below come straight from the paper's released data, and only the gateway condition is new.

The gateway runs with [`policy.json`](policy.json): 4xx and 503 errors count as "not processed" (LIMBO's ground truth agrees for every such fault), and the general tools `wait`, `finish` and `escalate_to_human` pass through. No per-tool reconcile or marker is configured. This is the zero-configuration gateway.

## Run it

```bash
git clone https://github.com/jaxblack/limbo-bench ../limbo-bench
(cd ../limbo-bench && gh release download v1.0 -p 'limbo-episodes-v1.0.tar.gz' && tar xzf limbo-episodes-v1.0.tar.gz)
npm run build

python bench/limbo/test_harness.py                    # scripted checks against LIMBO's own loop, no API needed

export LIMBO_API_KEY=...                              # and LIMBO_BASE_URL for a non-OpenAI endpoint
python bench/limbo/run_gateway.py --limbo-root ../limbo-bench --model claude-opus-5.5 --limit 10   # try a few
python bench/limbo/run_gateway.py --limbo-root ../limbo-bench --model claude-opus-5.5               # all 217, resumable
python bench/limbo/compare.py --limbo-root ../limbo-bench --model claude-opus-5.5
```

The published E2 episodes for claude-opus-5.5 used a median of about 13.5k tokens each, so all 217 take roughly 3M tokens. gpt-6-sol and gemini-3.8-flash are also in E2, at about 8.7k and 11k tokens per episode.

## What this setup can and can't show

- **It can show** whether offering keys and blocking unverified repeats at a gateway reduces duplicates on services with no key support, and what it costs in task success, since a blocked retry the agent doesn't follow up on is a failed task.
- **`duplicate_delivery` happens below the gateway.** The transport delivers one request to the service twice. Only a key the *service* honors prevents that, so the gateway can't help there, and the published `keys_everywhere` row can.
- **Requests kept in flight don't come into play.** LIMBO simulates time: a timed-out request returns instantly and commits later on the simulated clock, so the gateway sees an ordinary timeout. The gateway's "still running" handling is exercised in its own test suite instead.
- **The gateway keys by the agent's key or by identical arguments.** LIMBO's `guard` recognizes the same intent from each tool's contract. A retry that changes the wording *and* carries no key is a new effect to the gateway.
- **One harness-level difference.** The model sees the tool list as served over MCP, which is what `limbo.mcp_proxy` gives every harness in LIMBO's E3. Tool results are re-rendered with LIMBO's own `observation_text`, so they match its in-process runs byte for byte.
