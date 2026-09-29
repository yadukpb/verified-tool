"""Checks the gateway harness against LIMBO's own in-process loop, with scripted agents (no model, no API).

    LIMBO_ROOT=../limbo-bench python bench/limbo/test_harness.py
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIMBO_ROOT = os.environ.get("LIMBO_ROOT", str(HERE.parent.parent.parent / "limbo-bench"))
sys.path.insert(0, str(Path(LIMBO_ROOT).resolve()))
sys.path.insert(0, str(HERE))

from limbo.agent import EpisodeSpec, ScriptedModel, run_episode  # noqa: E402
from limbo.tasks import make_task  # noqa: E402
from run_gateway import POLICY_LABEL, run_gateway_episode  # noqa: E402

TEMPLATE, FOCAL = "incident_open", "mail"


class GenAgent:
    """Same adapter LIMBO's tests use: a generator of tool-call batches fed the observations."""

    def __init__(self, gen_fn):
        self.gen = gen_fn()
        self.started = False

    def __call__(self, conv):
        last = max((i for i, t in enumerate(conv) if t["role"] == "assistant"), default=-1)
        obs = [json.loads(t["content"]) for t in conv[last + 1:] if t["role"] == "tool"]
        try:
            calls = self.gen.send(obs if self.started else None)
            self.started = True
        except StopIteration:
            return [{"name": "finish", "args": {"status": "completed", "summary": "done"}}]
        return calls


def mail_args():
    task = make_task(TEMPLATE, 0)
    mail = [t for t in task.targets if t.kind == "mail"][0]
    return {"to": ["oncall@acme.example"], "subject": f"Incident opened for {mail.match['tokens'][0]}", "body": "b"}


def blind_retry():
    args = mail_args()
    obs = yield [{"name": "mail_send", "args": args}]
    if not obs[0]["ok"]:
        obs = yield [{"name": "mail_send", "args": args}]
    yield [{"name": "finish", "args": {"status": "completed", "summary": "ok"}}]


def both(mode: str):
    spec = EpisodeSpec(template=TEMPLATE, index=0, focal=FOCAL, mode=mode, model="scripted", experiment="harness_test")
    vanilla = run_episode(spec, ScriptedModel(GenAgent(blind_retry)))
    gateway = run_gateway_episode(spec.__class__(**{**spec.__dict__, "policy": POLICY_LABEL}),
                                  ScriptedModel(GenAgent(blind_retry)), limbo_root=LIMBO_ROOT)
    for rec in (vanilla, gateway):
        assert rec["error"] is None, rec["error"]
    return vanilla, gateway


def sends(rec):
    return sum(1 for e in rec["events"] if e["name"] == "mail_send" and e.get("committed"))


class TestGatewayHarness(unittest.TestCase):
    def test_no_fault_grades_identically(self):
        vanilla, gateway = both("none")
        self.assertEqual(vanilla["grade"], gateway["grade"])
        self.assertEqual(vanilla["n_executions"], gateway["n_executions"])

    def test_timeout_after_commit_blind_retry(self):
        vanilla, gateway = both("timeout_post")
        self.assertGreater(vanilla["grade"]["dup_executed"], 0, "LIMBO baseline should duplicate")
        self.assertEqual(gateway["grade"]["dup_executed"], 0)
        self.assertIn("Do not retry it", gateway["agent_calls"][1]["guard"])
        self.assertEqual(len(gateway["sandbox_calls"]), 2, "the blocked retry never reached the service (mail + finish)")

    def test_503_is_not_blocked(self):
        vanilla, gateway = both("http503_transient")
        self.assertEqual(vanilla["grade"]["TS"], gateway["grade"]["TS"])
        self.assertEqual(gateway["grade"]["dup_executed"], 0)
        self.assertEqual(gateway["agent_calls"][1]["ok"], True, "the retry after a 503 went through")


if __name__ == "__main__":
    unittest.main(verbosity=2)
