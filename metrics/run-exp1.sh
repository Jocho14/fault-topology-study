#!/usr/bin/env bash
# Orchestrate Experiment 1 (kill payment) for one topology and capture the
# 5 thesis metrics from New Relic.
#
#   metrics/run-exp1.sh <sync-chain|async-event>
#
# Phases (one continuous k6 load spans all three so NR has an unbroken timeline):
#   baseline (no chaos) -> chaos (payment killed every 10s) -> recovery (chaos removed)
#
# Env knobs (seconds): BASELINE=60 CHAOS=120 RECOVERY=90 ; RATE=20 (req/s)
# Requires: kubectl context on the cluster, k6 installed, NEW_RELIC_API_KEY in .env.
set -euo pipefail

TOPO="${1:?usage: run-exp1.sh <sync-chain|async-event>}"
RATE="${RATE:-20}"
BASELINE="${BASELINE:-60}"
CHAOS="${CHAOS:-120}"
RECOVERY="${RECOVERY:-90}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Default = flapping pod-kill schedule; override with the sustained-outage
# variant via:  CHAOS_FILE=chaos/experiment1-sustained-payment-down.yaml
CHAOS_FILE="${CHAOS_FILE:-$ROOT/chaos/experiment1-keep-payment-down.yaml}"
[ -f "$CHAOS_FILE" ] || CHAOS_FILE="$ROOT/$CHAOS_FILE"
TL="$ROOT/results/exp1-${TOPO}-timeline.json"
mkdir -p "$ROOT/results"

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
log() { echo "[$(date +%H:%M:%S)] $*"; }

command -v k6 >/dev/null || { echo "k6 not installed"; exit 1; }

# --- port-forward shop + background pollers; clean up on exit ---
PIDS=()
cleanup() {
  log "cleanup"
  kubectl delete -f "$CHAOS_FILE" --ignore-not-found >/dev/null 2>&1 || true
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

log "port-forward shop:3001"
kubectl port-forward deploy/shop 3001:3001 >/tmp/exp1-pf.log 2>&1 &
PIDS+=($!)
sleep 3

# Background poller: payment readiness + (async) rabbitmq queue depth -> jsonl
POLL="$ROOT/results/exp1-${TOPO}-poll.jsonl"
: > "$POLL"
RMQ_POD=$(kubectl get pods -l app=rabbitmq -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
(
  while true; do
    t=$(now_ms)
    ready=$(kubectl get pods -l app=payment -o jsonpath='{.items[*].status.containerStatuses[*].ready}' 2>/dev/null || echo "")
    msgs=null
    if [ "$TOPO" = "async-event" ] && [ -n "$RMQ_POD" ]; then
      msgs=$(kubectl exec "$RMQ_POD" -- rabbitmqctl list_queues messages --quiet 2>/dev/null | awk '{s+=$1} END{print s+0}')
      [ -z "$msgs" ] && msgs=null
    fi
    echo "{\"t\":$t,\"paymentReady\":\"$ready\",\"messages\":$msgs}" >> "$POLL"
    sleep 1
  done
) &
PIDS+=($!)

# --- one continuous k6 run for the whole experiment ---
TOTAL=$((BASELINE + CHAOS + RECOVERY))
log "starting k6: ${RATE} req/s for ${TOTAL}s (baseline ${BASELINE} / chaos ${CHAOS} / recovery ${RECOVERY})"
TARGET_URL=http://localhost:3001 RATE=$RATE DURATION=${TOTAL}s \
  k6 run "$ROOT/load-tests/dist/experiment1-sustained.js" \
  --summary-export "$ROOT/results/exp1-${TOPO}-k6.json" >/tmp/exp1-k6.log 2>&1 &
K6_PID=$!
PIDS+=("$K6_PID")

BASELINE_START=$(now_ms)
log "baseline phase (${BASELINE}s)"; sleep "$BASELINE"

CHAOS_START=$(now_ms)
log "INJECT chaos (T0=$CHAOS_START)"; kubectl apply -f "$CHAOS_FILE" >/dev/null
sleep "$CHAOS"
CHAOS_END=$(now_ms)

log "REMOVE chaos"; kubectl delete -f "$CHAOS_FILE" --ignore-not-found >/dev/null
# TR = first time payment is Ready after chaos removed
TR=""
for _ in $(seq 1 60); do
  r=$(kubectl get pods -l app=payment -o jsonpath='{.items[*].status.containerStatuses[*].ready}' 2>/dev/null || echo "")
  if echo "$r" | grep -q "true"; then TR=$(now_ms); break; fi
  sleep 2
done
[ -z "$TR" ] && TR=$(now_ms)
log "payment ready (TR=$TR); recovery phase (${RECOVERY}s)"
sleep "$RECOVERY"
RECOVERY_END=$(now_ms)

wait "$K6_PID" 2>/dev/null || true
log "k6 finished; waiting 20s for NR ingest"; sleep 20

# --- assemble timeline.json (fold poller samples in for rabbit drain) ---
python3 - "$TL" "$POLL" <<PY
import json, sys
tl_path, poll = sys.argv[1], sys.argv[2]
rabbit=[]
for line in open(poll):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d.get("messages") is not None:
        rabbit.append({"t":d["t"],"messages":d["messages"]})
tl={
  "topology": "${TOPO}",
  "baseline": {"start": ${BASELINE_START}, "end": ${CHAOS_START}},
  "chaos":    {"start": ${CHAOS_START}, "end": ${CHAOS_END}},
  "recovery": {"paymentReadyAt": ${TR}, "end": ${RECOVERY_END}},
  "rabbit": rabbit,
}
json.dump(tl, open(tl_path,"w"), indent=2)
print("wrote", tl_path)
PY

log "computing metrics via NRQL"
node "$ROOT/metrics/compute-exp1.mjs" "$TL"
