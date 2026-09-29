"""Compare the gateway's episodes with LIMBO's published conditions, on exactly the same episodes.

Metrics and validity filtering come from LIMBO's own analysis module, so the numbers are
computed the way the paper computes them:
  dsr        an episode where a duplicate was executed at any point
  dup_left   a duplicate still live at the end
  EOS        task success with no duplicate ever executed
  overclaim  finished as "completed" although the task failed or a duplicate remains

    python bench/limbo/compare.py --limbo-root ../limbo-bench --model claude-opus-5.5
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

CELL = ["template", "index", "focal", "mode", "paraphrase", "replicate"]
METRICS = ["dsr", "dup_left", "EOS", "TS", "overclaim", "escalations"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limbo-root", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--experiment", default="e2")
    args = ap.parse_args()

    root = Path(args.limbo_root).resolve()
    sys.path.insert(0, str(root))
    import os

    os.chdir(root)  # limbo.analysis reads results/ relative to the repo
    from limbo import analysis as A

    df = A.valid(A.load([args.experiment, f"{args.experiment}k", f"{args.experiment}_vt"]))
    df = df[df["model"] == args.model].copy()
    df["dsr"] = df["dup_exec"] > 0
    df["dup_left"] = df["dup_live"] > 0

    conditions = {
        "vanilla (published)": (df["policy"] == "vanilla") & (df["contract_variant"] == "native"),
        "LIMBO guard (published)": (df["policy"] == "guard") & (df["contract_variant"] == "native"),
        "verified-tool gateway": df["policy"] == "vt_gateway",
        "vanilla + keys_everywhere (published)": (df["policy"] == "vanilla") & (df["contract_variant"] == "keys_everywhere"),
    }
    ours = df[conditions["verified-tool gateway"]]
    if ours.empty:
        sys.exit(f"no gateway episodes for {args.model}; run run_gateway.py first")
    cells = set(map(tuple, ours[CELL].itertuples(index=False)))
    df = df[[tuple(r) in cells for r in df[CELL].itertuples(index=False)]]

    print(f"\n{args.model}: {len(cells)} episodes (same world, task, fault and prompt in every row)\n")
    print(f"| condition | n | {' | '.join(METRICS)} |")
    print(f"|---|---|{'---|' * len(METRICS)}")
    for name, mask in conditions.items():
        d = df[mask.reindex(df.index, fill_value=False)]
        if d.empty:
            continue
        vals = [f"{d[m].astype(float).mean():.1%}" if m != "escalations" else f"{d[m].mean():.2f}" for m in METRICS]
        print(f"| {name} | {len(d)} | {' | '.join(vals)} |")

    print("\nDuplicate rate (dsr) by fault mode:\n")
    modes = sorted(df["mode"].unique())
    print(f"| condition | {' | '.join(modes)} |")
    print(f"|---|{'---|' * len(modes)}")
    for name, mask in conditions.items():
        d = df[mask.reindex(df.index, fill_value=False)]
        if d.empty:
            continue
        row = [f"{d[d['mode'] == m]['dsr'].mean():.0%} ({(d['mode'] == m).sum()})" for m in modes]
        print(f"| {name} | {' | '.join(row)} |")


if __name__ == "__main__":
    main()
