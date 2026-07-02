#!/usr/bin/env bash
# Orchestrate a chaos experiment for one topology and capture the thesis
# metrics from New Relic. (Originally Exp 1; now generalized via env knobs.)
#
#   metrics/run-exp1.sh <topology>
#
# One continuous k6 load spans all three phases so NR has an unbroken timeline:
#   baseline (no chaos) -> chaos (target service down) -> recovery (chaos removed)
#
# Env knobs:
#   KILL          service to take down            (default payment)
#   ENTRY_DEPLOY  deployment the client hits       (default shop)
#   ENTRY_PORT    HTTP port of the entry service   (default 3001)
#   LABEL         output-file prefix / exp name    (default exp1)
#   CHAOS_FILE    chaos manifest to apply          (default flapping payment-kill)
#   BASELINE/CHAOS/RECOVERY  phase lengths in seconds (default 60/120/90)
#   RATE          k6 request rate (req/s)          (default 20)
#
# Examples:
#   # Exp 1 sustained (kill payment, client -> shop):
#   CHAOS_FILE=chaos/experiment1-sustained-payment-down.yaml \
#     BASELINE=45 CHAOS=90 RECOVERY=120 metrics/run-exp1.sh sync-chain
#   # Exp 2 (kill warehouse, client -> orchestrator):
#   LABEL=exp2 KILL=warehouse ENTRY_DEPLOY=orchestrator ENTRY_PORT=3005 \
#     CHAOS_FILE=chaos/experiment2-sustained-warehouse-down.yaml \
#     BASELINE=45 CHAOS=90 RECOVERY=120 metrics/run-exp1.sh sync-orchestrator
#
# Requires: kubectl context on the cluster, k6 installed, NEW_RELIC_API_KEY in .env.
set -euo pipefail

TOPO="${1:?usage: run-exp1.sh <topology>}"
RATE="${RATE:-20}"
BASELINE="${BASELINE:-60}"
CHAOS="${CHAOS:-120}"
RECOVERY="${RECOVERY:-90}"
KILL="${KILL:-payment}"
ENTRY_DEPLOY="${ENTRY_DEPLOY:-shop}"
ENTRY_PORT="${ENTRY_PORT:-3001}"
LABEL="${LABEL:-exp1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Default = flapping pod-kill schedule; override with a sustained-outage variant.
CHAOS_FILE="${CHAOS_FILE:-$ROOT/chaos/experiment1-keep-payment-down.yaml}"
[ -f "$CHAOS_FILE" ] || CHAOS_FILE="$ROOT/$CHAOS_FILE"
ENTRY_APP="${ENTRY_DEPLOY}-${TOPO}"
TL="$ROOT/results/${LABEL}-${TOPO}-timeline.json"
mkdir -p "$ROOT/results"

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
log() { echo "[$(date +%H:%M:%S)] $*"; }

command -v k6 >/dev/null || { echo "k6 not installed"; exit 1; }

# --- port-forward entry service + background pollers; clean up on exit ---
PIDS=()
cleanup() {
  log "cleanup"
  kubectl delete -f "$CHAOS_FILE" --ignore-not-found >/dev/null 2>&1 || true
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

log "port-forward ${ENTRY_DEPLOY}:${ENTRY_PORT} (kill target: ${KILL})"
kubectl port-forward "deploy/${ENTRY_DEPLOY}" "${ENTRY_PORT}:${ENTRY_PORT}" >/tmp/${LABEL}-pf.log 2>&1 &
PIDS+=($!)
sleep 3

# Background poller: kill-target readiness + (async) rabbitmq queue depth -> jsonl
POLL="$ROOT/results/${LABEL}-${TOPO}-poll.jsonl"
: > "$POLL"
RMQ_POD=$(kubectl get pods -l app=rabbitmq -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
(
  while true; do
    t=$(now_ms)
    ready=$(kubectl get pods -l app="$KILL" -o jsonpath='{.items[*].status.containerStatuses[*].ready}' 2>/dev/null || echo "")
    msgs=null
    if [ "$TOPO" = "async-event" ] && [ -n "$RMQ_POD" ]; then
      msgs=$(kubectl exec "$RMQ_POD" -- rabbitmqctl list_queues messages --quiet 2>/dev/null | awk '{s+=$1} END{print s+0}')
      [ -z "$msgs" ] && msgs=null
    fi
    echo "{\"t\":$t,\"targetReady\":\"$ready\",\"messages\":$msgs}" >> "$POLL"
    sleep 1
  done
) &
PIDS+=($!)

# --- one continuous k6 run for the whole experiment ---
TOTAL=$((BASELINE + CHAOS + RECOVERY))
log "starting k6: ${RATE} req/s for ${TOTAL}s -> ${ENTRY_APP} (baseline ${BASELINE} / chaos ${CHAOS} / recovery ${RECOVERY})"
TARGET_URL="http://localhost:${ENTRY_PORT}" RATE=$RATE DURATION=${TOTAL}s \
  k6 run "$ROOT/load-tests/dist/experiment1-sustained.js" \
  --summary-export "$ROOT/results/${LABEL}-${TOPO}-k6.json" >/tmp/${LABEL}-k6.log 2>&1 &
K6_PID=$!
PIDS+=("$K6_PID")

BASELINE_START=$(now_ms)
log "baseline phase (${BASELINE}s)"; sleep "$BASELINE"

CHAOS_START=$(now_ms)
log "INJECT chaos (T0=$CHAOS_START)"; kubectl apply -f "$CHAOS_FILE" >/dev/null
sleep "$CHAOS"
CHAOS_END=$(now_ms)

log "REMOVE chaos"; kubectl delete -f "$CHAOS_FILE" --ignore-not-found >/dev/null
# TR = first time the kill target is Ready again after chaos removed
TR=""
for _ in $(seq 1 60); do
  r=$(kubectl get pods -l app="$KILL" -o jsonpath='{.items[*].status.containerStatuses[*].ready}' 2>/dev/null || echo "")
  if echo "$r" | grep -q "true"; then TR=$(now_ms); break; fi
  sleep 2
done
[ -z "$TR" ] && TR=$(now_ms)
log "${KILL} ready (TR=$TR); recovery phase (${RECOVERY}s)"
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
  "experiment": "${LABEL}",
  "topology": "${TOPO}",
  "killService": "${KILL}",
  "entryApp": "${ENTRY_APP}",
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
