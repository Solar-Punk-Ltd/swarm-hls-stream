#!/usr/bin/env bash
#
# One broadcast, one browser, the player's buffer target swept live: where does a viewer's buffer
# stop protecting the picture?
#
# ## Why a wrapper when the sweep is one browser run
#
# `browser:buffer-sweep` moves the buffer target between stretches of a single session, so unlike the
# other sittings there is exactly one broadcast and one viewer. What the driver cannot do is size or
# start that broadcast, and a broadcast that ends before the last arm turns those arms into the exact
# failure the sweep exists to find. The wrapper does the arithmetic from the driver's own arm plan,
# and puts the same afford, capacity and ceiling gates in front of the spend that every other sitting
# has.
#
# ## The byte source is required, not defaulted
#
# Same rule as crash-arms.sh, for the same reason: an unset `BROWSER_FETCH_BACKEND` short-circuits in
# the driver, records no arm and runs no proof, and every buffer reading this project held before
# 2026-08-27 was a gateway reading because of exactly that. Name it or nothing runs.
#
# Usage, from the repo root on the deployment host:
#   BYTE_SOURCE=weeb3 bash deploy/scripts/buffer-sweep-sitting.sh
set -u

BENCH_REPO="${BENCH_REPO:-/home/solarpunk/swarm-hls-bench}"
PROFILE="${PROFILE:-latbench}"
PORT_SLOT="${PORT_SLOT:-7}"
SIZE="${SIZE:-1280x720}"
BITRATE_KBPS="${BITRATE_KBPS:-2500}"
GOP="${GOP:-0.5}"
UPLOADER_API_PORT="${UPLOADER_API_PORT:-$((10000 + PORT_SLOT * 10))}"
UPLOADER_BEE_PORT="${UPLOADER_BEE_PORT:-$((10005 + PORT_SLOT * 10))}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-$((10007 + PORT_SLOT * 10))}"

STREAM_TIMEOUT_S="${STREAM_TIMEOUT_S:-180}"
QUIET_TIMEOUT_S="${QUIET_TIMEOUT_S:-120}"
PUBLISHER_MARGIN_S="${PUBLISHER_MARGIN_S:-90}"

BYTE_SOURCE="${BYTE_SOURCE:-}"

# The driver's own plan, mirrored so the wrapper can size the broadcast that has to carry it.
# Defaults match `e2e/browser/buffer-sweep.ts`.
BROWSER_ARM_SECONDS="${BROWSER_ARM_SECONDS:-240}"
BROWSER_SWEEP_TARGETS_S="${BROWSER_SWEEP_TARGETS_S:-6,3,2,1.5}"
BROWSER_SWEEP_WARMUP_S="${BROWSER_SWEEP_WARMUP_S:-6,1.5}"
BROWSER_BYTE_SOURCE_SETTLE_SECONDS="${BROWSER_BYTE_SOURCE_SETTLE_SECONDS:-60}"
# Browser boot, instrument proofs, and the driver writing its artifacts, none of which sample.
SWEEP_SLACK_S="${SWEEP_SLACK_S:-120}"

count_targets() { echo "$1" | tr ',' '\n' | grep -c .; }
ARM_COUNT=$(($(count_targets "${BROWSER_SWEEP_TARGETS_S}") + $(count_targets "${BROWSER_SWEEP_WARMUP_S}")))
BROWSER_TOTAL_S=$((BROWSER_BYTE_SOURCE_SETTLE_SECONDS + ARM_COUNT * BROWSER_ARM_SECONDS + SWEEP_SLACK_S))
MINUTES=$(((BROWSER_TOTAL_S + PUBLISHER_MARGIN_S + 59) / 60))

RATES="$(dirname "${BASH_SOURCE[0]}")/burn-rates.sh"
# shellcheck source=deploy/scripts/burn-rates.sh
. "${RATES}" || {
  echo "cannot read ${RATES}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BROWSER_IMAGE="${BROWSER_IMAGE:-swarm-hls-browser:latest}"
BROWSER_CONTAINER_NAME="${BROWSER_CONTAINER_NAME:-buffer-sweep-browser}"
RUN_SELFCHECK="${RUN_SELFCHECK:-1}"

OUT_DIR="${OUT_DIR:-/home/solarpunk/buffer-sweep/$(date -u +%Y%m%d-%H%M%S)}"
LOG="${OUT_DIR}/buffer-sweep.log"
STATE="${OUT_DIR}/buffer-sweep-state.tsv"
mkdir -p "${OUT_DIR}"

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >> "${LOG}"; }

GATES="${HERE}/capacity-gate.sh"
# shellcheck source=deploy/scripts/capacity-gate.sh
. "${GATES}" || {
  echo "cannot read ${GATES}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}
CEILING="${HERE}/spend-ceiling.sh"
BRACKET="${HERE}/metrics-bracket.sh"
# shellcheck source=deploy/scripts/metrics-bracket.sh
. "${BRACKET}" || {
  echo "cannot read ${BRACKET}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}
STOPS="${HERE}/publisher-stop.sh"
# shellcheck source=deploy/scripts/publisher-stop.sh
. "${STOPS}" || {
  echo "cannot read ${STOPS}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}

bzz() { printf '%d.%03d' "$(($1 / 10000000000000000))" "$((($1 % 10000000000000000) / 10000000000000))"; }

available_plur() {
  curl -s --max-time 5 "http://127.0.0.1:$1/chequebook/balance" 2>/dev/null |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["availableBalance"])' 2>/dev/null
}

# ⚠️ TWO NODES OF FIVE, and the ladder split is what made that a gap. This reads the shared publisher
# and the gateway; the 480p, 720p and 1080p nodes each hold their own chequebook and are not read
# here. The uploader's own `ChequebookGate` clears every one of them against a 0.5 BZZ floor, but only
# at startup, so a rung node that drains after a deploy is not refused by anything on this path. The
# e2e preflight `chequebook-funding` does read them all. Fixing this means one affordability loop
# shared by the drivers rather than five copies of it, which is its own change.
can_afford() {
  local minutes="$1" broadcasts="${2:-1}" short=0 who port burn setup have need
  for pair in "uploader:${UPLOADER_BEE_PORT}:${UPLOADER_BURN_PLUR_PER_MIN}:${UPLOADER_SETUP_PLUR}" \
    "gateway:${GATEWAY_BEE_PORT}:${GATEWAY_BURN_PLUR_PER_MIN}:${GATEWAY_SETUP_PLUR}"; do
    who="$(echo "${pair}" | cut -d: -f1)"; port="$(echo "${pair}" | cut -d: -f2)"
    burn="$(echo "${pair}" | cut -d: -f3)"; setup="$(echo "${pair}" | cut -d: -f4)"
    have="$(available_plur "${port}")"
    need=$(((minutes * burn + broadcasts * setup) * FUNDS_MARGIN_PERCENT / 100))
    if [ -z "${have}" ]; then
      say "  ${who} chequebook on ${port} did not answer, so funding is unknown"
      short=1
    elif [ "${have}" -lt "${need}" ]; then
      say "  ${who} has $(bzz "${have}") BZZ, needs $(bzz "${need}") for ${minutes} min SHORT"
      short=1
    else
      say "  ${who} has $(bzz "${have}") BZZ, needs $(bzz "${need}") for ${minutes} min, ok"
    fi
  done
  return ${short}
}

# shellcheck source=deploy/scripts/spend-ceiling.sh
. "${CEILING}" || {
  echo "cannot read ${CEILING}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}

PUBLISHERS_NOT_OURS="$(docker ps -aq --filter 'name=^swarm-hls-publish-' 2>/dev/null | tr '\n' ' ')"

stop_publisher() {
  local id
  request_publisher_stop
  for id in $(docker ps -aq --filter 'name=^swarm-hls-publish-' 2>/dev/null); do
    case " ${PUBLISHERS_NOT_OURS} " in
      *" ${id} "*) continue ;;
    esac
    docker rm -f "${id}" >/dev/null 2>&1 || true
  done
}

start_publisher() {
  local seconds="$1"
  stop_publisher
  (
    cd "${BENCH_REPO}" || exit 1
    deploy/scripts/publish-clock.sh \
      "--profile=${PROFILE}" "--portSlot=${PORT_SLOT}" --host=localhost \
      "--seconds=${seconds}" "--size=${SIZE}" "--bitrate=${BITRATE_KBPS}" "--gop=${GOP}" \
      "--stop-file=${PUBLISHER_STOP_FILE}"
  ) >> "${LOG}" 2>&1 &
}

wait_for_active_stream() {
  local deadline=$(($(date -u +%s) + STREAM_TIMEOUT_S)) active
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    active="$(curl -s --max-time 5 "http://127.0.0.1:${UPLOADER_API_PORT}/health" 2>/dev/null |
      python3 -c 'import sys,json;print(json.load(sys.stdin)["activeStreams"])' 2>/dev/null)"
    [ "${active:-0}" -ge 1 ] 2>/dev/null && return 0
    sleep 3
  done
  say "  no stream reached the uploader within ${STREAM_TIMEOUT_S}s of the publisher starting"
  return 1
}

wait_for_quiet() {
  local deadline=$(($(date -u +%s) + QUIET_TIMEOUT_S)) active
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    active="$(curl -s --max-time 5 "http://127.0.0.1:${UPLOADER_API_PORT}/health" 2>/dev/null |
      python3 -c 'import sys,json;print(json.load(sys.stdin)["activeStreams"])' 2>/dev/null)"
    [ "${active:-1}" -eq 0 ] 2>/dev/null && return 0
    sleep 3
  done
  say "  the uploader still reports a live stream ${QUIET_TIMEOUT_S}s after the publisher was removed"
  return 1
}

reclaim_browser_containers() {
  local name
  for name in "${BROWSER_CONTAINER_NAME}" "${BROWSER_CONTAINER_NAME}-selfcheck"; do
    if docker ps -aq --filter "name=^${name}$" 2>/dev/null | grep -q .; then
      say "  removing a leftover ${name}, which would hold the Xvfb display against every arm"
      docker rm -f "${name}" >/dev/null 2>&1 || true
    fi
  done
}

# The docker socket rides along for `readResources`, which prices the arm in container CPU the way
# every other browser reading here is priced.
run_sweep_browser() {
  docker run --rm --network host \
    --name "${BROWSER_CONTAINER_NAME}" \
    --shm-size=2g \
    -u "$(id -u):$(id -g)" \
    --group-add "$(getent group docker | cut -d: -f3)" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${BENCH_REPO}:/repo" \
    -e HOME=/tmp \
    -w /repo \
    -e E2E_SSH_TARGET=local \
    -e E2E_PUBLIC_HOST=127.0.0.1 \
    -e "E2E_PROFILE=${PROFILE}" \
    -e "E2E_PORT_SLOT=${PORT_SLOT}" \
    -e "BROWSER_CLIENT_URL=http://127.0.0.1:$((10004 + PORT_SLOT * 10))" \
    -e "BROWSER_FETCH_BACKEND=${BYTE_SOURCE}" \
    -e "BROWSER_ARM_SECONDS=${BROWSER_ARM_SECONDS}" \
    -e "BROWSER_SWEEP_TARGETS_S=${BROWSER_SWEEP_TARGETS_S}" \
    -e "BROWSER_SWEEP_WARMUP_S=${BROWSER_SWEEP_WARMUP_S}" \
    -e "BROWSER_BYTE_SOURCE_SETTLE_SECONDS=${BROWSER_BYTE_SOURCE_SETTLE_SECONDS}" \
    -e "BROWSER_GOP_SECONDS=${GOP}" \
    "${BROWSER_IMAGE}" pnpm browser:buffer-sweep
}

run_selfcheck() {
  docker run --rm --network host \
    --name "${BROWSER_CONTAINER_NAME}-selfcheck" \
    -u "$(id -u):$(id -g)" \
    -v "${BENCH_REPO}:/repo" \
    -e HOME=/tmp \
    -w /repo \
    -e E2E_SSH_TARGET=local \
    -e E2E_PUBLIC_HOST=127.0.0.1 \
    -e "E2E_PROFILE=${PROFILE}" \
    -e "E2E_PORT_SLOT=${PORT_SLOT}" \
    -e "BROWSER_CLIENT_URL=http://127.0.0.1:$((10004 + PORT_SLOT * 10))" \
    "${BROWSER_IMAGE}" pnpm browser:selfcheck
}

# ⛔ Every refusal that costs nothing comes first, and only then does anything get touched or run.
case "${BYTE_SOURCE}" in
  weeb3 | gateway) ;;
  '')
    say "REFUSING TO START: no BYTE_SOURCE named, and a sweep without one would run unlabelled and unproven"
    exit 1
    ;;
  *)
    say "REFUSING TO START: byte source '${BYTE_SOURCE}' is not weeb3 or gateway"
    exit 1
    ;;
esac

say "buffer-sweep starting: ${ARM_COUNT} arms of ${BROWSER_ARM_SECONDS}s on ${BYTE_SOURCE}, targets ${BROWSER_SWEEP_TARGETS_S} (warm-up ${BROWSER_SWEEP_WARMUP_S})"
say "  1 broadcast of ${MINUTES} min carries it: $((ARM_COUNT * BROWSER_ARM_SECONDS))s of arms, ${BROWSER_BYTE_SOURCE_SETTLE_SECONDS}s node settle, ${SWEEP_SLACK_S}s slack, ${PUBLISHER_MARGIN_S}s margin"

if ! docker image inspect "${BROWSER_IMAGE}" >/dev/null 2>&1; then
  say "REFUSING TO START: ${BROWSER_IMAGE} is not on this host, so nothing here could open a browser"
  exit 1
fi
if [ -f "${STOP_FILE}" ]; then
  say "REFUSING TO START: a floor was already crossed and ${STOP_FILE} says so:"
  sed 's/^/  /' "${STOP_FILE}" >> "${LOG}"
  exit 1
fi
if ! can_afford "${MINUTES}" 1; then
  say "REFUSING TO START: this sitting cannot pay for itself"
  exit 1
fi
if ! has_capacity "${MINUTES}"; then
  say "REFUSING TO START: the postage batch cannot carry this sitting"
  exit 1
fi
if ! within_ceiling "${MINUTES}"; then
  say "REFUSING TO START: this sitting would spend past the authorisation in ${SPEND_LEDGER}"
  exit 1
fi
snapshot_metrics "${METRICS_DIR}/sitting-before.json" "sitting-before"
[ "${PREFLIGHT_ONLY:-0}" = "1" ] && { say "PREFLIGHT_ONLY, so stopping here without publishing anything"; exit 0; }

reclaim_browser_containers
if [ "${RUN_SELFCHECK}" = "1" ]; then
  say "  running the free selfcheck before spending anything"
  if ! run_selfcheck >> "${LOG}" 2>&1; then
    say "REFUSING TO START: the browser selfcheck failed, so nothing here could measure a viewer"
    exit 1
  fi
  say "  selfcheck passed"
fi

trap 'stop_sampler; stop_publisher; reclaim_browser_containers' EXIT INT TERM

status=0
start_publisher $((MINUTES * 60))
if ! wait_for_active_stream; then
  stop_publisher
  printf '%s\t%s\t%s\tNO-STREAM\n' "$(date -u +%FT%TZ)" "${BYTE_SOURCE}" "${MINUTES}" >> "${STATE}"
  exit 1
fi

start_sampler "${METRICS_DIR}/sweep-series" "sweep"
run_sweep_browser >> "${LOG}" 2>&1 || status=$?
stop_sampler
stop_publisher
wait_for_quiet
snapshot_metrics "${METRICS_DIR}/sitting-after.json" "sitting-after"
diff_metrics "${METRICS_DIR}/sitting-before.json" "${METRICS_DIR}/sitting-after.json" \
  "${METRICS_DIR}/sitting-diff.txt" "  what the sweep did to the nodes:"

printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "${BYTE_SOURCE}" "${MINUTES}" \
  "$([ ${status} -eq 0 ] && echo ok || echo "BROWSER-FAILED(${status})")" >> "${STATE}"
say "buffer-sweep done, status ${status}. Reports are in ${BENCH_REPO}/docs/bench/, state in ${STATE}"
exit "${status}"
