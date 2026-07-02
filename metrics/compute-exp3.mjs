#!/usr/bin/env node
// Compute Experiment 3's Work Preservation Rate (WPR) from one run directory.
//
//   node metrics/compute-exp3.mjs <results/exp3-<topo>-<ts>/>
//
// WPR = n_terminal_success / n_submitted
//   n_submitted          = k6 iterations.count (every order the client fired)
//   n_terminal_success   = delivery_db.deliveries row count after the post-run
//                          drain wait (each terminal-state order writes a row)
//
// Writes <dir>/wpr.json and prints a one-line summary.
import { readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node metrics/compute-exp3.mjs <results-dir>");
  process.exit(2);
}

const k6   = JSON.parse(readFileSync(join(dir, "k6.json"), "utf8"));
const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));

const submitted  = k6.metrics?.iterations?.count ?? 0;
const httpReqs   = k6.metrics?.http_reqs?.count ?? submitted;
const failedPct  = (k6.metrics?.http_req_failed?.value ?? 0) * 100;
const deliveries = meta.db_counts?.deliveries ?? 0;
const payments   = meta.db_counts?.payments ?? 0;

const wpr = submitted > 0 ? deliveries / submitted : null;

const out = {
  experiment: meta.experiment,
  topology: meta.topology,
  dir: basename(dir),
  submitted,
  http_requests: httpReqs,
  http_failed_pct: Math.round(failedPct * 100) / 100,
  payments_written: payments,
  deliveries_written: deliveries,
  workPreservationRate: wpr,
};
writeFileSync(join(dir, "wpr.json"), JSON.stringify(out, null, 2));

const pct = wpr != null ? (wpr * 100).toFixed(2) + "%" : "n/a";
console.log(
  `[${out.topology}]  submitted=${submitted}  delivered=${deliveries}  ` +
  `WPR=${pct}   (http_failed=${out.http_failed_pct}%, payments_written=${payments})`,
);
console.log(`wrote ${join(dir, "wpr.json")}`);
