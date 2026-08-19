#!/bin/bash
# What does a freshly recreated gateway cost while it is doing NOTHING?
#
# A cold gateway was measured serving 2 to 3x more CPU per MB for its first arm and settling over about
# four. That was measured with retrieval running, so it cannot separate two very different mechanisms:
# the retrieval path itself being more expensive while cold, or the node doing extra background work
# that the arm's CPU accounting is then charged for. **This runs no retrieval at all**, so whatever it
# finds is background.
#
# ## Why the control is inside the run
#
# ⭐ The same node is sampled after it has settled and again straight after a recreate, on the SAME
# funding arm, so the only thing that differs between the two windows is how long the process has been
# up. A cold reading compared against a warm reading from another sitting would confound it with
# funding, and that is exactly the confusion that left the cold penalty quoted as both 2.8x and 2.1x.
#
# ## What is already eliminated, for free
#
# ⭐ Bee's `--warmup-time` defaults to five minutes, which looks like the obvious answer and is not one.
# The flag is a MAXIMUM: bee "proceeds when stable or after this time", and this node's own log reports
# `warmupDurationSeconds=1.44`. The documented warmup is over before the first segment is ever asked for.
#
# ## Why it does not source _lib.sh
#
# Host-side probes are copied to the measurement host as a single file and run there, so they carry
# their own gateway lifecycle rather than depending on a library that is not shipped with them. That is
# the same reason `retrieval-debt-probe.sh` and `phase06-light-vs-ultralight.sh` are self-contained.
#
# The gateway is restored to the arm it was found in by an EXIT trap on every path.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_PROBE="${HERE}/gateway-probe.sh"
# shellcheck source=deploy/scripts/gateway-probe.sh
. "${GATEWAY_PROBE}" || {
  echo "cannot read ${GATEWAY_PROBE}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}
HOST_LOAD="${HERE}/host-load.sh"
# shellcheck source=deploy/scripts/host-load.sh
. "${HOST_LOAD}" || {
  echo "cannot read ${HOST_LOAD}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}

OUT_DIR="${OUT_DIR:-/home/solarpunk/retrieval-probe}"
STACK_DIR="${STACK_DIR:-/home/solarpunk/swarm-hls-stream-latbench}"
COMPOSE_DIR="${STACK_DIR}/deploy"
ENV_FILE="${STACK_DIR}/.env"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-latbench}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-10077}"
ACCT="${ACCT:-/home/solarpunk/phase06/acct2.sh}"
METRICS="${METRICS:-/home/solarpunk/phase06/metrics.sh}"

# The arm both windows run on. Unfunded by default, because a node with no chequebook cannot spend and
# the whole measurement is then free.
ARM_SWAP="${ARM_SWAP:-false}"
ARM_CACHE="${ARM_CACHE:-0}"

# How long the node is left alone after the first recreate before the warm window opens. The node's own
# log rate falls from about 4500 lines in the first minute to 33 by the fourth, so seven minutes is
# comfortably past anything visible there.
WARM_SETTLE_S="${WARM_SETTLE_S:-420}"
WARM_S="${WARM_S:-120}"
COLD_S="${COLD_S:-300}"
TICK_S="${TICK_S:-5}"
# The bucket the summary averages over. Small enough to show a decay, large enough that one tick of
# scheduler noise does not become a feature.
BUCKET_S="${BUCKET_S:-30}"

mkdir -p "${OUT_DIR}"
LOG="${OUT_DIR}/cold-idle.log"
SAMPLES="${OUT_DIR}/cold-idle.tsv"

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "${LOG}"; }

CONTAINER="${COMPOSE_PROJECT}-bee-gateway-1"
CACHE_KEY=BEE_GATEWAY_CACHE_CAPACITY

BASELINE_SWAP="$(grep '^BEE_GATEWAY_SWAP_ENABLE=' "${ENV_FILE}" | cut -d= -f2)"
if grep -q "^${CACHE_KEY}=" "${ENV_FILE}"; then
  CACHE_WAS_PRESENT=1
  BASELINE_CACHE="$(grep "^${CACHE_KEY}=" "${ENV_FILE}" | cut -d= -f2)"
else
  CACHE_WAS_PRESENT=0
  BASELINE_CACHE=0 # the compose default
fi
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

start_arm() {
  say "  setting swap=${ARM_SWAP} cache=${ARM_CACHE} and recreating the gateway"
  sed -i "s/^BEE_GATEWAY_SWAP_ENABLE=.*/BEE_GATEWAY_SWAP_ENABLE=${ARM_SWAP}/" "${ENV_FILE}" || return 1
  set_env_value "${CACHE_KEY}" "${ARM_CACHE}" || return 1
  ARM_CHANGED=1
  recreate_gateway || {
    say "  compose failed to recreate the gateway"
    return 1
  }
  wait_for_gateway_api || return 1
  return 0
}

restore_gateway() {
  [ "${ARM_CHANGED}" = "0" ] && return
  say "restoring the gateway to swap=${BASELINE_SWAP} cache=${BASELINE_CACHE}"
  sed -i "s/^BEE_GATEWAY_SWAP_ENABLE=.*/BEE_GATEWAY_SWAP_ENABLE=${BASELINE_SWAP}/" "${ENV_FILE}"
  if [ "${CACHE_WAS_PRESENT}" = "1" ]; then
    set_env_value "${CACHE_KEY}" "${BASELINE_CACHE}"
  else
    sed -i "/^${CACHE_KEY}=/d" "${ENV_FILE}"
  fi
  recreate_gateway
  wait_for_gateway_api
  say "gateway restored"
}
trap restore_gateway EXIT

# A node whose API is up but which has not found a peer yet prints nothing at all, and that is a
# reading rather than a failure, so it becomes 0 instead of an empty column.
peer_count() {
  local out
  out="$(bash "${ACCT}" "${GATEWAY_BEE_PORT}" 2>/dev/null | awk '{print $1}')"
  printf '%s' "${out:-0}"
}
# One window of samples. The rate is a difference between consecutive totals rather than an average
# since process start, which is the only form that can show a decay.
sample_window() {
  local phase="$1" seconds="$2" elapsed=0 cpuNow cpuPrev rate peers runnable
  cpuPrev="$(gateway_cpu_seconds)"
  # ⭐ Sampling can only start once the API answers, so the CPU burned between process start and here
  # is never in any rate. It is not lost: this is a total since process start, so for the cold window
  # this line IS the cost of coming up, and no per-tick rate can contain it.
  say "  ${phase} opens at ${cpuPrev} CPU-seconds since the process started"
  say "  sampling ${phase} for ${seconds}s every ${TICK_S}s"
  while [ "${elapsed}" -lt "${seconds}" ]; do
    sleep "${TICK_S}"
    elapsed=$((elapsed + TICK_S))
    cpuNow="$(gateway_cpu_seconds)"
    rate="$(awk -v a="${cpuPrev}" -v b="${cpuNow}" -v t="${TICK_S}" 'BEGIN{printf "%.4f", (b-a)/t}')"
    cpuPrev="${cpuNow}"
    peers="$(peer_count)"
    runnable="$(host_runnable)"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${phase}" "${elapsed}" "${cpuNow}" "${rate}" "${peers}" "${runnable}" >>"${SAMPLES}"
    if [ $((elapsed % 60)) = 0 ]; then
      say "    ${phase} +${elapsed}s: ${rate} CPU-s/s, ${peers} peers, ${runnable} runnable"
    fi
  done
  say "  ${phase} metrics: $(metrics)"
}

say "=== cold gateway idle cost: ${WARM_SETTLE_S}s settle, ${WARM_S}s warm, ${COLD_S}s cold, no retrieval ==="
say "gateway found at swap=${BASELINE_SWAP} cache=${BASELINE_CACHE}, which is what it will be left at"
say "both windows run at swap=${ARM_SWAP}, so funding cannot be the difference between them"
[ -s "${SAMPLES}" ] || printf 'phase\telapsed\tcpuS\tcpuRate\tpeers\trunnable\n' >"${SAMPLES}"

say "recreate 1 of 2: bringing the node up on the measurement arm, then leaving it alone"
start_arm || exit 1
say "  settling ${WARM_SETTLE_S}s before the warm window opens"
sleep "${WARM_SETTLE_S}"
sample_window warm "${WARM_S}"

say "recreate 2 of 2: same arm, so only the process age differs"
start_arm || exit 1
sample_window cold "${COLD_S}"

say "=== per-${BUCKET_S}s means ==="
awk -F'\t' -v b="${BUCKET_S}" '
  NR > 1 {
    bucket = int(($2 - 1) / b) * b
    key = $1 "\t" bucket
    sum[key] += $4
    n[key]++
    if ($1 == "warm") { warmSum += $4; warmN++ }
  }
  END {
    warm = (warmN > 0) ? warmSum / warmN : 0
    printf "warm reference: %.4f CPU-s/s across %d samples\n", warm, warmN
    for (key in sum) {
      split(key, k, "\t")
      if (k[1] != "cold") continue
      mean = sum[key] / n[key]
      printf "cold +%4ds: %.4f CPU-s/s = %.2fx warm\n", k[2] + b, mean, (warm > 0) ? mean / warm : 0
    }
  }' "${SAMPLES}" | sort -t+ -k2 -n | tee -a "${LOG}"

say "=== done ==="
