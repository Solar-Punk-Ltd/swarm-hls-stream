# shellcheck shell=bash
#
# Sourced, never executed, so it carries a shell directive instead of a shebang.
#
# Read what the bee nodes themselves say they did, either side of every measurement, and stop the
# sitting when one of them crosses a floor.
#
# ⛔⛔⛔ THIS IS NOT DECORATION ON A RESULT.
#
# Seventeen arms of a funded buffer sweep were scored entirely on what the harness saw from outside
# while both nodes kept a complete account of the same events that nothing ever read. The node
# publishes 272 metric families. `bee_pusher_sync_time` IS the publish race measured from the outside
# with a stopwatch. `bee_retrieval_*` IS the fetch hop. A sitting that does not read them is guessing
# at a cause the instrument was already recording.
#
# ⛔⛔ The counters are LIFETIME totals. One reading is worthless. Two readings differenced are the
# window, which is why every caller brackets rather than samples, and why an unpaired reading is a
# defect rather than a partial result.
#
# ## Why it is shared rather than copied
#
# `viewer-arms.sh` grew this first and `sweep-interleaved.sh` needed the same four functions. The
# burn rate in this same directory was wrong in three scripts at once because it was corrected where
# somebody was looking and left everywhere else, so `deploy/test/metricsBracket.test.js` refuses a
# second definition of any of these.
#
# ## What the caller owes it
#
# The same contract `capacity-gate.sh` states, and for the same reason: these drivers run `set -u`
# without `set -e`, so an incomplete caller is refused here rather than four hundred lines later.
declare -F say > /dev/null 2>&1 || {
  echo "metrics-bracket.sh: source me after the caller's say(), so a failed reading is reported" >&2
  exit 1
}
: "${LOG:?metrics-bracket.sh needs LOG, the file it reports into}"
# ⚠️ No apostrophes in these messages. Bash parses quotes inside a `${var:?word}` word even within
# double quotes, so one unmatched `'` opens a string that swallows the rest of the file.
: "${OUT_DIR:?metrics-bracket.sh needs OUT_DIR, the directory this sitting writes into}"

METRICS_BRACKET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_METRICS="${NODE_METRICS:-${METRICS_BRACKET_DIR}/node-metrics.sh}"

# Ports the collector reads. Origins from `apply_port_slot` in `_lib.sh`, resolved here so a driver
# that only ever wanted a bracket does not have to know them.
PORT_SLOT="${PORT_SLOT:-7}"
UPLOADER_BEE_PORT="${UPLOADER_BEE_PORT:-$((10005 + PORT_SLOT * 10))}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-$((10007 + PORT_SLOT * 10))}"
UPLOADER_API_PORT="${UPLOADER_API_PORT:-$((10000 + PORT_SLOT * 10))}"

# Zero means endpoints only. Set it above zero for a measurement long enough to need a series rather
# than two readings, which is also the only mid-flight funding check a single continuous run gets.
METRICS_INTERVAL_S="${METRICS_INTERVAL_S:-0}"

METRICS_DIR="${METRICS_DIR:-${OUT_DIR}/node-metrics}"

# Written by the sampler when a floor is crossed, read by the driver and by whatever runs next.
# ⭐ Its presence is the record of WHEN a sitting stopped being trustworthy, which two endpoint
# readings cannot show and which no amount of care after the fact can reconstruct.
#
# ⛔ Beside OUT_DIR rather than inside METRICS_DIR, because it is a fact about the sitting and not a
# reading. `overnight-chain.sh` points every sitting of a night at one shared file, which is what
# makes a crossed floor stop the night rather than one sitting: the node does not refill between them.
STOP_FILE="${STOP_FILE:-${OUT_DIR}/STOP}"

mkdir -p "${METRICS_DIR}"

snapshot_metrics() {
  local out="$1" label="$2"
  UPLOADER_BEE_PORT="${UPLOADER_BEE_PORT}" GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT}" \
    UPLOADER_API_PORT="${UPLOADER_API_PORT}" bash "${NODE_METRICS}" snapshot "${out}" "${label}" \
    >> "${LOG}" 2>&1 || say "  node-metrics snapshot ${label} failed, so this has no node account"
}

# The difference between two readings, filed beside them and echoed into the log, because a sitting
# nobody diffs is a sitting whose two readings are a pair of lifetime totals.
diff_metrics() {
  local before="$1" after="$2" out="$3" headline="$4"
  bash "${NODE_METRICS}" diff "${before}" "${after}" > "${out}" 2>> "${LOG}" || true
  say "${headline}"
  sed 's/^/    /' "${out}" >> "${LOG}" 2>/dev/null || true
}

SAMPLER_PID=""

start_sampler() {
  local dir="$1" label="$2"
  [ "${METRICS_INTERVAL_S}" -gt 0 ] 2>/dev/null || return 0
  mkdir -p "${dir}"
  # ⛔ STAMP is passed because the sampler's capacity floor applies to the batch this sitting writes
  # to and to no other. /stamps lists every batch the node ever bought, and one of them here is dead.
  UPLOADER_BEE_PORT="${UPLOADER_BEE_PORT}" GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT}" \
    UPLOADER_API_PORT="${UPLOADER_API_PORT}" STAMP="$(resolve_stamp)" bash "${NODE_METRICS}" \
    watch "${dir}" "${METRICS_INTERVAL_S}" "${STOP_FILE}" "${label}" >> "${LOG}" 2>&1 &
  SAMPLER_PID=$!
  say "  sampling both nodes every ${METRICS_INTERVAL_S}s into $(basename "${dir}")"
}

stop_sampler() {
  [ -n "${SAMPLER_PID}" ] || return 0
  kill "${SAMPLER_PID}" 2>/dev/null || true
  wait "${SAMPLER_PID}" 2>/dev/null || true
  SAMPLER_PID=""
}
