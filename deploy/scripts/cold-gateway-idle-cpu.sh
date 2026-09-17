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
RPC_KEY=BEE_GATEWAY_RPC_ENDPOINT
SWAP_KEY=BEE_GATEWAY_SWAP_ENABLE

# Everything after the first `=`, because an endpoint carries one in a query string and
# `cut -d= -f2` would take half of it. A key the file does not carry reads as empty.
env_file_value() { sed -n "s/^$1=//p" "${ENV_FILE}" 2>/dev/null | tail -n 1; }

# This probe sets the arm both its windows run on by writing the env file, so the compose file has to
# read the keys that arm is made of. Since T27 on 2026-09-17 the gateway's mode is two of them: an
# endpoint is what puts the node on a chain, an empty one is the whole of what makes it ultra-light,
# and swap is what lets a node on a chain pay its peers. A stack that reads one and not the other
# runs the node on whatever compose resolves instead, and nothing else here reads the node's mode, so
# every row of the TSV would be filed under a setting the node never had. That is worse than a wrong
# number, because the label is what a later reading is compared against.
#
# Inlined rather than called from `_lib.sh`, because this file is copied to the measurement host on
# its own and a bare call to a function that is not there is a `command not found` line and a probe
# that carries on regardless.
MODE_KEYS_UNREAD=""
grep -qF "\${${RPC_KEY}" "${COMPOSE_DIR}/docker-compose.yml" || MODE_KEYS_UNREAD="${RPC_KEY}"
grep -qF "\${${SWAP_KEY}" "${COMPOSE_DIR}/docker-compose.yml" ||
  MODE_KEYS_UNREAD="${MODE_KEYS_UNREAD:+${MODE_KEYS_UNREAD} and }${SWAP_KEY}"
if [ -n "${MODE_KEYS_UNREAD}" ]; then
  echo "ERROR: the stack's docker-compose.yml does not read ${MODE_KEYS_UNREAD}, so writing that into the env file changes nothing." >&2
  echo "Its gateway takes its mode from ${RPC_KEY} and ${SWAP_KEY} together: an endpoint is what puts the node on a chain, an empty one is the whole of what makes it ultra-light, and swap is what lets a node on a chain pay its peers." >&2
  echo "A stack that does not read both cannot produce the light arm, so this probe cannot set the arm it names and every sample would be filed under a mode the node never had." >&2
  exit 1
fi

# The chain a light arm points the gateway at, which is the one the stack's own publisher nodes
# already talk to.
#
# ⚠️ Read out of the stack's env file under its own name rather than out of this shell under the
# gateway's, because a deployment host exports endpoint settings for its stack and a probe that took
# one from the environment would put a node on a chain nobody chose.
STACK_RPC_ENDPOINT="${LIGHT_ARM_RPC_ENDPOINT:-$(env_file_value RPC_ENDPOINT)}"
if [ "${ARM_SWAP}" = "true" ] && [ -z "${STACK_RPC_ENDPOINT}" ]; then
  echo "ERROR: this probe was asked for swap=true, which is the light arm, and ${ENV_FILE} names no RPC_ENDPOINT." >&2
  echo "A light node is one with a chain behind it, so the arm cannot be produced without an endpoint, and bee refuses to start at all with swap asked for and no chain." >&2
  echo "Set RPC_ENDPOINT in that file, or pass LIGHT_ARM_RPC_ENDPOINT to this probe." >&2
  exit 1
fi
# The ultra-light arm states its empty endpoint rather than leaving the key alone, so that neither a
# value left in the env file by something else nor one the host exports can make this node light.
if [ "${ARM_SWAP}" = "true" ]; then
  ARM_RPC_ENDPOINT="${STACK_RPC_ENDPOINT}"
else
  ARM_RPC_ENDPOINT=""
fi

BASELINE_SWAP="$(env_file_value "${SWAP_KEY}")"
BASELINE_RPC_ENDPOINT="$(env_file_value "${RPC_KEY}")"
# Absent from the env file is a distinct state from present-and-empty, and this key is absent from
# every stack that has not been through an arm, so putting it back means taking it out again.
if grep -q "^${RPC_KEY}=" "${ENV_FILE}" 2>/dev/null; then
  RPC_WAS_PRESENT=1
else
  RPC_WAS_PRESENT=0
fi
if grep -q "^${CACHE_KEY}=" "${ENV_FILE}"; then
  CACHE_WAS_PRESENT=1
  BASELINE_CACHE="$(grep "^${CACHE_KEY}=" "${ENV_FILE}" | cut -d= -f2)"
else
  CACHE_WAS_PRESENT=0
  BASELINE_CACHE=0 # the compose default
fi
# What the gateway is meant to be running right now. Both the env file and the compose call below are
# told it, and the two are kept in step here rather than at each call site.
WANTED_SWAP="${BASELINE_SWAP}"
WANTED_RPC_ENDPOINT="${BASELINE_RPC_ENDPOINT}"
write_gateway_mode() {
  WANTED_SWAP="$1"
  WANTED_RPC_ENDPOINT="$2"
  set_env_value "${SWAP_KEY}" "${WANTED_SWAP}" || return 1
  set_env_value "${RPC_KEY}" "${WANTED_RPC_ENDPOINT}" || return 1
}
ARM_CHANGED=0

recreate_gateway() {
  (
    cd "${COMPOSE_DIR}" || exit 1
    # ⛔ The two mode keys are exported as well as written, because compose prefers a value from the
    # shell it runs in over the same key in its `--env-file`, and this host exports endpoint settings
    # for the stack. Written alone, the arm would be whatever the host had already decided.
    BEE_GATEWAY_API_PORT="${GATEWAY_BEE_PORT}" \
      BEE_GATEWAY_P2P_PORT="$((GATEWAY_BEE_PORT + 1))" \
      BEE_GATEWAY_SWAP_ENABLE="${WANTED_SWAP}" \
      BEE_GATEWAY_RPC_ENDPOINT="${WANTED_RPC_ENDPOINT}" \
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
  say "  setting swap=${ARM_SWAP} endpoint=${ARM_RPC_ENDPOINT:-none} cache=${ARM_CACHE} and recreating the gateway"
  write_gateway_mode "${ARM_SWAP}" "${ARM_RPC_ENDPOINT}" || return 1
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
  say "restoring the gateway to swap=${BASELINE_SWAP} endpoint=${BASELINE_RPC_ENDPOINT:-none} cache=${BASELINE_CACHE}"
  write_gateway_mode "${BASELINE_SWAP}" "${BASELINE_RPC_ENDPOINT}"
  [ "${RPC_WAS_PRESENT}" = "1" ] || unset_env_value "${RPC_KEY}"
  if [ "${CACHE_WAS_PRESENT}" = "1" ]; then
    set_env_value "${CACHE_KEY}" "${BASELINE_CACHE}"
  else
    unset_env_value "${CACHE_KEY}"
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
say "gateway found at swap=${BASELINE_SWAP} endpoint=${BASELINE_RPC_ENDPOINT:-none} cache=${BASELINE_CACHE}, which is what it will be left at"
say "both windows run at swap=${ARM_SWAP} endpoint=${ARM_RPC_ENDPOINT:-none}, so funding cannot be the difference between them"
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
