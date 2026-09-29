"""Run LIMBO episodes with every tool call going through verified-tool's MCP gateway.

Everything else is LIMBO's own: the sandbox world, fault injection, system
prompt, observation formatting, agent loop limits and grader. The sandbox runs
the "vanilla" policy; the gateway sits between the model and LIMBO's own MCP
server (limbo.mcp_proxy). Records are written in LIMBO's episode format, with
spec.policy = "vt_gateway" and `paired_episode_id` pointing at the published
episode with the same world, task, fault and model.

    python bench/limbo/run_gateway.py --limbo-root ../limbo-bench --model claude-opus-5.5 --limit 5
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import sys
import time
import traceback
from dataclasses import asdict, replace
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
GATEWAY_CLI = REPO / "dist" / "mcp-cli.js"
POLICY = HERE / "policy.json"
POLICY_LABEL = "vt_gateway"


def limbo_imports(root: str) -> None:
    sys.path.insert(0, str(Path(root).resolve()))


def to_observation(result: dict[str, Any]) -> dict[str, Any]:
    """Map a gateway reply back to a LIMBO observation: the server's JSON when present, plus any gateway note."""
    parsed: dict[str, Any] | None = None
    notes: list[str] = []
    for item in result.get("content", []):
        if item.get("type") != "text":
            continue
        text = item.get("text", "")
        try:
            value = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            value = None
        if parsed is None and isinstance(value, dict) and "ok" in value:
            parsed = value
        else:
            notes.append(text)
    obs = dict(parsed) if parsed is not None else {"ok": not result.get("isError", False)}
    if notes:
        # Same place LIMBO's own guard puts its messages ("reliability_guard"): inside the observation.
        obs["gateway_note"] = " ".join(notes)
    return obs


def run_gateway_episode(spec: Any, client: Any = None, stderr_path: str | None = None, limbo_root: str = ".",
                        paired_episode_id: str | None = None) -> dict[str, Any]:
    from limbo.agent import ScriptedModel
    from limbo.behavior import classify
    from limbo.llm import LLMClient, LLMError, ToolCall, Usage
    from limbo.policies import is_error, make_policy
    from limbo.prompts import NUDGE_MESSAGE, system_prompt
    from limbo.runtime import observation_text
    from limbo.sandbox_http import SandboxServer, SandboxSession

    from mcp_client import McpClient

    t_wall = time.time()
    sandbox_spec = replace(spec, policy="vanilla")
    session = SandboxSession(sandbox_spec)
    system = system_prompt(make_policy("vanilla", spec.episode_id).prompt_variant, spec.paraphrase)
    conv: list[dict[str, Any]] = [{"role": "user", "content": session.task.instruction}]
    agent_calls: list[dict[str, Any]] = []
    usage = Usage()
    llm_latency = 0.0
    n_turns = n_nudges = 0
    stop_reason, error = "max_tool_calls", None
    if client is None:
        client = LLMClient(spec.model, reasoning_effort=spec.reasoning_effort)

    with SandboxServer(session) as srv:
        env = {**os.environ, "LIMBO_PORT": str(srv.port), "LIMBO_TOKEN": srv.token,
               "PYTHONPATH": str(Path(limbo_root).resolve())}
        cmd = ["node", str(GATEWAY_CLI), "--config", str(POLICY), "--", sys.executable, "-m", "limbo.mcp_proxy"]
        mcp = McpClient(cmd, env, cwd=str(Path(limbo_root).resolve()), stderr_path=stderr_path)
        try:
            schemas = [{"name": t["name"], "description": t.get("description", ""), "parameters": t["inputSchema"]}
                       for t in mcp.list_tools()]
            while len(agent_calls) < spec.max_tool_calls:
                n_turns += 1
                if isinstance(client, ScriptedModel):
                    calls = client.fn(conv)
                    text, replay = "", []
                    tcs = [ToolCall(c.get("id", f"s{n_turns}_{j}"), c["name"], json.dumps(c.get("args", {})))
                           for j, c in enumerate(calls)]
                else:
                    turn = client.complete(system, conv, schemas)
                    usage.add(turn.usage)
                    llm_latency += turn.latency_s
                    text, tcs, replay = turn.text, turn.tool_calls, turn.replay_items
                conv.append({"role": "assistant", "content": text,
                             "tool_calls": [{"id": c.id, "name": c.name, "arguments": c.arguments} for c in tcs],
                             "replay_items": replay})
                if not tcs:
                    n_nudges += 1
                    if n_nudges > 2:
                        stop_reason = "no_tool_calls"
                        break
                    conv.append({"role": "user", "content": NUDGE_MESSAGE})
                    continue
                for c in tcs:
                    args, perr = c.parsed_arguments()
                    if perr is not None:
                        obs = {"ok": False, "error": {"type": "invalid_arguments", "message": perr}}
                        args = {"_raw": c.arguments}
                    else:
                        obs = to_observation(mcp.call(c.name, args))
                    err = obs.get("error") or {}
                    agent_calls.append({"i": len(agent_calls), "turn": n_turns, "name": c.name, "args": args,
                                        "ok": bool(obs.get("ok")), "error_type": err.get("type"),
                                        "status": err.get("status"), "guard": obs.get("gateway_note"),
                                        "t": session.world.clock})
                    conv.append({"role": "tool", "tool_call_id": c.id, "name": c.name, "content": observation_text(obs)})
                    if session.rt.finished is not None or len(agent_calls) >= spec.max_tool_calls:
                        break
                if session.rt.finished is not None:
                    stop_reason = "finish"
                    break
        except LLMError as exc:
            error, stop_reason = f"LLMError: {exc}", "llm_error"
        except Exception as exc:  # keep the batch alive; the record is marked invalid
            error, stop_reason = f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=5)}", "harness_error"
        finally:
            mcp.close()
        rec = session.record(final=True)

    rec.update({
        "episode_id": spec.episode_id,
        "spec": asdict(spec),
        "paired_episode_id": paired_episode_id,
        # Behaviour is classified from what the agent asked for, not only what reached the sandbox.
        "behavior": classify(agent_calls, session.focal, session.tools, spec.mode),
        "agent_calls": agent_calls,
        "sandbox_calls": rec.pop("agent_calls"),
        "n_agent_calls": len(agent_calls),
        "stop_reason": stop_reason,
        "error": error,
        "n_turns": n_turns,
        "usage": usage.as_dict(),
        "llm_latency_s": round(llm_latency, 2),
        "wall_s": round(time.time() - t_wall, 2),
        "assistant_texts": [t.get("content") for t in conv if t["role"] == "assistant" and t.get("content")],
        "conversation": [{k: v for k, v in t.items() if k != "replay_items"} for t in conv],
        "system_prompt": system,
        "protocol": getattr(client, "protocol", "scripted"),
    })
    return rec


def published_specs(limbo_root: str, experiment: str, model: str) -> list[tuple[Any, str]]:
    """The exact vanilla / native-contract episodes LIMBO published for this model, re-labelled for the
    gateway, each with the id of the published episode it pairs with."""
    from limbo.agent import EpisodeSpec

    path = Path(limbo_root) / "results" / experiment / "episodes.jsonl"
    latest: dict[str, dict[str, Any]] = {}
    for line in path.open():
        rec = json.loads(line)
        s = rec["spec"]
        if s.get("model") == model and s.get("policy") == "vanilla" and s.get("contract", "native") == "native":
            latest[rec["episode_id"]] = s  # the report keeps the latest record per episode
    pairs = []
    for paired_id, s in latest.items():
        spec = replace(EpisodeSpec(**s), policy=POLICY_LABEL, experiment=f"{experiment}_vt")
        pairs.append((spec, paired_id))
    return sorted(pairs, key=lambda p: (p[0].template, p[0].index, p[0].focal, p[0].mode, p[0].paraphrase, p[0].replicate))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limbo-root", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--from-experiment", default="e2", help="published experiment whose vanilla episodes to re-run")
    ap.add_argument("--limit", type=int, default=0, help="run only the first N episodes (0 = all)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--out", default="", help="default: <limbo-root>/results/<experiment>_vt/episodes.jsonl")
    args = ap.parse_args()

    limbo_imports(args.limbo_root)
    sys.path.insert(0, str(HERE))
    if not GATEWAY_CLI.exists():
        sys.exit(f"{GATEWAY_CLI} not found: run `npm run build` in {REPO} first")

    pairs = published_specs(args.limbo_root, args.from_experiment, args.model)
    if args.limit:
        pairs = pairs[: args.limit]
    out = Path(args.out or Path(args.limbo_root) / "results" / f"{args.from_experiment}_vt" / "episodes.jsonl")
    out.parent.mkdir(parents=True, exist_ok=True)
    done = {json.loads(l)["episode_id"] for l in out.open()} if out.exists() else set()
    todo = [p for p in pairs if p[0].episode_id not in done]
    print(f"{len(pairs)} episodes for {args.model}; {len(done)} already done; running {len(todo)}", flush=True)

    logs = out.parent / "gateway_logs"
    logs.mkdir(exist_ok=True)
    run: Callable[[tuple[Any, str]], dict[str, Any]] = lambda p: run_gateway_episode(
        p[0], stderr_path=str(logs / f"{p[0].episode_id}.log"), limbo_root=args.limbo_root, paired_episode_id=p[1])
    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool, out.open("a") as f:
        for i, rec in enumerate(pool.map(run, todo), 1):
            f.write(json.dumps(rec, default=str) + "\n")
            f.flush()
            g = rec["grade"]
            print(f"[{i}/{len(todo)}] {rec['spec']['template']}/{rec['spec']['focal']}/{rec['spec']['mode']}: "
                  f"TS={g['TS']} dup={g['dup_executed']} stop={rec['stop_reason']}", flush=True)


if __name__ == "__main__":
    main()
