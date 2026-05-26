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
