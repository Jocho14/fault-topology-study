# Exp 1 metrics → NRQL (New Relic account 8100704, EU)

Experiment 1 = failure isolation: payment killed every 10s (Chaos Mesh),
`sync-chain` vs `async-event`. Each metric below is one NRQL query.

Conventions:
- `{TOPO}` = `sync-chain` or `async-event`. App names are `<service>-{TOPO}`
  (e.g. `shop-sync-chain`). Entry service is always **shop**.
- `{T0}` = chaos injection time, `{TR}` = payment pod-ready time,
  `{CHAOS_START}`/`{CHAOS_END}` = chaos window. These come from the
  orchestrator (kubectl/chaos timestamps), not from NR.
- Run any query with: `node metrics/nrql.mjs "<NRQL>"`

---

## 0. Distributed-trace linkage check (prerequisite for #3 and #5)
Confirms traces span multiple services (i.e. DT propagates over gRPC / RabbitMQ).
If `services` > 1 per trace, linkage works and #3/#5 are valid from NR.

```sql
FROM Span SELECT uniqueCount(entity.name) AS services, count(*) AS spans
FACET trace.id WHERE appName LIKE '%-{TOPO}' SINCE 30 minutes ago LIMIT 10
```

## 1. Network Overhead — calls per business transaction
Design count (authoritative): sync-chain = 3 gRPC hops, sync-orchestrator = 4 calls,
async-event = 4 publishes. NR confirmation = spans per end-to-end trace:

```sql
FROM Span SELECT average(numSpans) FROM (
  FROM Span SELECT count(*) AS numSpans FACET trace.id WHERE appName LIKE '%-{TOPO}'
) SINCE 30 minutes ago
```
(or inspect one trace: `FROM Span SELECT entity.name, name WHERE trace.id = '<id>' ORDER BY timestamp`)

## 2. Success Rate under Stress — % client requests OK during the fault
Measured at the entry service over the chaos window:

```sql
FROM Transaction SELECT percentage(count(*), WHERE error IS false) AS 'success %'
WHERE appName = 'shop-{TOPO}' SINCE {CHAOS_START} UNTIL {CHAOS_END}
```

## 3. Propagation Latency — fault → first user-visible error
NR gives the first client-visible error timestamp; orchestrator subtracts {T0}:

```sql
FROM TransactionError SELECT earliest(timestamp) AS firstUserError
WHERE appName = 'shop-{TOPO}' SINCE {T0} UNTIL {CHAOS_END}
```
`propagation_latency = firstUserError - {T0}`.
NOTE (async): the client gets 201 immediately, so the fault is NOT visible at
order-create. For async, "visible" = order stuck in a non-terminal status;
that is app state, measured by polling `GET /orders/:id`, not by this query.

## 4. Recovery Time (MTTR) — pod restart → success back to 100%
Find the first 5s bucket at 100% success at/after payment became ready ({TR});
orchestrator subtracts {TR}:

```sql
FROM Transaction SELECT percentage(count(*), WHERE error IS false) AS 'success %'
WHERE appName = 'shop-{TOPO}' TIMESERIES 5 seconds SINCE {TR} UNTIL {CHAOS_END}
```
`mttr = firstFullSuccessBucket - {TR}`.
NOTE (async): also requires RabbitMQ backlog drained (queue depth → 0), polled
from the RabbitMQ management API by the orchestrator — that drain time is the
real async recovery point, often later than the HTTP success recovery.

## 5. Failure Propagation Rate — % of services that stop responding correctly
Per-service error rate during the chaos window; count services above a small
threshold, divide by total services in the topology:

```sql
FROM Transaction SELECT percentage(count(*), WHERE error IS true) AS 'error %'
FACET appName WHERE appName LIKE '%-{TOPO}' SINCE {CHAOS_START} UNTIL {CHAOS_END}
```
`failure_propagation_rate = (#services with error% > 5) / (total services)`.
Expected: sync-chain cascades (payment + warehouse + shop error) → high;
async-event contains it (only payment processing pauses) → low.

---

# Exp 3 metrics → NRQL — partition payment ↔ postgres

Experiment 3 = temporary failure of payment's stateful dependency: a
NetworkChaos partition blocks payment's pod from reaching the postgres pod
for 60 s, applied 45 s into a 255 s constant-arrival-rate run. Compares
`sync-chain` vs `async-event`.

Conventions: `{TOPO}` = `sync-chain` or `async-event`. App names are
`<service>-{TOPO}`. Entry service is **shop** in both topologies (in async,
shop fire-and-forgets onto RabbitMQ; in chain it makes the blocking call to
warehouse). Windows: `{T0}` = `chaosStart`, `{TE}` = `chaosEnd`,
`{K6START}`/`{K6END}` from each run's `meta.json`.

## A. Per-service error rate during the partition window
Shows how the fault propagates. In sync-chain, payment errors cascade up to
warehouse and shop; in async-event, payment errors are absorbed by the
broker's redelivery (shop/warehouse stay clean — they already published).

```sql
FROM Transaction SELECT percentage(count(*), WHERE error IS true) AS errorPct,
                        count(*) AS n
FACET appName WHERE appName LIKE '%-{TOPO}' SINCE {T0} UNTIL {TE}
```

## B. Per-service error rate as a timeseries (for charts)
Mirrors the per-service chart in Exp 1/2b. Window = the full run (`{K6START}` to
`{K6END} + 30000` ms for the post-drain).

```sql
FROM Transaction SELECT percentage(count(*), WHERE error IS true) AS error_rate
FACET appName WHERE appName LIKE '%-{TOPO}' TIMESERIES 1 second
SINCE {K6START} UNTIL {K6END}
```

## C. payment errors (the fault signature)
Confirms payment is the one failing during the partition window (DB writes
throwing). Should be ~100% errors during chaos in both topologies; in async
the messages get nack-requeued so eventually they all succeed (after the
partition ends), whereas in sync they're lost forever (the caller already
gave up).

```sql
FROM Transaction SELECT percentage(count(*), WHERE error IS true) AS errorPct,
                        count(*) AS n
WHERE appName = 'payment-{TOPO}' SINCE {T0} UNTIL {TE}
```

## D. RabbitMQ backlog (async only)
NR does not capture queue depth — get it from the run's `poll.jsonl` if you
add a queue-depth poller to run-exp3.sh, or directly via
`kubectl exec <rabbitmq-pod> -- rabbitmqctl list_queues messages` during the
run. Expect `stock_events_queue` (the one feeding payment) to grow during the
partition and drain to zero shortly after the partition ends.

## E. The headline (WPR) — NOT NRQL
The primary metric for Exp 3 is the Work Preservation Rate, computed by
`metrics/compute-exp3.mjs` from k6's `iterations.count` and the
post-run row count of `delivery_db.deliveries`. NRQL queries A–C are
supporting evidence: they explain *how* the WPR difference arose
(propagation cascade in chain vs broker-buffered recovery in async).
