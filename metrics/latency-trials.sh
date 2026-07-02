#!/usr/bin/env bash
# Repeated latency trials for one topology under a NetworkChaos delay.
# Each k6 run is ONE independent observation (its mean/median latency) for a
# statistical comparison; results go one-row-per-trial to a CSV.
#
# Usage:
#   ENTRY_DEPLOY=orchestrator ENTRY_PORT=3005 TOPO=sync-orchestrator N=10 \
#     metrics/latency-trials.sh
#
# Env: N (trials, default 10), DUR (s per trial, 30), RATE (req/s, 20),
#      CHAOS_FILE (default chaos/latency-delay-services.yaml).
set -euo pipefail
ENTRY_DEPLOY="${ENTRY_DEPLOY:?set ENTRY_DEPLOY}"
ENTRY_PORT="${ENTRY_PORT:?set ENTRY_PORT}"
TOPO="${TOPO:?set TOPO}"
N="${N:-10}"
DUR="${DUR:-30}"
RATE="${RATE:-20}"
CHAOS_FILE="${CHAOS_FILE:-chaos/latency-delay-services.yaml}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$CHAOS_FILE" ] || CHAOS_FILE="$ROOT/$CHAOS_FILE"
CSV="$ROOT/results/latency-trials-${TOPO}.csv"

PIDS=()
cleanup() {
  kubectl delete -f "$CHAOS_FILE" --ignore-not-found >/dev/null 2>&1 || true
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

log() { echo "[$(date +%H:%M:%S)] $*"; }

log "apply delay ($CHAOS_FILE)"; kubectl apply -f "$CHAOS_FILE" >/dev/null; sleep 8
kubectl port-forward "deploy/${ENTRY_DEPLOY}" "${ENTRY_PORT}:${ENTRY_PORT}" >/tmp/trials-pf.log 2>&1 &
PIDS+=($!); sleep 3

run_k6() { # $1 = label/summary file
  TARGET_URL="http://localhost:${ENTRY_PORT}" RATE=$RATE DURATION=${DUR}s \
    k6 run "$ROOT/load-tests/dist/experiment1-sustained.js" \
    --summary-export "$1" >/dev/null 2>&1
}

log "warm-up run (discarded)"; run_k6 /tmp/trials-warmup.json

echo "trial,med_ms,avg_ms,p95_ms,failed_pct" > "$CSV"
for i in $(seq 1 "$N"); do
  f="/tmp/trial-${TOPO}-${i}.json"
  run_k6 "$f"
  row=$(python3 -c "
import json
d=json.load(open('$f'))['metrics']; h=d['http_req_duration']
print('%d,%.2f,%.2f,%.2f,%.2f' % ($i, h['med'], h['avg'], h['p(95)'], 100*d.get('http_req_failed',{}).get('value',0)))
")
  echo "$row" >> "$CSV"
  log "trial $i/$N: $row"
done

log "wrote $CSV"
column -t -s, "$CSV"
