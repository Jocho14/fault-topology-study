#!/usr/bin/env python3
"""Compare two topologies' latency trials.

Welch's t-test (unequal variance) + Mann-Whitney U (nonparametric robustness
check) + effect size (mean difference, 95% CI, Cohen's d). Operates on the
per-run aggregate column (default avg_ms) from two trial CSVs.

Usage:
  ttest.py results/latency-trials-sync-chain.csv results/latency-trials-sync-orchestrator.csv [col]
  (col defaults to avg_ms; could be med_ms)
"""
import sys, csv, math
from scipy import stats

def load(path, col):
    with open(path) as f:
        rows = list(csv.DictReader(f))
    # drop any trial with failures (contaminated)
    vals = [float(r[col]) for r in rows if float(r.get("failed_pct", 0)) == 0]
    return vals

def describe(v):
    n = len(v); m = sum(v) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in v) / (n - 1)) if n > 1 else 0.0
    return n, m, sd

a_path, b_path = sys.argv[1], sys.argv[2]
# default to per-run MEDIAN: robust to latency's heavy tail (a single hung
# request can wreck a run's mean — see the trials data — but not its median)
col = sys.argv[3] if len(sys.argv) > 3 else "med_ms"
a, b = load(a_path, col), load(b_path, col)
na, ma, sa = describe(a); nb, mb, sb = describe(b)
a_name = a_path.split("latency-trials-")[-1].replace(".csv", "")
b_name = b_path.split("latency-trials-")[-1].replace(".csv", "")

print(f"column under test: {col}\n")
print(f"{a_name:24s} n={na:2d}  mean={ma:8.2f} ms  sd={sa:6.2f}")
print(f"{b_name:24s} n={nb:2d}  mean={mb:8.2f} ms  sd={sb:6.2f}")
diff = mb - ma
print(f"\nmean difference ({b_name} - {a_name}) = {diff:+.2f} ms")

# Welch's t-test
t, p = stats.ttest_ind(a, b, equal_var=False)
# Welch-Satterthwaite df
df = (sa**2/na + sb**2/nb)**2 / ((sa**2/na)**2/(na-1) + (sb**2/nb)**2/(nb-1))
# 95% CI on the difference
se = math.sqrt(sa**2/na + sb**2/nb)
tcrit = stats.t.ppf(0.975, df)
print(f"\nWelch's t-test:  t={t:.3f}  df={df:.1f}  p={p:.2e}")
print(f"95% CI for difference: [{diff - tcrit*se:+.2f}, {diff + tcrit*se:+.2f}] ms")

# Cohen's d (pooled sd)
sp = math.sqrt(((na-1)*sa**2 + (nb-1)*sb**2) / (na + nb - 2))
d = (mb - ma) / sp if sp else float("nan")
print(f"Cohen's d = {d:.2f}")

# Mann-Whitney U (nonparametric)
u, pmw = stats.mannwhitneyu(a, b, alternative="two-sided")
print(f"\nMann-Whitney U: U={u:.1f}  p={pmw:.2e}")

verdict = "significant" if p < 0.05 else "not significant"
print(f"\n=> difference is statistically {verdict} (alpha=0.05); "
      f"effect size {abs(diff):.0f} ms (~{abs(diff)/80:.1f} hop at 80ms/hop).")
