#!/bin/bash
# Does an unfunded gateway's debt accumulate under sustained retrieval, and do its peers pin against
# a common ceiling? That is the mechanism Phase 0.6 closed on, and this answers it without a broadcast.
#
# ## Why this costs almost nothing
#
# Retrieval is the only half of the pipeline under test, and the segments it retrieves are already on
# Swarm: 1884 references taken from the request log of the 2026-08-08 unfunded arm. So there is no
# encoder, no publisher, no upload and **no postage**, and the arm that matters has no chequebook to
# spend from. Only the funded control arms cost anything, at roughly 0.00085 BZZ per MB, against a
# gateway holding 6.8. The uploader chequebook, which is the binding one at 2.32 BZZ, is untouched.
#
# ## What it cannot say
#
# These are archived segments, not the live edge, so the transfer times here are **not** viewer
# latency and must not be quoted as it. What they are comparable to is each other, arm against arm,
# on the same references in the same order.
#
# The gateway is restored to the arm it was found in by an EXIT trap on every path.
set -u

OUT_DIR="${OUT_DIR:-/home/solarpunk/retrieval-probe}"
STACK_DIR="${STACK_DIR:-/home/solarpunk/swarm-hls-stream-latbench}"
COMPOSE_DIR="${STACK_DIR}/deploy"
ENV_FILE="${STACK_DIR}/.env"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-latbench}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-10077}"
REFS="${REFS:-/home/solarpunk/phase06/refs.txt}"
ACCT="${ACCT:-/home/solarpunk/phase06/acct2.sh}"

SEGMENTS="${SEGMENTS:-400}"
ROUNDS="${ROUNDS:-2}"

mkdir -p "${OUT_DIR}"
LOG="${OUT_DIR}/probe.log"
STATE="${OUT_DIR}/probe-state.tsv"
SERIES="${OUT_DIR}/probe-series.tsv"

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "${LOG}"; }

BASELINE_SWAP="$(grep '^BEE_GATEWAY_SWAP_ENABLE=' "${ENV_FILE}" | cut -d= -f2)"
CURRENT_ARM_SWAP="${BASELINE_SWAP}"
ARM_CHANGED=0

recreate_gateway() {
  (
    cd "${COMPOSE_DIR}" || exit 1
    BEE_GATEWAY_API_PORT="${GATEWAY_BEE_PORT}" \
      BEE_GATEWAY_P2P_PORT="$((GATEWAY_BEE_PORT + 1))" \
      docker compose -p "${COMPOSE_PROJECT}" \
      -f docker-compose.yml -f docker-compose.host.yml -f docker-compose.nat.yml \
      --env-file "${ENV_FILE}" \
      --profile bee-gateway \
      up -d --no-deps --force-recreate bee-gateway
  ) >>"${LOG}" 2>&1
}

wait_for_gateway_api() {
  local deadline=$(($(date -u +%s) + 240))
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    if curl -s -o /dev/null --max-time 5 "http://127.0.0.1:${GATEWAY_BEE_PORT}/health"; then
      return 0
    fi
    sleep 3
  done
  say "  the gateway API did not answer within 240s of the recreate"
  return 1
}

set_arm() {
  CURRENT_ARM_SWAP="$1"
  say "  setting BEE_GATEWAY_SWAP_ENABLE=${CURRENT_ARM_SWAP} and recreating the gateway"
  sed -i "s/^BEE_GATEWAY_SWAP_ENABLE=.*/BEE_GATEWAY_SWAP_ENABLE=${CURRENT_ARM_SWAP}/" "${ENV_FILE}" || return 1
  ARM_CHANGED=1
  recreate_gateway || { say "  compose failed to recreate the gateway"; return 1; }
  wait_for_gateway_api || return 1
  return 0
}

# The arm read off the node rather than off the intent. A funded gateway answers /chequebook/balance
# with a balance; one started with swap disabled has no chequebook and refuses.
arm_confirmed_on_node() {
  local body
  body="$(curl -s -m 5 "http://127.0.0.1:${GATEWAY_BEE_PORT}/chequebook/balance" 2>/dev/null)"
  case "${CURRENT_ARM_SWAP}" in
    true) case "${body}" in *availableBalance*) return 0 ;; esac ;;
    false) case "${body}" in *availableBalance*) : ;; *) return 0 ;; esac ;;
  esac
  say "  the node does not have the shape this arm requires: ${body:0:80}"
  return 1
}

restore_gateway() {
  if [ "${ARM_CHANGED}" = "0" ] && [ "${CURRENT_ARM_SWAP}" = "${BASELINE_SWAP}" ]; then
    return
  fi
  say "restoring the gateway to BEE_GATEWAY_SWAP_ENABLE=${BASELINE_SWAP}"
  sed -i "s/^BEE_GATEWAY_SWAP_ENABLE=.*/BEE_GATEWAY_SWAP_ENABLE=${BASELINE_SWAP}/" "${ENV_FILE}"
  CURRENT_ARM_SWAP="${BASELINE_SWAP}"
  recreate_gateway
  wait_for_gateway_api
  if arm_confirmed_on_node; then
    say "gateway restored and confirmed on the node"
  else
    say "⛔ THE GATEWAY DID NOT COME BACK IN ITS ORIGINAL SHAPE. Check it by hand."
  fi
}
trap restore_gateway EXIT

acct() { bash "${ACCT}" "${GATEWAY_BEE_PORT}" 2>/dev/null; }

# One retrieval whose timing is thrown away, so the arm is measured against a node that has its peers
# rather than one that is still finding them.
warmup_fetch() {
  local ref took
  ref="$(head -1 "${REFS}")"
  took="$(curl -s -o /dev/null -m 60 -w '%{time_total}' "http://127.0.0.1:${GATEWAY_BEE_PORT}/bytes/${ref}")"
  say "  discarded a warm-up retrieval of ${took}s before timing anything"
}

# One arm: the same references in the same order every time, so the work is identical and only the
# node's ability to pay for it differs.
run_arm() {
  local round="$1" label="$2" swap="$3"
  say "round ${round} arm ${label}: ${SEGMENTS} segments"

  set_arm "${swap}" || return 1
  arm_confirmed_on_node || return 1

  local before after n=0 bytes=0 started ended
  before="$(acct)"
  [ -n "${before}" ] || before="NONE"
  say "  accounting before: ${before}"

  # ⛔ Discarded, and it is not optional. Every arm of the first run opened with a segment that took
  # 8.2 to 9.9 seconds, in the funded arms as much as the unfunded ones, because the arm begins with a
  # container recreate and bee answers `/health` well before its retrieval path has peers again. It is
  # an artifact of flipping the arm, present in both, and left in the sample it moves every maximum,
  # every p99 and every elapsed figure the run reports.
  warmup_fetch

  : >"${OUT_DIR}/times-${round}-${label}.txt"
  started="$(date +%s)"
  while read -r ref; do
    n=$((n + 1))
    [ "${n}" -gt "${SEGMENTS}" ] && break
    local out ms b
    out="$(curl -s -o /dev/null -m 30 -w '%{time_total} %{size_download}' "http://127.0.0.1:${GATEWAY_BEE_PORT}/bytes/${ref}")"
    ms="$(printf '%s\n' "${out}" | awk '{printf "%d", $1*1000}')"
    b="$(printf '%s\n' "${out}" | awk '{print $2}')"
    printf '%s\n' "${ms}" >>"${OUT_DIR}/times-${round}-${label}.txt"
    bytes=$((bytes + b))
    # A time series rather than only endpoints, so a debt that grows and then settles is visible.
    if [ $((n % 50)) = 0 ]; then
      printf '%s\t%s\t%s\t%s\t%s\n' "${round}" "${label}" "${n}" "$(($(date +%s) - started))" "$(acct)" >>"${SERIES}"
    fi
  done <"${REFS}"
  ended="$(date +%s)"

  after="$(acct)"
  [ -n "${after}" ] || after="NONE"

  local median p90 count
  count="$(wc -l <"${OUT_DIR}/times-${round}-${label}.txt")"
  median="$(sort -n "${OUT_DIR}/times-${round}-${label}.txt" | awk -v c="${count}" 'NR==int(c/2)+1')"
  p90="$(sort -n "${OUT_DIR}/times-${round}-${label}.txt" | awk -v c="${count}" 'NR==int(c*0.9)')"

  say "  ${count} segments, $((bytes / 1000000)) MB, $((ended - started))s, median ${median}ms, p90 ${p90}ms"
  say "  accounting after:  ${after}"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${round}" "${label}" "${swap}" "${count}" "${bytes}" "$((ended - started))" \
    "${median}" "${p90}" "${before}" "${after}" >>"${STATE}"
}

say "=== retrieval debt probe: ${ROUNDS} rounds of L/U at ${SEGMENTS} segments ==="
say "gateway found at BEE_GATEWAY_SWAP_ENABLE=${BASELINE_SWAP}, which is what it will be left at"
[ -s "${STATE}" ] || printf 'round\tarm\tswap\tsegments\tbytes\tseconds\tmedianMs\tp90Ms\tacctBefore\tacctAfter\n' >"${STATE}"
[ -s "${SERIES}" ] || printf 'round\tarm\tat\telapsed\tpeers\tinDebt\ttotalDebt\tdeepest\tmedianDebt\tp10Debt\tpinned\n' >"${SERIES}"

for round in $(seq 1 "${ROUNDS}"); do
  run_arm "${round}" "L" "true" || say "round ${round} arm L did not complete"
  run_arm "${round}" "U" "false" || say "round ${round} arm U did not complete"
done

say "=== done ==="
