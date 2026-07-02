#!/usr/bin/env bash
# Measure client-observed end-to-end latency at an entry service, optionally
# under a NetworkChaos delay. Reports k6's http_req_duration (med/avg/p95).
#
# Usage:
#   ENTRY_DEPLOY=shop ENTRY_PORT=3001 LABEL=chain-delay \
#     CHAOS_FILE=chaos/latency-delay-services.yaml metrics/measure-latency.sh
#   (omit CHAOS_FILE to measure without delay)
set -euo pipefail
ENTRY_DEPLOY="${ENTRY_DEPLOY:?set ENTRY_DEPLOY}"
ENTRY_PORT="${ENTRY_PORT:?set ENTRY_PORT}"
LABEL="${LABEL:-lat}"
DUR="${DUR:-60}"
RATE="${RATE:-20}"
CHAOS_FILE="${CHAOS_FILE:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -n "$CHAOS_FILE" ] && [ ! -f "$CHAOS_FILE" ] && CHAOS_FILE="$ROOT/$CHAOS_FILE"

PIDS=()
cleanup() {
  [ -n "$CHAOS_FILE" ] && kubectl delete -f "$CHAOS_FILE" --ignore-not-found >/dev/null 2>&1 || true
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

if [ -n "$CHAOS_FILE" ]; then
  kubectl apply -f "$CHAOS_FILE" >/dev/null
  echo "[lat] applied $CHAOS_FILE; waiting 8s to take effect"; sleep 8
fi
kubectl port-forward "deploy/${ENTRY_DEPLOY}" "${ENTRY_PORT}:${ENTRY_PORT}" >/tmp/${LABEL}-pf.log 2>&1 &
PIDS+=($!); sleep 3

echo "[lat] k6 ${RATE} req/s for ${DUR}s -> ${ENTRY_DEPLOY}:${ENTRY_PORT}"
TARGET_URL="http://localhost:${ENTRY_PORT}" RATE=$RATE DURATION=${DUR}s \
  k6 run "$ROOT/load-tests/dist/experiment1-sustained.js" \
  --summary-export "$ROOT/results/${LABEL}-k6.json" >/tmp/${LABEL}-k6.log 2>&1

python3 -c "
import json
d=json.load(open('$ROOT/results/${LABEL}-k6.json'))['metrics']
h=d['http_req_duration']; f=d.get('http_req_failed',{})
print('[$LABEL] http_req_duration: med=%.1fms  avg=%.1fms  p95=%.1fms  (failed=%s%%)'
      % (h['med'], h['avg'], h['p(95)'], round(100*f.get('value',0),1)))
"
