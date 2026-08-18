#!/bin/bash
# Which quality profile an UNFUNDED gateway can actually hold, and whether it decays over hours.
#
# ## Why this run is worth a night and costs nothing
#
# The product question is which quality a viewer can be given when their gateway has no chequebook,
# because that is the viewer we cannot control. The first attempt at it on 2026-08-10 produced three
# readings and three corrections, and was finally thrown away entirely: its arms were measured with the
# retrieval cache on, because `--cache-capacity=0` never disabled anything. `--cache-retrieval` is the
# flag that does, and it has since been shown to separate cleanly in both directions on this node.
#
# Every arm here is unfunded, so **the whole run is free**: a node with no chequebook cannot spend.
#
# ## Phase A, the profile comparison
#
# Three profiles interleaved, each scored against **its own** segment duration, because a 0.25 s
# fragment and a 1.0 s fragment do not share a deadline and comparing them on one budget answers
# nothing. Interleaved rather than blocked, because the first sitting's arms fell 18.9 -> 10.4 -> 3.4 ->
# 1.8% straight down the running order, which is the cold-gateway penalty and not the profile.
#
# ## Phase B, the soak
#
# The same profile held for hours on ONE continuous node, deliberately not recreated between arms. The
# comparison is round 1 against round 20: an unfunded node that degrades as it accumulates debt is a
# different product risk from one that is merely slower, and nothing here has ever run long enough to
# tell them apart.
#
# ⛔ Bounded by a host that carries forty other bee nodes. One viewer per arm, and the probe's own load
# ceiling stops the run if the box gets busy.
set -u

STACK_DIR="${STACK_DIR:-/home/solarpunk/swarm-hls-stream-latbench}"
ENV_FILE="${STACK_DIR}/.env"
PROBE="${PROBE:-/home/solarpunk/phase06/retrieval-debt-probe.sh}"
RUN_DIR="${RUN_DIR:-/home/solarpunk/retrieval-probe/goldenzone2-$(date -u +%Y%m%d-%H%M%S)}"
LOG="${RUN_DIR}/overnight.log"
CONTAINER="${CONTAINER:-latbench-bee-gateway-1}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-10077}"
RETRIEVAL_KEY=BEE_GATEWAY_CACHE_RETRIEVAL

PROFILE_SEGMENTS="${PROFILE_SEGMENTS:-400}"
PROFILE_ROUNDS="${PROFILE_ROUNDS:-5}"
SOAK_SEGMENTS="${SOAK_SEGMENTS:-500}"
SOAK_ROUNDS="${SOAK_ROUNDS:-20}"
CANARY_MIN_RATIO_PCT="${CANARY_MIN_RATIO_PCT:-60}"

mkdir -p "${RUN_DIR}"
say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "${LOG}"; }

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

say "=== overnight golden zone, all arms unfunded, no spend possible ==="
set_retrieval false || exit 1

# The one-line check that would have caught the cache defect on day one. Unfunded and 150 references, so
# it costs nothing and takes about a minute, and a sitting whose control fails is worse than no sitting.
say "--- canary: the same list twice on one node, caching off ---"
mkdir -p "${RUN_DIR}/canary"
OUT_DIR="${RUN_DIR}/canary" SEGMENTS=150 ROUNDS=1 FORCE_RECREATE=0 \
  ARM_PLAN='C1:false:0 C2:false:0' bash "${PROBE}" >>"${LOG}" 2>&1
C1="$(awk -F'\t' '$2=="C1"{print $17; exit}' "${RUN_DIR}/canary/probe-state.tsv")"
C2="$(awk -F'\t' '$2=="C2"{print $17; exit}' "${RUN_DIR}/canary/probe-state.tsv")"
if [ -z "${C1:-}" ] || [ -z "${C2:-}" ] || [ "${C1}" -eq 0 ]; then
  say "⛔ the canary produced no median, stopping"
  exit 1
fi
say "canary: ${C1}ms then ${C2}ms, second is $((C2 * 100 / C1))% of first"
if [ "$((C2 * 100 / C1))" -lt "${CANARY_MIN_RATIO_PCT}" ]; then
  say "⛔ STOPPING: something is still caching, so nothing measured after this would mean anything"
  exit 2
fi
say "✅ control holds"

# ⭐ The tenth field is each arm's own budget in ms, which is what lets profiles of different segment
# lengths be interleaved and still scored honestly. 0.25s at 267ms, 1.0s at 1000ms.
say "--- phase A: ${PROFILE_ROUNDS} interleaved rounds of three profiles ---"
mkdir -p "${RUN_DIR}/phaseA-profiles"
OUT_DIR="${RUN_DIR}/phaseA-profiles" SEGMENTS="${PROFILE_SEGMENTS}" ROUNDS="${PROFILE_ROUNDS}" \
  FORCE_RECREATE=1 \
  ARM_PLAN='S720:false:0:0:1:0:1:0:g025-720p:267 M720:false:0:0:1:0:1:0:g1-720p:1000 M480:false:0:0:1:0:1:0:g1-480p:1000' \
  bash "${PROBE}" >>"${LOG}" 2>&1 || say "⚠️ phase A exited non-zero, read the state file before believing it"
say "phase A arms:"
awk -F'\t' 'NR>1{printf "  r%s %-5s %s refs, median %sms p90 %sms, late %s%% of %sms\n",$1,$2,$10,$17,$18,$19,$11}' \
  "${RUN_DIR}/phaseA-profiles/probe-state.tsv" 2>/dev/null | tee -a "${LOG}"

# FORCE_RECREATE stays 0 here on purpose: a soak is about one node held for hours, and recreating it
# between arms would reset the very debt the soak exists to observe.
say "--- phase B: ${SOAK_ROUNDS} rounds on one continuous unfunded node ---"
mkdir -p "${RUN_DIR}/phaseB-soak"
OUT_DIR="${RUN_DIR}/phaseB-soak" SEGMENTS="${SOAK_SEGMENTS}" ROUNDS="${SOAK_ROUNDS}" \
  FORCE_RECREATE=0 ARM_PLAN='SOAK:false:0:0:1:0:1:0:g1-720p:1000' \
  bash "${PROBE}" >>"${LOG}" 2>&1 || say "⚠️ phase B exited non-zero, read the state file before believing it"
say "phase B rounds:"
awk -F'\t' 'NR>1{printf "  r%-3s median %sms p90 %sms, late %s%%\n",$1,$17,$18,$19}' \
  "${RUN_DIR}/phaseB-soak/probe-state.tsv" 2>/dev/null | tee -a "${LOG}"

say "=== done, ${RUN_DIR} ==="
