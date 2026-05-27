#!/usr/bin/env python3
"""Two-panel per-service error-rate chart for Experiment 1.

Reads the raw NRQL TIMESERIES output (results/chart/{sync,async}_raw.json),
writes a CSV per panel, and renders results/chart/exp1_error_rates.png.

Run start (t=0) is the NRQL SINCE timestamp of each query; the chaos band is
read from the experiment timeline files.
"""
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

ROOT = Path(__file__).resolve().parent.parent
CHART = ROOT / "results" / "chart"

PANELS = [
    {
        "key": "sync",
        "title": "(a) Synchronous chain",
        "raw": CHART / "sync_raw.json",
        "since_ms": 1779789071036,
        "services": ["shop", "warehouse", "payment", "delivery"],
        "suffix": "-sync-chain",
    },
    {
        "key": "async",
        "title": "(b) Asynchronous event-driven",
        "raw": CHART / "async_raw.json",
        "since_ms": 1779788625177,
        "services": ["shop", "warehouse", "payment", "delivery"],
        "suffix": "-async-event",
    },
]

# Chaos band (seconds since run start), from the timeline files (both 45..135).
CHAOS_BAND = (45, 135)
COLORS = {"shop": "#1f77b4", "warehouse": "#ff7f0e",
          "payment": "#2ca02c", "delivery": "#d62728"}
# distinct line styles so overlapping lines (shop==warehouse at 100%, or all at
# 0 in the async panel) remain individually visible
STYLES = {"shop": "-", "warehouse": (0, (6, 3)),
          "payment": (0, (1, 2)), "delivery": (0, (3, 1, 1, 1))}


def load_series(panel):
    """Return {service: [(t_seconds, error_rate_or_None), ...]} sorted by time."""
    data = json.load(open(panel["raw"]))
    since = panel["since_ms"] / 1000.0
    series = {s: [] for s in panel["services"]}
    for row in data:
        app = row.get("appName") or row.get("facet", "")
        svc = app.replace(panel["suffix"], "")
        if svc not in series:
            continue
        t = row["beginTimeSeconds"] - since
        series[svc].append((t, row.get("error_rate")))
    for s in series:
        series[s].sort(key=lambda p: p[0])
    return series


def write_csv(panel, series):
    out = CHART / f"exp1_{panel['key']}_error_rates.csv"
    # union of all timestamps
    times = sorted({t for s in series.values() for t, _ in s})
    lookup = {svc: dict(pts) for svc, pts in series.items()}
    with open(out, "w") as f:
        f.write("t_seconds," + ",".join(panel["services"]) + "\n")
        for t in times:
            row = [f"{t:.0f}"]
            for svc in panel["services"]:
                v = lookup[svc].get(t)
                # 'nan' (not empty) so pgfplots can break the line at gaps
                row.append("nan" if v is None else f"{v:.1f}")
            f.write(",".join(row) + "\n")
    return out


fig, axes = plt.subplots(2, 1, figsize=(9, 7), sharex=True)
for ax, panel in zip(axes, PANELS):
    series = load_series(panel)
    csv = write_csv(panel, series)
    print("wrote", csv)
    for svc in panel["services"]:
        xs = [t for t, _ in series[svc]]
        # None -> NaN so the line breaks where the service had no transactions
        ys = [float("nan") if v is None else v for _, v in series[svc]]
        ax.plot(xs, ys, label=svc, color=COLORS[svc],
                linestyle=STYLES[svc], linewidth=1.8)
    ax.axvspan(*CHAOS_BAND, color="grey", alpha=0.15, zorder=0)
    ax.set_title(panel["title"], loc="left", fontsize=11)
    ax.set_ylabel("HTTP error rate (%)")
    ax.set_ylim(-5, 105)
    ax.set_xlim(0, max(t for s in series.values() for t, _ in s))
    ax.grid(True, alpha=0.3)
    ax.legend(loc="center right", fontsize=9, ncol=1)

axes[-1].set_xlabel("Time since start of run (s)")
# label the chaos band once
axes[0].text(sum(CHAOS_BAND) / 2, 50, "chaos", ha="center", va="center",
             color="grey", fontsize=9, rotation=0)

caption = ("Per-service error rates during Experiment 1 in the synchronous chain (a) "
           "and asynchronous event-driven (b) topologies. In the synchronous chain the "
           "failure of payment propagates upstream to warehouse and shop; in the "
           "asynchronous topology no propagation occurs.")
fig.text(0.5, 0.005, caption, ha="center", va="bottom", fontsize=8, wrap=True)
fig.tight_layout(rect=(0, 0.06, 1, 1))
out = CHART / "exp1_error_rates.png"
fig.savefig(out, dpi=160)
print("wrote", out)
