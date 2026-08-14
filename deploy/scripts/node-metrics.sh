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
#   node-metrics.sh watch <out_dir> <interval_s> <stop_file> [label]
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPLOADER_PORT="${UPLOADER_BEE_PORT:-10075}"
GATEWAY_PORT="${GATEWAY_BEE_PORT:-10077}"
UPLOADER_API_PORT="${UPLOADER_API_PORT:-10070}"

# What `watch` refuses to keep running past. The reserve is per node and is not a budget: it is the
# distance from the point where peers start refusing service to a node that cannot pay, which was
# measured at zero and looks from outside exactly like the network being slow.
RESERVE_PLUR="${RESERVE_PLUR:-5000000000000000}"
MAX_UTILIZATION_PCT="${MAX_UTILIZATION_PCT:-75}"

# ⛔⛔⛔ NO FAMILY ALLOWLIST. THIS USED TO HAVE ONE AND IT WAS THE DEFECT.
#
# Thirteen families were kept, on the reasoning that an analysis nobody has thought of yet should not
# be blocked on having named its metric today. Measured against the live nodes on 2026-08-14 that
# kept 255 of 1032 non-bucket lines and 13 of 239 families. Never captured, in any snapshot this
# project has taken: every `go_*` and `process_*` series, so the node's own CPU, memory, goroutines
# and file descriptors; `bee_p2p_*` and `bee_libp2p_*`, so connection churn; `bee_api_*`, so the
# request surface a client hits; `bee_blocker_*`, so peers being blocklisted; and `bee_topology_*`,
# `bee_chunk_*`, `bee_storage_*`, `bee_stamp_*`, `bee_settlement_*`, `bee_chequebook_*`.
#
# ⭐⭐⭐ Grepping for the subsystem you think you are measuring is how you publish a number with the
# wrong cause. On 2026-08-12 a publishing ceiling was measured over a full day off `bee_pusher_*` and
# attributed to protocol overhead, while `bee_pushsync_overdraft_refresh`,
# `bee_accounting_payment_error_count` and `bee_swap_available_balance` sat in the same HTTP response
# saying the chequebook was 99.9999% drained and 67% of pushes were blocking on a payment allowance.
# Two of those three families were then added to the allowlist. The allowlist itself was the defect,
# and the whole surface costs 64 KB a node against the 16 KB the slice cost.
#
# ⚠️ `_bucket` rows are still dropped. That is a stated exclusion rather than a subsystem choice: the
# sum and count carry the mean a sitting compares, the edges are fixed configuration, and they are
# 45% of the bytes.
get() { curl -s --max-time 20 "$1" 2>/dev/null || true; }

snapshot_to() {
  # Collected into shell variables first. An assignment written after the command is an argument to
  # it, not an environment for it, which is how the first version handed python an empty LABEL.
  local out="$1" LABEL="${2:-}" LOAD UP GW STAMPS HEALTH CHQ_UP CHQ_GW
  LOAD="$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '')"
  UP="$(get "http://127.0.0.1:${UPLOADER_PORT}/metrics" | grep -v '_bucket')"
  GW="$(get "http://127.0.0.1:${GATEWAY_PORT}/metrics" | grep -v '_bucket')"
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
}))' | python3 "${HERE}/node_metrics.py" build > "${out}"
}

case "${1:-}" in
  snapshot)
    [ $# -ge 2 ] || { echo "usage: node-metrics.sh snapshot <out.json> [label]" >&2; exit 2; }
    snapshot_to "$2" "${3:-}"
    echo "node-metrics: wrote $2"
    ;;
  diff)
    [ $# -ge 3 ] || { echo "usage: node-metrics.sh diff <before.json> <after.json>" >&2; exit 2; }
    python3 "${HERE}/node_metrics.py" diff "$2" "$3"
    ;;
  # Every series that moved, ranked, rather than the ones a renderer was taught to name. `diff` above
  # can only ever confirm or deny a cause that is already on its list.
  diff-all)
    [ $# -ge 3 ] || { echo "usage: node-metrics.sh diff-all <before.json> <after.json>" >&2; exit 2; }
    python3 "${HERE}/node_metrics.py" diff-all "$2" "$3"
    ;;
  # A time series through a long arm, and the only funding check a single continuous broadcast gets
  # after minute zero.
  #
  # ⛔ `can_afford` runs once per arm, so a sitting whose arm IS the sitting is checked once and then
  # left alone for as long as it lasts. Four hours is long enough to empty a chequebook that was
  # comfortable at the start, and the last hour of that run would be a measurement of what peers do
  # to a node that cannot pay. Writing the stop file is what makes the run cut itself off instead.
  watch)
    [ $# -ge 4 ] || { echo "usage: node-metrics.sh watch <out_dir> <interval_s> <stop_file> [label]" >&2; exit 2; }
    OUT_DIR="$2"; INTERVAL_S="$3"; STOP_FILE="$4"; WATCH_LABEL="${5:-sample}"
    mkdir -p "${OUT_DIR}"
    n=0
    while :; do
      n=$((n + 1))
      SAMPLE="$(printf '%s/sample-%04d.json' "${OUT_DIR}" "${n}")"
      snapshot_to "${SAMPLE}" "${WATCH_LABEL}-${n}"
      if ! REASONS="$(python3 "${HERE}/node_metrics.py" floors "${SAMPLE}" "${RESERVE_PLUR}" "${MAX_UTILIZATION_PCT}" "${STAMP:-}")"; then
        {
          printf 'node-metrics: STOPPING at sample %d, %s\n' "${n}" "$(date -u +%FT%TZ)"
          printf '%s\n' "${REASONS}"
        } > "${STOP_FILE}"
        cat "${STOP_FILE}" >&2
        exit 1
      fi
      sleep "${INTERVAL_S}"
    done
    ;;
  *)
    echo "usage: node-metrics.sh snapshot <out.json> [label] | diff <before.json> <after.json>" >&2
    echo "       node-metrics.sh watch <out_dir> <interval_s> <stop_file> [label]" >&2
    exit 2
    ;;
esac
