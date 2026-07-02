#!/usr/bin/env python3
"""Aggregate all Experiment 3 runs and compare the two topologies.

Scans results/exp3-<topo>-<timestamp>/wpr.json for both topologies, writes a
CSV per topology + a combined summary, and runs Welch's t-test (unequal
variance) + Mann-Whitney U on the per-run Work Preservation Rates.

Usage:
  python metrics/aggregate-exp3.py
"""
import json, glob, math, os, sys, csv
from pathlib import Path
from scipy import stats

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"

def load(topo):
    runs = []
    for wpr_path in sorted(glob.glob(str(RESULTS / f"exp3-{topo}-*/wpr.json"))):
        d = json.load(open(wpr_path))
        if d.get("workPreservationRate") is None:
            continue
        runs.append({
            "dir": d["dir"],
            "submitted": d["submitted"],
            "deliveries": d["deliveries_written"],
            "wpr": d["workPreservationRate"],
            "http_failed_pct": d.get("http_failed_pct"),
        })
    return runs

def describe(vals):
    n = len(vals)
    if n == 0: return (0, None, None)
    m = sum(vals)/n
    sd = math.sqrt(sum((x-m)**2 for x in vals)/(n-1)) if n>1 else 0.0
    return n, m, sd

def write_csv(topo, runs):
    out = RESULTS / f"exp3-trials-{topo}.csv"
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["dir","submitted","deliveries","wpr","http_failed_pct"])
        for r in runs:
            w.writerow([r["dir"], r["submitted"], r["deliveries"],
                        f"{r['wpr']:.4f}", r["http_failed_pct"]])
    print(f"wrote {out} ({len(runs)} rows)")
    return out

def main():
    chain = load("sync-chain")
    async_ = load("async-event")
    write_csv("sync-chain", chain)
    write_csv("async-event", async_)

    print()
    print(f"{'topology':18s} n  mean WPR    sd       runs")
    for label, runs in (("sync-chain", chain), ("async-event", async_)):
        n, m, sd = describe([r["wpr"] for r in runs])
        m_s  = f"{m*100:7.2f}%" if m  is not None else "   n/a"
        sd_s = f"{sd*100:6.3f}%" if sd is not None else "  n/a"
        wprs = ", ".join(f"{r['wpr']*100:.1f}" for r in runs)
        print(f"  {label:14s}  {n:>2}  {m_s}   {sd_s}    [{wprs}]")

    a = [r["wpr"] for r in chain]
    b = [r["wpr"] for r in async_]
    if len(a) >= 2 and len(b) >= 2:
        na, ma, sa = describe(a); nb, mb, sb = describe(b)
        diff = mb - ma
        se   = math.sqrt(sa**2/na + sb**2/nb)
        df   = (sa**2/na + sb**2/nb)**2 / ((sa**2/na)**2/(na-1) + (sb**2/nb)**2/(nb-1))
        t, p = stats.ttest_ind(a, b, equal_var=False)
        tcrit = stats.t.ppf(0.975, df)
        sp = math.sqrt(((na-1)*sa**2 + (nb-1)*sb**2) / (na+nb-2))
        d = (mb - ma)/sp if sp else float('nan')
        u, pmw = stats.mannwhitneyu(a, b, alternative="two-sided")
        print()
        print(f"mean difference (async-event - sync-chain) = {diff*100:+.2f} pp")
        print(f"Welch's t-test:  t={t:.3f}  df={df:.1f}  p={p:.2e}")
        print(f"95% CI for difference: [{(diff-tcrit*se)*100:+.2f}, {(diff+tcrit*se)*100:+.2f}] pp")
        print(f"Cohen's d = {d:.2f}")
        print(f"Mann-Whitney U: U={u:.1f}  p={pmw:.2e}")
        verdict = "significant" if p < 0.05 else "not significant"
        print(f"=> WPR difference is statistically {verdict} (alpha=0.05).")
    else:
        print("\n(need at least 2 runs per topology for t-test)")

if __name__ == "__main__":
    main()
