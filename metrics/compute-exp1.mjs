#!/usr/bin/env node
// Compute the thesis metrics from a timeline.json (produced by run-exp1.sh)
// + NRQL queries against New Relic. Generalized across experiments via the
// fields the runner writes into the timeline (experiment, topology,
// killService, entryApp).
//
// Usage: node metrics/compute-exp1.mjs <timeline.json>
// Writes results/<experiment>-<topology>-nr.json and prints a summary.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runNrql } from "./nrql.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tlPath = process.argv[2];
if (!tlPath) {
  console.error("usage: node metrics/compute-exp1.mjs <timeline.json>");
  process.exit(2);
}
const tl = JSON.parse(readFileSync(tlPath, "utf8"));
const TOPO = tl.topology;
const LABEL = tl.experiment || "exp1";
const KILL = tl.killService || "payment";
const ENTRY = tl.entryApp || `shop-${TOPO}`;
const win = (a, b) => `SINCE ${a} UNTIL ${b}`;
const one = async (q) => (await runNrql(q)).results;

// Fault onset = first poller sample (after chaos apply) where the kill target
// is NOT ready, i.e. when it actually went down (vs chaos-apply time, which the
// pod-failure injection lag delays). Resolution is bounded by the poll interval.
function deriveFaultOnset() {
  const pollPath = join(root, "results", `${LABEL}-${TOPO}-poll.jsonl`);
  let rows;
  try {
    rows = readFileSync(pollPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return { faultOnsetAt: tl.chaos.start, pollIntervalMs: null };
  }
  const ready = (r) => String(r.targetReady ?? r.paymentReady ?? "");
  const after = rows.filter((r) => r.t >= tl.chaos.start);
  const down = after.find((r) => !ready(r).includes("true"));
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push(rows[i].t - rows[i - 1].t);
  gaps.sort((a, b) => a - b);
  return {
    faultOnsetAt: down ? down.t : tl.chaos.start,
    pollIntervalMs: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
  };
}
const { faultOnsetAt, pollIntervalMs } = deriveFaultOnset();

// Dynamic service list for this topology (includes orchestrator when present).
const svcRows = await one(
  `FROM Transaction SELECT count(*) FACET appName WHERE appName LIKE '%-${TOPO}' ${win(tl.baseline.start, tl.recovery.end)} LIMIT 20`,
).catch(() => []);
const SERVICES = svcRows.map((r) => r.appName).filter(Boolean);
if (!SERVICES.length) SERVICES.push(...["shop", "warehouse", "payment", "delivery"].map((s) => `${s}-${TOPO}`));

const m = {}; // metric outputs

// --- #1 Network Overhead (design count + measured gRPC hops per trace) ---
const designCalls = { "sync-chain": 3, "sync-orchestrator": 4, "async-event": 4 };
let measured = null;
if (TOPO === "async-event") {
  const msg = await one(
    `FROM Transaction SELECT count(*) AS steps WHERE appName LIKE '%-async-event' AND appName != '${ENTRY}' ${win(tl.baseline.start, tl.baseline.end)}`,
  ).catch(() => [{}]);
  const orders = await one(
    `FROM Transaction SELECT count(*) AS n WHERE appName = '${ENTRY}' ${win(tl.baseline.start, tl.baseline.end)}`,
  ).catch(() => [{}]);
  const steps = msg[0]?.steps ?? 0;
  const n = orders[0]?.n ?? 0;
  measured = n ? Math.round((steps / n) * 100) / 100 : null;
} else {
  const ext = await one(
    `FROM Span SELECT count(*) AS ext, uniqueCount(trace.id) AS traces WHERE name LIKE 'External/%' AND appName LIKE '%-${TOPO}' ${win(tl.baseline.start, tl.baseline.end)}`,
  ).catch(() => [{}]);
  const extTraces = ext[0]?.traces ?? 0;
  measured = extTraces ? Math.round(((ext[0]?.ext ?? 0) / extTraces) * 100) / 100 : null;
}
m.networkOverhead = {
  designCallsPerTransaction: designCalls[TOPO],
  measuredAvgCallsPerTransaction: measured,
  measurementBasis: TOPO === "async-event" ? "downstream message transactions per order (RabbitMQ DT not linked)" : "External gRPC spans per trace",
  unit: "network calls per business transaction",
};

// --- Latency Overhead (baseline end-to-end latency at the entry service) ---
// The cost of the topology under NORMAL conditions: chain nests 3 gRPC hops;
// orchestrator does client->orchestrator + 4 sequential gRPC calls.
// Report the MEDIAN as the headline (avg is skewed by the chain's heavy tail);
// keep avg/p95 to show the tail behaviour.
const r1 = (x) => (x != null ? Math.round(x * 10) / 10 : null);
const latMed = await one(
  `FROM Transaction SELECT percentile(duration, 50)*1000 AS p50Ms WHERE appName = '${ENTRY}' AND error IS false ${win(tl.baseline.start, tl.baseline.end)}`,
).catch(() => [{}]);
const latAvg = await one(
  `FROM Transaction SELECT average(duration)*1000 AS avgMs, count(*) AS n WHERE appName = '${ENTRY}' AND error IS false ${win(tl.baseline.start, tl.baseline.end)}`,
).catch(() => [{}]);
const latP95 = await one(
  `FROM Transaction SELECT percentile(duration, 95)*1000 AS p95Ms WHERE appName = '${ENTRY}' AND error IS false ${win(tl.baseline.start, tl.baseline.end)}`,
).catch(() => [{}]);
m.latencyOverhead = {
  entryService: ENTRY,
  baselineMedianMs: r1(latMed[0]?.p50Ms),
  baselineAvgMs: r1(latAvg[0]?.avgMs),
  baselineP95Ms: r1(latP95[0]?.p95Ms),
  requests: latAvg[0]?.n ?? 0,
};

// --- #2 Success Rate under Stress (entry service, ACTIVE-fault window) ---
const s2 = await one(
  `FROM Transaction SELECT percentage(count(*), WHERE error IS false) AS successPct, count(*) AS n WHERE appName = '${ENTRY}' ${win(faultOnsetAt, tl.chaos.end)}`,
);
m.successRateUnderStress = { successPct: s2[0]?.successPct ?? null, requests: s2[0]?.n ?? 0 };

// --- #3 Propagation Latency (fault onset -> first user-visible error) ---
const s3 = await one(
  `FROM TransactionError SELECT earliest(timestamp) AS firstError, count(*) AS n WHERE appName = '${ENTRY}' ${win(faultOnsetAt, tl.chaos.end)}`,
);
const firstErr = s3[0]?.firstError ?? null;
const latencyMs = firstErr ? firstErr - faultOnsetAt : null;
m.propagationLatency = {
  faultOnsetAt,
  chaosAppliedAt: tl.chaos.start,
  firstUserVisibleErrorAt: firstErr,
  latencyMs,
  resolutionMs: pollIntervalMs,
  note:
    TOPO === "async-event"
      ? "async: client gets 201 immediately; HTTP-level errors may be absent. True visibility = order stuck non-terminal (app-level), not captured here."
      : latencyMs != null && pollIntervalMs != null && Math.abs(latencyMs) <= pollIntervalMs
        ? `at/under poll resolution (~${pollIntervalMs}ms) — propagation effectively immediate`
        : null,
};

// --- #4 Recovery Time / MTTR (kill target ready -> success back to 100%) ---
const TR = tl.recovery.paymentReadyAt;
const ts = await one(
  `FROM Transaction SELECT percentage(count(*), WHERE error IS false) AS successPct, count(*) AS n WHERE appName = '${ENTRY}' TIMESERIES 5 seconds ${win(TR, tl.recovery.end)}`,
);
let recoveredAt = null;
for (const b of ts) {
  if ((b.n ?? 0) > 0 && b.successPct === 100) {
    recoveredAt = Math.round((b.beginTimeSeconds ?? 0) * 1000);
    break;
  }
}
let queueDrainedAt = null;
if (Array.isArray(tl.rabbit)) {
  const after = tl.rabbit.filter((r) => r.t >= TR);
  const z = after.find((r) => r.messages === 0);
  queueDrainedAt = z ? z.t : null;
}
const noHttpImpact = m.successRateUnderStress.successPct === 100;
m.recoveryTimeMTTR = {
  killTargetReadyAt: TR,
  successRecoveredAt: noHttpImpact ? null : recoveredAt,
  httpMttrMs: noHttpImpact ? 0 : recoveredAt ? recoveredAt - TR : null,
  queueDrainedAt,
  queueDrainMs: queueDrainedAt ? queueDrainedAt - TR : null,
  note: noHttpImpact
    ? "no HTTP-level degradation to recover from" +
      (TOPO === "async-event" ? "; async recovery = RabbitMQ backlog drain" : "")
    : TOPO === "async-event"
      ? "async MTTR = max(httpMttr, queueDrain)"
      : null,
};

// --- #5 Failure Propagation Rate (services that erred during the fault) ---
const s5 = await one(
  `FROM Transaction SELECT percentage(count(*), WHERE error IS true) AS errorPct, count(*) AS n FACET appName WHERE appName LIKE '%-${TOPO}' ${win(faultOnsetAt, tl.chaos.end)}`,
);
const THRESH = 5;
const perService = SERVICES.map((svc) => {
  const r = s5.find((x) => x.appName === svc);
  return { service: svc, errorPct: r?.errorPct ?? 0, requests: r?.n ?? 0 };
});
const affected = perService.filter((p) => p.errorPct > THRESH);
m.failurePropagationRate = {
  thresholdPct: THRESH,
  killService: KILL,
  affectedServices: affected.map((p) => p.service),
  ratePct: Math.round((affected.length / SERVICES.length) * 1000) / 10,
  perService,
};

const out = {
  experiment: `${LABEL}-kill-${KILL}`,
  topology: TOPO,
  capturedAt: new Date().toISOString(),
  timeline: tl,
  metrics: m,
};
const outPath = join(root, "results", `${LABEL}-${TOPO}-nr.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`\n=== ${LABEL} metrics — ${TOPO} (kill ${KILL}, entry ${ENTRY}) ===`);
console.log(`1 Network Overhead       : ${m.networkOverhead.designCallsPerTransaction} calls (design), ~${m.networkOverhead.measuredAvgCallsPerTransaction} measured`);
console.log(`  Latency overhead       : median ${m.latencyOverhead.baselineMedianMs} ms (avg ${m.latencyOverhead.baselineAvgMs}, p95 ${m.latencyOverhead.baselineP95Ms}) baseline`);
console.log(`2 Success under Stress   : ${m.successRateUnderStress.successPct}%  (n=${m.successRateUnderStress.requests})`);
console.log(`3 Propagation Latency    : ${m.propagationLatency.latencyMs} ms`);
console.log(`4 Recovery (MTTR)        : http ${m.recoveryTimeMTTR.httpMttrMs} ms` + (queueDrainedAt !== null || TOPO === "async-event" ? `, queue ${m.recoveryTimeMTTR.queueDrainMs} ms` : ""));
console.log(`5 Failure Propagation    : ${m.failurePropagationRate.ratePct}%  [${m.failurePropagationRate.affectedServices.join(", ") || "none"}]`);
console.log(`  per-service error %:`);
for (const p of m.failurePropagationRate.perService) console.log(`    ${p.service.padEnd(28)} ${p.errorPct}%  (n=${p.requests})`);
console.log(`\nwrote ${outPath}`);
