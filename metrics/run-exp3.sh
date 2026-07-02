#!/usr/bin/env bash
# Orchestrate Experiment 3 — temporary failure of payment's DB dependency.
# Captures Work Preservation Rate (WPR): how many of the iterations k6 fired
# actually reach a successful terminal state (= a row in delivery_db.deliveries).
#
#   metrics/run-exp3.sh <sync-chain|async-event>
#
# Phases (k6 runs a constant arrival rate for the whole 255s):
#   0   k6 starts (baseline)
#   45  inject NetworkChaos partition (payment cannot reach postgres)
#   105 remove chaos (60s of failure)
#   225 end of recovery
#   255 k6 ends (last 30s is a no-new-faults "drain" period)
#   +30 wait after k6 finishes for any queued messages to drain to delivery_db
#   +30 truncate is already done at start, so the row count is the WPR numerator
#
# Designed for repeated invocations: each run is fully self-contained, with its
# own timestamped output directory under results/, and the delivery table is
# truncated before k6 starts so the row count is per-run.
#
# Env knobs: RATE (default 20), BASELINE/CHAOS/RECOVERY/DRAIN/POSTWAIT phase
# lengths in seconds (45/60/120/30/30), CHAOS_FILE override.
set -euo pipefail

TOPO="${1:?usage: run-exp3.sh <sync-chain|async-event>}"
RATE="${RATE:-20}"
BASELINE="${BASELINE:-45}"
CHAOS="${CHAOS:-60}"
RECOVERY="${RECOVERY:-120}"
DRAIN="${DRAIN:-30}"        # last phase of k6 (no new chaos, k6 still firing)
POSTWAIT="${POSTWAIT:-30}"  # after k6 ends, no new load, let queues drain
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAOS_FILE="${CHAOS_FILE:-$ROOT/chaos/experiment3-partition-payment-db.yaml}"
[ -f "$CHAOS_FILE" ] || CHAOS_FILE="$ROOT/$CHAOS_FILE"

TS=$(date +%Y%m%d-%H%M%S)
OUT="$ROOT/results/exp3-${TOPO}-${TS}"
mkdir -p "$OUT"

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
log()    { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/run.log"; }

command -v k6 >/dev/null || { echo "k6 not installed"; exit 1; }

# --- cleanup: kill background processes + remove chaos on exit ---
PIDS=()
cleanup() {
  log "cleanup"
  kubectl delete -f "$CHAOS_FILE" --ignore-not-found >/dev/null 2>&1 || true
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

# --- pre-run: truncate the terminal-state tables in delivery_db so the row ---
# count after the run is exactly the number of orders that completed this run.
log "truncate delivery_db.deliveries (and payment/warehouse/orders for cleanliness)"
PG_POD=$(kubectl get pods -l app=postgres -o jsonpath='{.items[0].metadata.name}')
kubectl exec "$PG_POD" -- psql -U postgres -d delivery_db  -c "TRUNCATE TABLE deliveries"      >/dev/null
kubectl exec "$PG_POD" -- psql -U postgres -d payment_db   -c "TRUNCATE TABLE payments"        >/dev/null 2>&1 || true
kubectl exec "$PG_POD" -- psql -U postgres -d warehouse_db -c "TRUNCATE TABLE stock_checks"    >/dev/null 2>&1 || true
kubectl exec "$PG_POD" -- psql -U postgres -d shop_db      -c "TRUNCATE TABLE orders"          >/dev/null 2>&1 || true

# Purge async-event queues so a stale msg left from a previous trial cannot
# leak into this one's delivery count. Idempotent: no-op if queues are empty
# or do not yet exist (sync-chain doesn't use these).
RMQ_POD=$(kubectl get pods -l app=rabbitmq -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [ -n "$RMQ_POD" ]; then
  for q in order_events_queue stock_events_queue payment_events_queue; do
    kubectl exec "$RMQ_POD" -- rabbitmqctl purge_queue "$q" >/dev/null 2>&1 || true
  done
  log "purged rabbitmq queues"
fi

# port-forward shop (entry for both topologies in this experiment)
log "port-forward shop:3001"
kubectl port-forward deploy/shop 3001:3001 >"$OUT/portforward.log" 2>&1 &
PIDS+=($!)
sleep 3

# Background poller: per-second RabbitMQ queue depths (async only, for charts).
# Writes one JSON line per second to queue-depth.jsonl. Lightweight: just reads
# the three queues' message counts via rabbitmqctl.
if [ "$TOPO" = "async-event" ] && [ -n "$RMQ_POD" ]; then
  QPOLL="$OUT/queue-depth.jsonl"
  : > "$QPOLL"
  (
    while true; do
      t=$(now_ms)
      line=$(kubectl exec "$RMQ_POD" -- rabbitmqctl list_queues name messages --quiet 2>/dev/null)
      order=$(echo "$line"  | awk '$1=="order_events_queue"   {print $2}')
      stock=$(echo "$line"  | awk '$1=="stock_events_queue"   {print $2}')
      pay=$(echo   "$line"  | awk '$1=="payment_events_queue" {print $2}')
      echo "{\"t\":$t,\"order_events_queue\":${order:-0},\"stock_events_queue\":${stock:-0},\"payment_events_queue\":${pay:-0}}" >> "$QPOLL"
      sleep 1
    done
  ) &
  PIDS+=($!)
  log "queue-depth poller running -> $QPOLL"
fi

# --- start k6 in the background for the full duration ---
TOTAL=$((BASELINE + CHAOS + RECOVERY + DRAIN))
log "starting k6: ${RATE} req/s for ${TOTAL}s (baseline ${BASELINE}/chaos ${CHAOS}/recovery ${RECOVERY}/drain ${DRAIN})"
TARGET_URL=http://localhost:3001 RATE=$RATE DURATION=${TOTAL}s \
  k6 run "$ROOT/load-tests/dist/experiment3.js" \
  --summary-export "$OUT/k6.json" >"$OUT/k6.log" 2>&1 &
K6_PID=$!
PIDS+=("$K6_PID")

K6_START=$(now_ms)
log "baseline phase (${BASELINE}s)"; sleep "$BASELINE"

CHAOS_START=$(now_ms)
log "INJECT partition payment<->postgres (T0=$CHAOS_START)"
kubectl apply -f "$CHAOS_FILE" >/dev/null
sleep "$CHAOS"
CHAOS_END=$(now_ms)
log "REMOVE partition"; kubectl delete -f "$CHAOS_FILE" --ignore-not-found >/dev/null

# rest of k6 (recovery + drain phases) finishes on its own
wait "$K6_PID" 2>/dev/null || true
K6_END=$(now_ms)
log "k6 finished; waiting ${POSTWAIT}s for any backlog to drain to delivery_db"
sleep "$POSTWAIT"
HARVEST=$(now_ms)

# --- harvest the delivery row count ---
DELIVERIES=$(kubectl exec "$PG_POD" -- psql -U postgres -d delivery_db -t -A -c "SELECT count(*) FROM deliveries")
log "delivery_db.deliveries count = $DELIVERIES"

# also capture intermediate counts for reasoning (payment ledger, etc.)
PAYMENTS=$(kubectl exec "$PG_POD" -- psql -U postgres -d payment_db -t -A -c "SELECT count(*) FROM payments" 2>/dev/null || echo 0)
STOCKS=$(kubectl exec "$PG_POD" -- psql -U postgres -d warehouse_db -t -A -c "SELECT count(*) FROM stock_checks" 2>/dev/null || echo 0)
ORDERS=$(kubectl exec "$PG_POD" -- psql -U postgres -d shop_db -t -A -c "SELECT count(*) FROM orders" 2>/dev/null || echo 0)

# --- write metadata + simple counts file ---
python3 - "$OUT" <<PY
import json, sys
out = sys.argv[1]
meta = {
  "experiment": "exp3-partition-payment-db",
  "topology": "${TOPO}",
  "timestamp_iso": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "phases_ms": {
    "k6Start":     ${K6_START},
    "chaosStart":  ${CHAOS_START},
    "chaosEnd":    ${CHAOS_END},
    "k6End":       ${K6_END},
    "harvest":     ${HARVEST}
  },
  "settings": {
    "rate_rps": ${RATE},
    "baseline_s": ${BASELINE},
    "chaos_s": ${CHAOS},
    "recovery_s": ${RECOVERY},
    "drain_s": ${DRAIN},
    "postwait_s": ${POSTWAIT}
  },
  "db_counts": {
    "deliveries": ${DELIVERIES},
    "payments":   ${PAYMENTS},
    "stocks":     ${STOCKS},
    "orders":     ${ORDERS}
  }
}
json.dump(meta, open(f"{out}/meta.json","w"), indent=2)
print("wrote", f"{out}/meta.json")
PY

log "computing WPR"
node "$ROOT/metrics/compute-exp3.mjs" "$OUT"
echo "$OUT"
