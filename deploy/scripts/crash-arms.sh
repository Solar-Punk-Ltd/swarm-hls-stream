#!/usr/bin/env bash
#
# Break something under a watching viewer, one fault per broadcast, with every arm naming the byte
# source it was measured on.
#
# ## Why this exists next to `viewer-arms.sh`
#
# That one varies the publisher and watches a healthy broadcast. This one holds the publisher fixed
# and breaks a service mid-broadcast through `browser:crash`, which injects the fault itself over the
# docker socket so the fault and the samples come off one clock.
#
# ## Why the byte source is in the arm name and not an env the operator remembers to set
#
# Until 2026-08-27 the crash driver never read `BROWSER_FETCH_BACKEND` at all, so every crash-recovery
# reading this project holds is a gateway reading whatever the run was called. An unread variable is
# indistinguishable from one set to its default. The wrapper therefore refuses an arm that does not
# name its byte source, and refuses byte sources the driver does not honour, before anything is
# published or paid for.
#
# ## What an arm is
#
# One broadcast, one fault, one viewer. Faults end broadcasts (`engine-restart` takes the SRT
# connection with it, correctly), so arms cannot share one. The broadcast runs at the shipped profile
# (0.5s GOP, 720p, 2500 kbps) unless overridden, because the question is what the shipping viewer
# survives.
#
# Usage, from the repo root on the deployment host:
#   bash deploy/scripts/crash-arms.sh
#   ARMS="viewer-gateway-outage:weeb3 viewer-gateway-outage:gateway" bash deploy/scripts/crash-arms.sh
set -u

BENCH_REPO="${BENCH_REPO:-/home/solarpunk/swarm-hls-bench}"
PROFILE="${PROFILE:-latbench}"
PORT_SLOT="${PORT_SLOT:-7}"
MINUTES="${MINUTES:-7}"
SIZE="${SIZE:-1280x720}"
BITRATE_KBPS="${BITRATE_KBPS:-2500}"
GOP="${GOP:-0.5}"
UPLOADER_API_PORT="${UPLOADER_API_PORT:-$((10000 + PORT_SLOT * 10))}"
UPLOADER_BEE_PORT="${UPLOADER_BEE_PORT:-$((10005 + PORT_SLOT * 10))}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-$((10007 + PORT_SLOT * 10))}"

STREAM_TIMEOUT_S="${STREAM_TIMEOUT_S:-180}"
QUIET_TIMEOUT_S="${QUIET_TIMEOUT_S:-120}"

# How much of an arm's broadcast is spent outside the viewer: the stream has to exist before the
# browser opens and still be live when the last recovery sample is taken.
PUBLISHER_MARGIN_S="${PUBLISHER_MARGIN_S:-90}"

# The driver's own windows, forwarded so the wrapper can price the broadcast that has to carry them.
# Defaults mirror `e2e/browser/crash.ts` and `e2e/src/browser/byteSourceArm.ts`.
BROWSER_SETTLE_SECONDS="${BROWSER_SETTLE_SECONDS:-45}"
BROWSER_RECOVER_SECONDS="${BROWSER_RECOVER_SECONDS:-60}"
BROWSER_BYTE_SOURCE_SETTLE_SECONDS="${BROWSER_BYTE_SOURCE_SETTLE_SECONDS:-60}"
# The worst outage plus readiness wait a scenario can spend between settle and recovery. The longest
# declared outage is 30s and the driver gives a restored service 60s to answer.
FAULT_ALLOWANCE_S="${FAULT_ALLOWANCE_S:-90}"

# What a sitting costs, and the margin over it. Same sourcing order as viewer-arms.sh throughout,
# because these libraries refuse callers that source them before their dependencies exist.
RATES="$(dirname "${BASH_SOURCE[0]}")/burn-rates.sh"
# shellcheck source=deploy/scripts/burn-rates.sh
. "${RATES}" || {
  echo "cannot read ${RATES}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BROWSER_IMAGE="${BROWSER_IMAGE:-swarm-hls-browser:latest}"
BROWSER_CONTAINER_NAME="${BROWSER_CONTAINER_NAME:-crash-arms-browser}"
RUN_SELFCHECK="${RUN_SELFCHECK:-1}"

# The five names `e2e/src/browser/faults.ts` declares. A copy, checked before anything is paid for,
# because the driver's own `scenarioByName` throws after the broadcast is already up. A scenario added
# there without updating this list refuses loudly here instead of publishing first.
KNOWN_SCENARIOS="viewer-gateway-outage uploader-crash engine-restart writer-bee-pause writer-bee-outage"

# `scenario:byteSource` pairs, run in this order. The gateway twin of the headline scenario runs
# beside it so the comparison does not rest on cross-day drift, and `engine-restart` runs last
# because it ends its broadcast the hard way.
DEFAULT_ARMS="viewer-gateway-outage:weeb3 viewer-gateway-outage:gateway uploader-crash:weeb3 writer-bee-pause:weeb3 writer-bee-outage:weeb3 engine-restart:weeb3"
read -r -a ARM_LIST <<< "${ARMS:-${DEFAULT_ARMS}}"

# Outside BENCH_REPO, which is an rsync target with --delete.
OUT_DIR="${OUT_DIR:-/home/solarpunk/crash-arms/$(date -u +%Y%m%d-%H%M%S)}"
LOG="${OUT_DIR}/crash-arms.log"
STATE="${OUT_DIR}/crash-arms-state.tsv"
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

# The crash browser gets the docker socket, which `browser:watch` never needs: the fault is injected
# from inside the driver so it and the samples share one clock. `--shm-size=2g` is what
# `bench-on-host.sh` gives Chrome for the same page.
run_crash_browser() {
  local scenario="$1" source="$2"
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
    -e "BROWSER_SCENARIO=${scenario}" \
    -e "BROWSER_FETCH_BACKEND=${source}" \
    -e "BROWSER_SETTLE_SECONDS=${BROWSER_SETTLE_SECONDS}" \
    -e "BROWSER_RECOVER_SECONDS=${BROWSER_RECOVER_SECONDS}" \
    -e "BROWSER_BYTE_SOURCE_SETTLE_SECONDS=${BROWSER_BYTE_SOURCE_SETTLE_SECONDS}" \
    -e "BROWSER_GOP_SECONDS=${GOP}" \
    "${BROWSER_IMAGE}" pnpm browser:crash
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

run_arm() {
  local index="$1" scenario="$2" source="$3" slug="arm$1-$2-$3" status=0
  say "arm ${index}: ${scenario} on ${source} starting"

  if [ -f "${STOP_FILE}" ]; then
    say "STOPPING before ${slug}: an earlier arm crossed a floor and left ${STOP_FILE}"
    return 1
  fi
  if ! can_afford "${MINUTES}" 1; then
    say "STOPPING before ${slug}: cannot pay for this arm"
    return 1
  fi
  if ! has_capacity "${MINUTES}"; then
    say "STOPPING before ${slug}: the postage batch cannot carry this arm"
    return 1
  fi

  start_publisher $((MINUTES * 60))
  if ! wait_for_active_stream; then
    stop_publisher
    printf '%s\t%s\t%s\t%s\tNO-STREAM\n' "$(date -u +%FT%TZ)" "${index}" "${scenario}" "${source}" >> "${STATE}"
    return 0
  fi

  snapshot_metrics "${METRICS_DIR}/${slug}-before.json" "${slug}-before"
  start_sampler "${METRICS_DIR}/${slug}-series" "${slug}"

  # Foreground, unlike viewer-arms' four-hour watches: an arm here is a few minutes, and the per-arm
  # gates above are the mid-sitting stop.
  run_crash_browser "${scenario}" "${source}" >> "${LOG}" 2>&1 || status=$?

  stop_sampler
  stop_publisher
  wait_for_quiet
  snapshot_metrics "${METRICS_DIR}/${slug}-after.json" "${slug}-after"
  diff_metrics "${METRICS_DIR}/${slug}-before.json" "${METRICS_DIR}/${slug}-after.json" \
    "${METRICS_DIR}/${slug}-diff.txt" "  what the nodes say this arm did:"

  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "${index}" "${scenario}" "${source}" \
    "$([ ${status} -eq 0 ] && echo ok || echo "BROWSER-FAILED(${status})")" >> "${STATE}"
  say "arm ${index}: ${scenario} on ${source} finished, status ${status}"
  return 0
}

# ⛔ Every refusal that costs nothing comes first, and only then does anything get touched or run.
# Malformed arms are the cheapest refusal of all, so they come before even the funding reads.
for arm in "${ARM_LIST[@]}"; do
  case "${arm}" in
    *:*:*)
      say "REFUSING TO START: '${arm}' is not scenario:byteSource"
      exit 1
      ;;
    *:*) ;;
    *)
      say "REFUSING TO START: '${arm}' names no byte source, and an arm without one would run unlabelled and unproven"
      exit 1
      ;;
  esac
  scenario="${arm%%:*}"
  source="${arm##*:}"
  case " ${KNOWN_SCENARIOS} " in
    *" ${scenario} "*) ;;
    *)
      say "REFUSING TO START: '${scenario}' is not a scenario e2e/src/browser/faults.ts declares (${KNOWN_SCENARIOS})"
      exit 1
      ;;
  esac
  case "${source}" in
    weeb3 | gateway) ;;
    *)
      say "REFUSING TO START: byte source '${source}' is not weeb3 or gateway"
      exit 1
      ;;
  esac
done

# The broadcast has to carry the driver's whole timeline with the publisher's margin on both ends.
ARM_NEED_S=$((PUBLISHER_MARGIN_S + BROWSER_BYTE_SOURCE_SETTLE_SECONDS + BROWSER_SETTLE_SECONDS + FAULT_ALLOWANCE_S + BROWSER_RECOVER_SECONDS))
if [ $((MINUTES * 60)) -lt "${ARM_NEED_S}" ]; then
  say "REFUSING TO START: MINUTES=${MINUTES} gives $((MINUTES * 60))s of broadcast against ${ARM_NEED_S}s the driver's windows need"
  exit 1
fi

TOTAL_ARMS="${#ARM_LIST[@]}"
say "crash-arms starting: ${TOTAL_ARMS} arms x ${MINUTES} min, gop ${GOP}, ${SIZE} @ ${BITRATE_KBPS}kbps"
if ! docker image inspect "${BROWSER_IMAGE}" >/dev/null 2>&1; then
  say "REFUSING TO START: ${BROWSER_IMAGE} is not on this host, so no arm could open a browser"
  exit 1
fi

if [ -f "${STOP_FILE}" ]; then
  say "REFUSING TO START: a floor was already crossed and ${STOP_FILE} says so:"
  sed 's/^/  /' "${STOP_FILE}" >> "${LOG}"
  exit 1
fi
if ! can_afford $((TOTAL_ARMS * MINUTES)) "${TOTAL_ARMS}"; then
  say "REFUSING TO START: this sitting cannot pay for itself"
  exit 1
fi
if ! has_capacity $((TOTAL_ARMS * MINUTES)); then
  say "REFUSING TO START: the postage batch cannot carry this sitting"
  exit 1
fi
if ! within_ceiling $((TOTAL_ARMS * MINUTES)); then
  say "REFUSING TO START: this sitting would spend past the authorisation in ${SPEND_LEDGER}"
  exit 1
fi
snapshot_metrics "${METRICS_DIR}/sitting-before.json" "sitting-before"
[ "${PREFLIGHT_ONLY:-0}" = "1" ] && { say "PREFLIGHT_ONLY, so stopping here without publishing anything"; exit 0; }

reclaim_browser_containers
if [ "${RUN_SELFCHECK}" = "1" ]; then
  say "  running the free selfcheck before spending anything"
  if ! run_selfcheck >> "${LOG}" 2>&1; then
    say "REFUSING TO START: the browser selfcheck failed, so no arm here could measure a viewer"
    exit 1
  fi
  say "  selfcheck passed"
fi

# Installed only here, past every exit that publishes nothing, so a run that starts no broadcast can
# never tear one down on its way out.
trap 'stop_sampler; stop_publisher; reclaim_browser_containers' EXIT INT TERM

index=0
for arm in "${ARM_LIST[@]}"; do
  index=$((index + 1))
  run_arm "${index}" "${arm%%:*}" "${arm##*:}" || break
done

snapshot_metrics "${METRICS_DIR}/sitting-after.json" "sitting-after"
diff_metrics "${METRICS_DIR}/sitting-before.json" "${METRICS_DIR}/sitting-after.json" \
  "${METRICS_DIR}/sitting-diff.txt" "  what the whole sitting did to the nodes:"
say "crash-arms done. Reports are in ${BENCH_REPO}/docs/bench/, state in ${STATE}"
