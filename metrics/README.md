# New Relic + metrics: what everything is

A plain-language map of everything added when we introduced New Relic, so you
don't have to reverse-engineer it. Read top to bottom once; after that you only
need the "How to run an experiment" section.

---

## 1. The big picture

k6 (your load tests) measures the system **from the outside** — it fires HTTP
requests at `shop` and records status codes and latency. It cannot see what
happens *inside* the system: which internal service actually broke, how a
failure spread, how long a trace spent in each hop.

**New Relic (NR)** is an APM (Application Performance Monitoring) service. A
small agent runs *inside each service* and reports timing, errors, and traces
to New Relic's cloud. We then query that data to compute the thesis metrics k6
can't see (propagation latency, failure propagation, etc.).

So: **k6 = outside view, New Relic = inside view.** We use both.

---

## 2. New Relic concepts (the vocabulary)

- **Agent** — the `newrelic` npm package. `import 'newrelic'` is the first line
  of every service's `main.ts`; it auto-instruments Express, gRPC, Postgres,
  RabbitMQ and ships data to NR. Configured purely by env vars (no config file).
- **Account / region** — your data lives in NR account **8100704**, region
  **EU**. Queries go to `api.eu.newrelic.com`.
- **License/ingest key** (`...NRAL`) — lets services *send* data in. In `.env`
  as `NEW_RELIC_LICENSE_KEY`; in k8s as the `newrelic` Secret.
- **User API key** (`NRAK-...`) — lets us *query* data back out (different key!).
  In `.env` as `NEW_RELIC_API_KEY`.
- **App name** — how a service shows up in NR. We name them
  `<service>-<topology>` (e.g. `payment-sync-chain`, `shop-async-event`) so the
  three topologies never mix in the data.
- **Transaction** — one unit of work in one service (e.g. one HTTP request to
  shop, or one gRPC call warehouse handled). Each has a duration and an
  error flag. *Always recorded.*
- **Span** — a finer sub-step inside a transaction (a DB query, an outbound
  gRPC call, a middleware). *Sampled* (not every transaction keeps its spans),
  and ingested with a delay of ~30–60s.
- **Distributed trace** — spans from *multiple* services stitched into one tree
  by a shared `trace.id`, so you can follow a single order across shop →
  warehouse → payment → delivery. This is what lets us see propagation.
- **NRQL** — New Relic's SQL-like query language. Example:
  `FROM Transaction SELECT count(*) WHERE appName = 'shop-sync-chain'`.

---

## 3. `services/*/src/nr-trace.ts` — the RabbitMQ trace bridge

**Problem it solves:** gRPC traces link across services automatically. But in
the async (RabbitMQ) topology, NestJS hides the message headers from the NR
agent, so each service's work showed up as a *separate, disconnected* trace —
you couldn't follow one order across services.

**What it does:** carries the trace context *inside the event payload*.
- `injectTrace(data)` — called right before `rabbitClient.emit(...)`. Adds the
  current trace context to the message under a `_nr` field.
- `acceptTrace(data)` — called at the very start of each `@EventPattern`
  handler. Reads `_nr`, links this service's work to the producer's trace, then
  deletes `_nr` so the rest of the code never sees it.

After this fix, async traces correctly show all 4 services linked. It's a
no-op for the sync topologies (they don't use RabbitMQ).

---

## 4. `metrics/` — the tooling (4 files)

- **`nrql.mjs`** — the query runner. `node metrics/nrql.mjs "<NRQL>"` sends a
  query to New Relic and prints the result. Reads your API key from `.env`.
- **`QUERIES.md`** — the reference: one NRQL query per thesis metric, with the
  reasoning. This is your "how was each number derived" appendix.
- **`compute-exp1.mjs`** — takes a *timeline* file (see below) and computes all
  5 metrics by running the NRQL queries, then writes the `-nr.json` result.
- **`run-exp1.sh <topology>`** — the orchestrator that runs a whole experiment
  end-to-end (see section 6).

---

## 5. `results/` — the output files (4 kinds per run)

For each run you get four files, e.g. for sync-chain:

- **`exp1-sync-chain-nr.json`** ← **the one you cite.** The 5 computed metrics
  plus the timeline they were derived from. ("nr" = New Relic.)
- **`exp1-sync-chain-timeline.json`** — the *timestamps* of the run: when the
  baseline started, when chaos was injected (T0), when payment actually went
  down (faultOnset), when it recovered (TR), and the RabbitMQ queue-depth
  samples. `compute-exp1.mjs` needs these to know which time windows to query.
- **`exp1-sync-chain-poll.jsonl`** — raw per-second samples taken *during* the
  run: was payment ready? how many messages in RabbitMQ? ("poll" = we polled
  the cluster every second. `.jsonl` = one JSON object per line.) The timeline
  is distilled from this.
- **`exp1-sync-chain-k6.json`** — k6's own summary (the outside view: request
  count, success %, latencies).

---

## 6. How an experiment runs (`run-exp1.sh`)

One command runs the whole thing as a continuous load across three phases:

```
baseline (45s, no chaos)  →  chaos (90s, payment killed)  →  recovery (120s)
```

Step by step it:
1. Port-forwards `shop` and starts k6 firing 20 requests/sec for the full time.
2. Starts a background poller (records payment readiness + RabbitMQ queue depth
   every second → the `poll.jsonl`).
3. After baseline, records **T0** and applies the chaos manifest.
4. After the chaos window, deletes the chaos and waits for payment to be ready
   (records **TR**).
5. Writes `timeline.json`, then calls `compute-exp1.mjs` to query NR and write
   the `-nr.json` metrics.

Run it:
```bash
# default flapping chaos:
metrics/run-exp1.sh sync-chain

# sustained outage (what we standardised on for Exp 1):
CHAOS_FILE=chaos/experiment1-sustained-payment-down.yaml \
  BASELINE=45 CHAOS=90 RECOVERY=120 RATE=20 \
  metrics/run-exp1.sh sync-chain
```

---

## 7. The chaos manifests (`chaos/`)

- **`experiment1-keep-payment-down.yaml`** — *flapping*: a schedule that kills
  payment every 10s; it restarts in ~2s. We moved away from this because the
  repeated kill/restart makes "propagation latency" and "recovery time"
  ill-defined.
- **`experiment1-sustained-payment-down.yaml`** — *sustained*: keeps payment
  fully down until removed. This is what Exp 1 uses now — one clean fault, one
  clean recovery, so all 5 metrics are well-defined.

---

## 8. The load test (`load-tests/src/experiment1-sustained.ts`)

A duration-based k6 test: holds a **constant arrival rate** (e.g. 20 req/s) for
a set duration, instead of the original fixed-100-requests test that finished in
~3s (too short to span a chaos window). Build with `npm run build` in
`load-tests/`, which compiles it to `dist/experiment1-sustained.js`.

---

## 9. The 5 thesis metrics (where each comes from)

| Metric | Source | sync-chain (Exp 1) | async-event (Exp 1) |
|---|---|---|---|
| Network Overhead | design + NR spans | 3 | 4 |
| Success under Stress | k6 + NR Transaction | 0% | 100% |
| Propagation Latency | faultOnset → first shop error (NR) | ~0.8s | N/A (never user-visible) |
| Recovery / MTTR | payment-ready → success 100% / queue drained | ~24.5s | ~1.5s (queue drain) |
| Failure Propagation | per-service error rate (NR) | 50% | 0% |

`faultOnset` = when payment *actually* went down (from the poller), not when
chaos was applied — important because `pod-failure` has a ~32s injection lag.
