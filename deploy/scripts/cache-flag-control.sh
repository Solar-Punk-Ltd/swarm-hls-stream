#!/bin/bash
# Does `--cache-retrieval` move what it claims to move, on a FUNDED node, in both directions?
#
# ## Why this exists separately from the validation run
#
# The validation sitting's canaries were run unfunded, because an unfunded node cannot spend and the
# control was therefore free. With caching off a repeat walk cost 97% of the first, which is the wanted
# answer, but with caching ON it cost 82%, and a cache hit is nearer 3%. So the negative control passed
# in a sitting where the positive control never fired, and a control that only ever produces one answer
# cannot tell "the flag works" apart from "the walk was slow twice".
#
# The suspected cause is funding: bee's own help calls the flag "enable forwarded content caching", and
# the earlier proof that established the defect ran against the funded baseline. This settles it by
# running both directions on a funded node, which is the arm the sitting's conclusions are drawn from.
#
# ## Cost
#
# Four arms of 150 references, roughly 14 MB each, at about 0.00073 BZZ per MB: on the order of 0.04
# BZZ. That buys the instrument, which every past cache-dependent result was quoted without.
set -u

STACK_DIR="${STACK_DIR:-/home/solarpunk/swarm-hls-stream-latbench}"
ENV_FILE="${STACK_DIR}/.env"
PROBE="${PROBE:-/home/solarpunk/phase06/retrieval-debt-probe.sh}"
RUN_DIR="${RUN_DIR:-/home/solarpunk/retrieval-probe/cache-control-$(date -u +%Y%m%d-%H%M%S)}"
LOG="${RUN_DIR}/control.log"
CONTAINER="${CONTAINER:-latbench-bee-gateway-1}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-10077}"
SEGMENTS="${SEGMENTS:-150}"
RETRIEVAL_KEY=BEE_GATEWAY_CACHE_RETRIEVAL

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

# Funded arms, so the node is the one every conclusion in the sitting is drawn from, and not recreated
# between the two walks, which is where a cache would show.
one_direction() {
  # Two statements rather than one: bash expands every argument of a `local` before assigning any of
  # them, so a second name referring to the first is unbound at expansion time and `set -u` aborts.
  local flag="$1"
  local outDir="${RUN_DIR}/cache-${flag}"
  mkdir -p "${outDir}"
  say "--- funded pair with --cache-retrieval=${flag} ---"
  set_retrieval "${flag}" || return 1
  OUT_DIR="${outDir}" SEGMENTS="${SEGMENTS}" ROUNDS=1 FORCE_RECREATE=0 \
    ARM_PLAN='C1:true:0 C2:true:0' bash "${PROBE}" >>"${LOG}" 2>&1
  local first second
  first="$(awk -F'\t' '$2=="C1"{print $17; exit}' "${outDir}/probe-state.tsv")"
  second="$(awk -F'\t' '$2=="C2"{print $17; exit}' "${outDir}/probe-state.tsv")"
  if [ -z "${first}" ] || [ -z "${second}" ] || [ "${first}" -eq 0 ]; then
    say "⛔ cache-retrieval=${flag}: no median produced"
    return 1
  fi
  say "⭐ cache-retrieval=${flag}: first ${first}ms, second ${second}ms, second is $((second * 100 / first))% of first"
}

say "=== does --cache-retrieval do anything on a funded node? ==="
one_direction true
one_direction false
say "=== done, ${RUN_DIR} ==="
say "A working flag reads roughly: true -> second walk a small fraction, false -> second walk unchanged."
