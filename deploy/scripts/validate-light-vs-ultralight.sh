#!/bin/bash
# Light vs ultra-light, re-measured with the gateway's retrieval cache genuinely disabled.
#
# ## Why this run exists
#
# Every arm this project ever labelled "cache off" set `--cache-capacity=0` and nothing else. Bee gates
# forwarded-content caching on a separate flag, `--cache-retrieval`, which defaults to true and which
# the compose never set. Measured on this node on 2026-08-10: with capacity 0 alone, a second walk of
# the same 500 references ran at a 4ms median against 121ms for the first walk; with
# `--cache-retrieval=false` added, the same second walk cost 124ms against 123ms.
#
# The funded-versus-unfunded result rests on six arms sharing one reference list, and the probe's
# `set_arm` skips the container recreate when the swap setting is unchanged, so an all-unfunded plan was
# measured on one continuous node. That does not make the old result wrong. It makes it unestablished,
# which is what this run exists to fix.
#
# ## Both controls are measured, neither is assumed
#
# Phase 1 walks one list twice on a node deliberately NOT recreated in between, with caching off, and
# requires the second walk to cost what the first did. Phase 3 repeats it with caching on and requires
# the second walk to be dramatically cheaper. A negative control that only ever fires one way cannot
# distinguish "the flag works" from "the walk was slow twice", so the pair is the instrument and a
# failure of either voids the sitting.
#
# Phase 1 and phase 3 are unfunded, so they cost nothing. Phase 2's unfunded arms cost nothing either,
# because a node with no chequebook cannot spend. Only the three funded arms draw on the gateway, at
# roughly 0.00068 BZZ per MB.
#
# ## What this cannot say
#
# These are archived segments rather than the live edge, so the transfer times are not viewer latency
# and must not be quoted as it. They are comparable to each other, arm against arm, on the same
# references in the same order.
set -u

STACK_DIR="${STACK_DIR:-/home/solarpunk/swarm-hls-stream-latbench}"
ENV_FILE="${STACK_DIR}/.env"
PROBE="${PROBE:-/home/solarpunk/phase06/retrieval-debt-probe.sh}"
BASE="${BASE:-/home/solarpunk/retrieval-probe}"
RUN_ID="${RUN_ID:-validate-$(date +%Y%m%d-%H%M%S)}"
RUN_DIR="${BASE}/${RUN_ID}"
LOG="${RUN_DIR}/driver.log"
CONTAINER="${CONTAINER:-latbench-bee-gateway-1}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-10077}"

RETRIEVAL_KEY=BEE_GATEWAY_CACHE_RETRIEVAL

# Segments per arm. 400 separates the arms comfortably: the result under test is 0.3% late against 15%,
# which is 1 segment against 60.
CANARY_SEGMENTS="${CANARY_SEGMENTS:-150}"
SITTING_SEGMENTS="${SITTING_SEGMENTS:-400}"
SITTING_ROUNDS="${SITTING_ROUNDS:-3}"

# A repeat walk that costs at least this fraction of the first is being served from the network rather
# than from local storage. The measured pair was 101% with caching off and 3% with it on, so anything
# between these two thresholds is an unreadable result and stops the run rather than being rounded.
CACHE_OFF_MIN_RATIO_PCT="${CACHE_OFF_MIN_RATIO_PCT:-60}"
CACHE_ON_MAX_RATIO_PCT="${CACHE_ON_MAX_RATIO_PCT:-25}"

mkdir -p "${RUN_DIR}"

say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "${LOG}"; }

# Whether the key was in the file at all, because putting it back at bee's default is still a change to
# a file this script does not own.
if grep -q "^${RETRIEVAL_KEY}=" "${ENV_FILE}"; then
  RETRIEVAL_WAS_PRESENT=1
  RETRIEVAL_BASELINE="$(grep "^${RETRIEVAL_KEY}=" "${ENV_FILE}" | cut -d= -f2)"
else
  RETRIEVAL_WAS_PRESENT=0
  RETRIEVAL_BASELINE=""
fi

# The same invocation the probe uses, overlay files and profile included. A gateway recreated with a
# different compose command is a different gateway, and the difference would land inside the arms.
recreate_gateway() {
  (
    cd "${STACK_DIR}/deploy" || exit 1
    BEE_GATEWAY_API_PORT="${GATEWAY_BEE_PORT}" \
      BEE_GATEWAY_P2P_PORT="$((GATEWAY_BEE_PORT + 1))" \
      docker compose -p latbench \
      -f docker-compose.yml -f docker-compose.host.yml -f docker-compose.nat.yml \
      --env-file "${ENV_FILE}" \
      --profile bee-gateway \
      up -d --no-deps --force-recreate bee-gateway
  ) >>"${LOG}" 2>&1
}

wait_for_gateway_api() {
  local waited=0
  while [ "${waited}" -lt 180 ]; do
    curl -s -m 5 "http://127.0.0.1:${GATEWAY_BEE_PORT}/health" | grep -q '"status":"ok"' && return 0
    sleep 3
    waited=$((waited + 3))
  done
  say "⛔ the gateway API did not come back within ${waited}s"
  return 1
}

set_retrieval() {
  local value="$1"
  if grep -q "^${RETRIEVAL_KEY}=" "${ENV_FILE}"; then
    sed -i "s/^${RETRIEVAL_KEY}=.*/${RETRIEVAL_KEY}=${value}/" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${RETRIEVAL_KEY}" "${value}" >>"${ENV_FILE}"
  fi
  recreate_gateway
  wait_for_gateway_api || return 1
  retrieval_confirmed_on_node "${value}"
}

# Read off the running container rather than off the env file, because the whole defect this run exists
# to correct was a setting that was believed from the file it was written to.
retrieval_confirmed_on_node() {
  local want="$1" args
  args="$(docker inspect --format '{{join .Args " "}}' "${CONTAINER}" 2>/dev/null)"
  case "${args}" in
    *"--cache-retrieval=${want} "* | *"--cache-retrieval=${want}") return 0 ;;
  esac
  say "⛔ the node is not running --cache-retrieval=${want}"
  return 1
}

restore_retrieval() {
  say "restoring ${RETRIEVAL_KEY} to its original state"
  if [ "${RETRIEVAL_WAS_PRESENT}" = "1" ]; then
    sed -i "s/^${RETRIEVAL_KEY}=.*/${RETRIEVAL_KEY}=${RETRIEVAL_BASELINE}/" "${ENV_FILE}"
  else
    sed -i "/^${RETRIEVAL_KEY}=/d" "${ENV_FILE}"
  fi
  recreate_gateway
  wait_for_gateway_api
  say "gateway left running: $(docker inspect --format '{{join .Args " "}}' "${CONTAINER}" 2>/dev/null | tr ' ' '\n' | grep -E 'cache|swap' | tr '\n' ' ')"
}
trap restore_retrieval EXIT

median_of() {
  awk -F'\t' -v want="$2" '$2==want{print $17; exit}' "$1"
}

# One canary: the same list walked twice on a node that is not recreated in between, which is where a
# cache would show if it were on. Unfunded, so it costs nothing.
run_canary() {
  local phase="$1" outDir="${RUN_DIR}/$1"
  mkdir -p "${outDir}"
  OUT_DIR="${outDir}" SEGMENTS="${CANARY_SEGMENTS}" ROUNDS=1 FORCE_RECREATE=0 \
    ARM_PLAN='C1:false:0 C2:false:0' bash "${PROBE}" >>"${LOG}" 2>&1
  local first second
  first="$(median_of "${outDir}/probe-state.tsv" C1)"
  second="$(median_of "${outDir}/probe-state.tsv" C2)"
  if [ -z "${first}" ] || [ -z "${second}" ] || [ "${first}" -eq 0 ]; then
    say "⛔ ${phase}: the canary produced no median, so nothing downstream can be trusted"
    return 1
  fi
  CANARY_RATIO_PCT=$((second * 100 / first))
  say "${phase}: first walk ${first}ms, second walk ${second}ms, second is ${CANARY_RATIO_PCT}% of first"
  return 0
}

say "=== ${RUN_ID}: light vs ultra-light with the retrieval cache genuinely off ==="
say "gateway before anything: $(docker inspect --format '{{join .Args " "}}' "${CONTAINER}" | tr ' ' '\n' | grep -E 'cache|swap' | tr '\n' ' ')"

say "--- phase 1: negative control, caching off, the repeat walk must cost what the first did ---"
set_retrieval false || { say "⛔ could not put the node on --cache-retrieval=false"; exit 1; }
run_canary phase1-cache-off || exit 1
if [ "${CANARY_RATIO_PCT}" -lt "${CACHE_OFF_MIN_RATIO_PCT}" ]; then
  say "⛔ STOPPING: a repeat walk at ${CANARY_RATIO_PCT}% of the first is being cached somewhere."
  say "⛔ The control does not hold, so the sitting would produce numbers that only look like results."
  exit 2
fi
say "✅ the cache is genuinely off, the sitting may proceed"

say "--- phase 2: ${SITTING_ROUNDS} interleaved rounds of funded against unfunded ---"
mkdir -p "${RUN_DIR}/phase2-sitting"
OUT_DIR="${RUN_DIR}/phase2-sitting" SEGMENTS="${SITTING_SEGMENTS}" ROUNDS="${SITTING_ROUNDS}" \
  FORCE_RECREATE=1 ARM_PLAN='L:true:0 U:false:0' bash "${PROBE}" >>"${LOG}" 2>&1 ||
  say "⚠️ the sitting exited non-zero, read the state file before believing any of it"

say "--- phase 3: positive control, caching on, the repeat walk must be far cheaper ---"
set_retrieval true || say "⚠️ could not put the node on --cache-retrieval=true"
if run_canary phase3-cache-on; then
  if [ "${CANARY_RATIO_PCT}" -gt "${CACHE_ON_MAX_RATIO_PCT}" ]; then
    say "⚠️ the positive control did not fire: with caching ON a repeat walk still cost"
    say "⚠️ ${CANARY_RATIO_PCT}% of the first. Phase 1 passing may mean the walk is simply slow twice."
  else
    say "✅ both controls fired: the flag moves what it claims to move, in both directions"
  fi
fi

say "=== done, results under ${RUN_DIR} ==="
