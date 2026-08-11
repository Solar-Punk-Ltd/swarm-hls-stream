#!/bin/bash
# Do chunks somebody already pulled tonight come back faster for the next viewer?
#
# ## Why this was not answerable until today
#
# The obvious design is "walk a list, wait, walk it again, a speedup is the network warming". It was
# never available here, because our own gateway was caching the whole time: `--cache-capacity=0` gates
# nothing, and `--cache-retrieval` was left at its default of true in every deployment this project ever
# measured. Any pass-2 gain was our own disk. With the flag now proven to separate in both directions on
# this node, a gain measured with it off is somebody else's cache, which is the thing worth knowing:
# it decides whether the tenth viewer of a broadcast has an easier time than the first.
#
# ## The control is a split list, not a second list
#
# Both arms are drawn from **one** reference file, `refs.txt`, so they share an era, a producer and a
# size distribution. Tonight's sittings walked its first 400 entries roughly six times over; entries
# 401-800 were never touched. That makes "warmed" and "cold" a matched pair rather than two lists whose
# intrinsic difficulty nobody checked. Comparing two different files would have confounded network state
# with whatever else differs between them, which is the mistake this design exists to avoid.
#
# Arms are interleaved and unfunded, so the sitting is **free** and running order cannot masquerade as
# the effect.
#
# ⚠️ What it cannot say: which node did the retaining, or for how long. A positive result means the
# network held something for hours; it does not locate it or promise it survives a day.
set -u

STACK_DIR="${STACK_DIR:-/home/solarpunk/swarm-hls-stream-latbench}"
ENV_FILE="${STACK_DIR}/.env"
PROBE="${PROBE:-/home/solarpunk/phase06/retrieval-debt-probe.sh}"
PHASE06="${PHASE06:-/home/solarpunk/phase06}"
RUN_DIR="${RUN_DIR:-/home/solarpunk/retrieval-probe/warmup-$(date +%Y%m%d-%H%M%S)}"
LOG="${RUN_DIR}/warmup.log"
CONTAINER="${CONTAINER:-latbench-bee-gateway-1}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-10077}"
RETRIEVAL_KEY=BEE_GATEWAY_CACHE_RETRIEVAL

# The half that tonight's sittings walked, and the half they never reached. SEGMENTS stays under 400 so
# neither arm runs off the end of its half.
WARMED_FROM=1
WARMED_TO=400
COLD_FROM=401
COLD_TO=800
SEGMENTS="${SEGMENTS:-350}"
ROUNDS="${ROUNDS:-4}"

# Set when this run is chained behind another: it waits for that marker before touching the gateway, so
# two sittings never share a node.
WAIT_FOR_FILE="${WAIT_FOR_FILE:-}"
WAIT_FOR_MARKER="${WAIT_FOR_MARKER:-=== done,}"
WAIT_TIMEOUT_S="${WAIT_TIMEOUT_S:-21600}"

mkdir -p "${RUN_DIR}"
say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "${LOG}"; }

if [ -n "${WAIT_FOR_FILE}" ]; then
  say "waiting for ${WAIT_FOR_FILE} to report '${WAIT_FOR_MARKER}'"
  waited=0
  while [ "${waited}" -lt "${WAIT_TIMEOUT_S}" ]; do
    grep -q -- "${WAIT_FOR_MARKER}" "${WAIT_FOR_FILE}" 2>/dev/null && break
    sleep 60
    waited=$((waited + 60))
  done
  if ! grep -q -- "${WAIT_FOR_MARKER}" "${WAIT_FOR_FILE}" 2>/dev/null; then
    say "⛔ the run ahead never finished within ${WAIT_TIMEOUT_S}s, refusing to start on a busy node"
    exit 1
  fi
  say "the run ahead is done, starting after a two-minute settle"
  sleep 120
fi

sed -n "${WARMED_FROM},${WARMED_TO}p" "${PHASE06}/refs.txt" >"${PHASE06}/refs-warmed.txt"
sed -n "${COLD_FROM},${COLD_TO}p" "${PHASE06}/refs.txt" >"${PHASE06}/refs-cold.txt"
say "warmed half: $(wc -l <"${PHASE06}/refs-warmed.txt") refs, cold half: $(wc -l <"${PHASE06}/refs-cold.txt") refs"

if grep -q "^${RETRIEVAL_KEY}=" "${ENV_FILE}"; then
  WAS_PRESENT=1
  BASELINE="$(grep "^${RETRIEVAL_KEY}=" "${ENV_FILE}" | cut -d= -f2)"
else
  WAS_PRESENT=0
  BASELINE=""
fi

recreate_gateway() {
  (
    cd "${STACK_DIR}/deploy" || exit 1
    BEE_GATEWAY_API_PORT="${GATEWAY_BEE_PORT}" \
      BEE_GATEWAY_P2P_PORT="$((GATEWAY_BEE_PORT + 1))" \
      docker compose -p latbench \
      -f docker-compose.yml -f docker-compose.host.yml -f docker-compose.nat.yml \
      --env-file "${ENV_FILE}" --profile bee-gateway \
      up -d --no-deps --force-recreate bee-gateway
  ) >>"${LOG}" 2>&1
  local waited=0
  while [ "${waited}" -lt 180 ]; do
    curl -s -m 5 "http://127.0.0.1:${GATEWAY_BEE_PORT}/health" | grep -q '"status":"ok"' && return 0
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

set_retrieval() {
  local value="$1"
  if grep -q "^${RETRIEVAL_KEY}=" "${ENV_FILE}"; then
    sed -i "s/^${RETRIEVAL_KEY}=.*/${RETRIEVAL_KEY}=${value}/" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${RETRIEVAL_KEY}" "${value}" >>"${ENV_FILE}"
  fi
  recreate_gateway || { say "⛔ gateway did not come back"; return 1; }
  local args
  args="$(docker inspect --format '{{join .Args " "}}' "${CONTAINER}" 2>/dev/null)"
  case "${args}" in
    *"--cache-retrieval=${value} "* | *"--cache-retrieval=${value}") return 0 ;;
  esac
  say "⛔ the node is not running --cache-retrieval=${value}"
  return 1
}

restore() {
  say "restoring ${RETRIEVAL_KEY}"
  if [ "${WAS_PRESENT}" = "1" ]; then
    sed -i "s/^${RETRIEVAL_KEY}=.*/${RETRIEVAL_KEY}=${BASELINE}/" "${ENV_FILE}"
  else
    sed -i "/^${RETRIEVAL_KEY}=/d" "${ENV_FILE}"
  fi
  recreate_gateway
  say "left at: $(docker inspect --format '{{join .Args " "}}' "${CONTAINER}" 2>/dev/null | tr ' ' '\n' | grep -E 'cache|swap' | tr '\n' ' ')"
}
trap restore EXIT

say "=== does the network warm up? all arms unfunded, no spend possible ==="
set_retrieval false || exit 1

say "--- canary: the same list twice on one node, caching off ---"
mkdir -p "${RUN_DIR}/canary"
OUT_DIR="${RUN_DIR}/canary" SEGMENTS=150 ROUNDS=1 FORCE_RECREATE=0 \
  ARM_PLAN='C1:false:0 C2:false:0' bash "${PROBE}" >>"${LOG}" 2>&1
C1="$(awk -F'\t' '$2=="C1"{print $17; exit}' "${RUN_DIR}/canary/probe-state.tsv")"
C2="$(awk -F'\t' '$2=="C2"{print $17; exit}' "${RUN_DIR}/canary/probe-state.tsv")"
if [ -z "${C1:-}" ] || [ -z "${C2:-}" ] || [ "${C1}" -eq 0 ] || [ "$((C2 * 100 / C1))" -lt 60 ]; then
  say "⛔ STOPPING: canary gave ${C1:-?}ms then ${C2:-?}ms, so something is still caching locally"
  exit 2
fi
say "✅ control holds: ${C1}ms then ${C2}ms"

say "--- ${ROUNDS} interleaved rounds, warmed half against cold half ---"
mkdir -p "${RUN_DIR}/arms"
OUT_DIR="${RUN_DIR}/arms" SEGMENTS="${SEGMENTS}" ROUNDS="${ROUNDS}" FORCE_RECREATE=1 \
  ARM_PLAN='WARM:false:0:0:1:0:1:0:warmed:267 COLD:false:0:0:1:0:1:0:cold:267' \
  bash "${PROBE}" >>"${LOG}" 2>&1 || say "⚠️ exited non-zero, read the state file before believing it"

say "results:"
awk -F'\t' 'NR>1{printf "  r%s %-5s median %sms p90 %sms late %s%%\n",$1,$2,$17,$18,$19}' \
  "${RUN_DIR}/arms/probe-state.tsv" 2>/dev/null | tee -a "${LOG}"
awk -F'\t' 'NR>1{n[$2]++; s[$2]+=$17} END{for(a in s) printf "  %s mean median %.1fms over %d rounds\n",a,s[a]/n[a],n[a]}' \
  "${RUN_DIR}/arms/probe-state.tsv" 2>/dev/null | tee -a "${LOG}"
say "WARM materially below COLD means the network retained something. Equal means it did not."
say "=== done, ${RUN_DIR} ==="
