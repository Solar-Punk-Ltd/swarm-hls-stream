#!/usr/bin/env bash
#
# Collect what the bee nodes say they did, either side of a measurement.
#
# The arithmetic lives in `node_metrics.py` beside this, and the split is deliberate rather than
# tidiness: collection needs the host's network and nothing else, differencing needs neither, and
# inline Python inside shell quoting cannot carry an f-string containing quotes. Two attempts at
# keeping it in one file died on exactly that.
#
# Read `node_metrics.py` for what the numbers mean and why they are differenced rather than read once.
#
# Usage:
#   node-metrics.sh snapshot <out.json> [label]
#   node-metrics.sh diff <before.json> <after.json>
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPLOADER_PORT="${UPLOADER_BEE_PORT:-10075}"
GATEWAY_PORT="${GATEWAY_BEE_PORT:-10077}"
UPLOADER_API_PORT="${UPLOADER_API_PORT:-10070}"

# By family rather than by name, so an analysis nobody has thought of yet is not blocked on having
# named its metric today. Histogram buckets are dropped: they are many, and the sum and count carry
# the mean, which is what a sitting compares.
FAMILIES='^bee_(pusher|pushsync|retrieval|localstore|salud|kademlia|postage|batchstore|accounting|swap|pullsync|hive|reacher)_'

get() { curl -s --max-time 20 "$1" 2>/dev/null || true; }

case "${1:-}" in
  snapshot)
    [ $# -ge 2 ] || { echo "usage: node-metrics.sh snapshot <out.json> [label]" >&2; exit 2; }
    # Collected into shell variables first. An assignment written after the command is an argument to
    # it, not an environment for it, which is how the first version handed python an empty LABEL.
    LABEL="${3:-}"
    LOAD="$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '')"
    UP="$(get "http://127.0.0.1:${UPLOADER_PORT}/metrics" | grep -E "${FAMILIES}" | grep -v '_bucket')"
    GW="$(get "http://127.0.0.1:${GATEWAY_PORT}/metrics" | grep -E "${FAMILIES}" | grep -v '_bucket')"
    STAMPS="$(get "http://127.0.0.1:${UPLOADER_PORT}/stamps")"
    HEALTH="$(get "http://127.0.0.1:${UPLOADER_API_PORT}/health")"
    CHQ_UP="$(get "http://127.0.0.1:${UPLOADER_PORT}/chequebook/balance")"
    CHQ_GW="$(get "http://127.0.0.1:${GATEWAY_PORT}/chequebook/balance")"

    LABEL="${LABEL}" LOAD="${LOAD}" UP="${UP}" GW="${GW}" STAMPS="${STAMPS}" HEALTH="${HEALTH}" \
      CHQ_UP="${CHQ_UP}" CHQ_GW="${CHQ_GW}" python3 -c '
import json, os, sys, time
sys.stdout.write(json.dumps({
    "label": os.environ["LABEL"],
    "atMs": int(time.time() * 1000),
    "hostLoad": os.environ["LOAD"],
    "uploaderMetrics": os.environ["UP"],
    "gatewayMetrics": os.environ["GW"],
    "stamps": os.environ["STAMPS"],
    "health": os.environ["HEALTH"],
    "chequebookUploader": os.environ["CHQ_UP"],
    "chequebookGateway": os.environ["CHQ_GW"],
}))' | python3 "${HERE}/node_metrics.py" build > "$2"
    echo "node-metrics: wrote $2"
    ;;
  diff)
    [ $# -ge 3 ] || { echo "usage: node-metrics.sh diff <before.json> <after.json>" >&2; exit 2; }
    python3 "${HERE}/node_metrics.py" diff "$2" "$3"
    ;;
  *)
    echo "usage: node-metrics.sh snapshot <out.json> [label] | diff <before.json> <after.json>" >&2
    exit 2
    ;;
esac
