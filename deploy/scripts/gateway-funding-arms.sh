#!/usr/bin/env bash
#
# What a viewer gets through an UNFUNDED gateway, against a funded one, under a single broadcast.
#
# ## The gap this closes
#
# Every viewer-side figure this project holds was measured through a chequebook-funded gateway. That
# is the best case and not the shipping case: a real viewer arrives at whatever public node they were
# given, and the owner's framing is that it has neither funding nor a full node behind it. Phase 0.6
# compared the two by recreating one gateway with `--swap-enable` flipped, which makes the arms two
# soaks separated by a container restart, so a cold cache and a lost peer set ride along with the
# treatment.
#
# ## Why one broadcast
#
# ⛔⛔⛔ Two arms drawing from two broadcasts is how the fragment-size cliff was found and withdrawn:
# both arms drew from one corpus whose health was moving, and neither a within-round contrast nor a
# replicate saved it. Here the publisher runs ONCE for the whole sitting, so both arms read the same
# content, produced by the same encoder, over the same window, into the same network.
#
# ## Why the browser still restarts between arms
#
# ⛔⛔ hls.js raises its latency target on every stall and NEVER lowers it. One continuous session
# would carry an unfunded arm's stalls into the funded arm that follows, and since the unfunded arm is
# the one expected to stall, the contamination would run from treatment to control and bias the
# result towards the null. A fresh player per arm also matches every earlier viewer figure here, each
# of which measured a viewer who had just arrived.
#
# ## Two warm gateways, neither of them touched
#
# ⛔ This script never restarts, recreates or funds a node. Both gateways are expected warm and
# already peered before it runs, since a cold node costs 2-3x for about two minutes and a fresh one
# needs some thirteen minutes of chain sync. `unfunded-gateway.sh start` and `wait` do that, well
# before a sitting, and the arms then differ in funding and nothing else.
#
# Usage, from the repo root on the deployment host:
#   ROUNDS=4 ARM_MINUTES=6 bash deploy/scripts/gateway-funding-arms.sh
set -u

BENCH_REPO="${BENCH_REPO:-/home/solarpunk/swarm-hls-bench}"
PROFILE="${PROFILE:-latbench}"
PORT_SLOT="${PORT_SLOT:-7}"

# Four rounds of two arms. The order is counterbalanced and comes from the harness rather than from
# arithmetic repeated here, see `browser:arm-order`.
ROUNDS="${ROUNDS:-4}"
# ⛔ The first arms of a sitting run differently, which has cost two sittings here. One round is
# discarded by default, which at two arms per round is the two the record says to drop.
WARMUP_ROUNDS="${WARMUP_ROUNDS:-1}"
ARM_MINUTES="${ARM_MINUTES:-6}"
# Between arms: the previous browser has to be gone and the uploader quiet before the next one opens.
ARM_GAP_S="${ARM_GAP_S:-20}"
# ⛔⛔ What an arm costs BESIDES its watch, and it is not optional padding. An arm also starts a
# container, joins the stream, and takes four node readings, and `openViewer` will wait up to 90s for
# playback before giving up. A publisher budgeted at watch-plus-gap therefore runs out before the last
# arms of a sitting, and those arms find no live stream: the broadcast is paid for, the arms are lost,
# and the sitting comes back short of the replicates it was booked for.
#
# ⭐ The trade is one-sided. Overshooting costs a few minutes of publishing nobody watches, at about
# 0.013 BZZ a minute. Undershooting costs whole arms.
ARM_OVERHEAD_S="${ARM_OVERHEAD_S:-90}"
# How long the broadcast leads the first arm and outlives the last. A viewer joining a stream that
# started a moment ago is measuring the publisher warming up rather than the gateway.
PUBLISHER_LEAD_S="${PUBLISHER_LEAD_S:-60}"

SIZE="${SIZE:-1280x720}"
BITRATE_KBPS="${BITRATE_KBPS:-2500}"
GOP_SECONDS="${GOP_SECONDS:-0.5}"

UPLOADER_API_PORT="${UPLOADER_API_PORT:-$((10000 + PORT_SLOT * 10))}"
UPLOADER_BEE_PORT="${UPLOADER_BEE_PORT:-$((10005 + PORT_SLOT * 10))}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-$((10007 + PORT_SLOT * 10))}"
CLIENT_PORT="${CLIENT_PORT:-$((10004 + PORT_SLOT * 10))}"

# The standalone ultra-light node. Its port is fixed by `unfunded-gateway.sh` rather than derived from
# the port slot, because it is not part of the profile stack and never should be.
UNFUNDED_BEE_PORT="${UNFUNDED_BEE_PORT:-10087}"

STREAM_TIMEOUT_S="${STREAM_TIMEOUT_S:-180}"
QUIET_TIMEOUT_S="${QUIET_TIMEOUT_S:-120}"
STOP_POLL_S="${STOP_POLL_S:-5}"

BROWSER_IMAGE="${BROWSER_IMAGE:-swarm-hls-browser:latest}"
BROWSER_CONTAINER_NAME="${BROWSER_CONTAINER_NAME:-gateway-arms-browser}"
RUN_SELFCHECK="${RUN_SELFCHECK:-1}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNFUNDED_GATEWAY="${UNFUNDED_GATEWAY:-${HERE}/unfunded-gateway.sh}"

RATES="${HERE}/burn-rates.sh"
# shellcheck source=deploy/scripts/burn-rates.sh
. "${RATES}" || {
  echo "cannot read ${RATES}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}

OUT_DIR="${OUT_DIR:-/home/solarpunk/gateway-funding-arms/$(date -u +%Y%m%d-%H%M%S)}"
LOG="${OUT_DIR}/gateway-funding-arms.log"
STATE="${OUT_DIR}/gateway-funding-arms-state.tsv"
mkdir -p "${OUT_DIR}"

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >> "${LOG}"; }

GATES="${HERE}/capacity-gate.sh"
# shellcheck source=deploy/scripts/capacity-gate.sh
. "${GATES}" || {
  echo "cannot read ${GATES}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}
# ⛔⛔⛔ SET BEFORE metrics-bracket.sh IS SOURCED, WHERE IT DEFAULTS TO ZERO AND DISABLES THE SAMPLER.
# The sampler is the only thing in this repo that writes STOP_FILE, and STOP_FILE is what all three
# of this arm's floor checks read. Left at zero, a sitting logs a mid-arm floor check that polls a
# file no process in the run will ever create. This is a paid broadcast, so the control is on by
# default and an operator who wants it off has to say so.
METRICS_INTERVAL_S="${METRICS_INTERVAL_S:-30}"
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

gateway_url_for() {
  case "$1" in
    funded) printf 'http://127.0.0.1:%s' "${GATEWAY_BEE_PORT}" ;;
    unfunded) printf 'http://127.0.0.1:%s' "${UNFUNDED_BEE_PORT}" ;;
    *) return 1 ;;
  esac
}

available_plur() {
  curl -s --max-time 5 "http://127.0.0.1:$1/chequebook/balance" 2>/dev/null |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["availableBalance"])' 2>/dev/null
}

# ⛔⛔⛔ THE ARMS MUST BE THE TWO CONDITIONS, AND THIS IS WHERE THAT IS ESTABLISHED.
#
# Two ways to lose the sitting silently. A funded node with an empty chequebook makes the funded arm a
# second unfunded arm, and a funded UNFUNDED node makes both arms the same again. Either way both
# columns agree, nothing looks wrong, and the report says funding makes no difference to a viewer.
#
# The unfunded side is delegated rather than re-implemented: `unfunded-gateway.sh status` is the
# definition of that condition, it reads a status code rather than a curl exit code, and it refuses a
# node that is merely syncing as well as one that is missing.
conditions_are_distinct() {
  local have
  have="$(available_plur "${GATEWAY_BEE_PORT}")"
  if [ -z "${have}" ]; then
    say "  REFUSING: the funded gateway on ${GATEWAY_BEE_PORT} has no chequebook, so both arms would be unfunded"
    return 1
  fi
  say "  funded arm confirmed on the node: $(bzz "${have}") BZZ spendable"

  if ! UNFUNDED_API_PORT="${UNFUNDED_BEE_PORT}" bash "${UNFUNDED_GATEWAY}" status >> "${LOG}" 2>&1; then
    say "  REFUSING: the node on ${UNFUNDED_BEE_PORT} is not the unfunded arm, see the lines above"
    return 1
  fi
  say "  unfunded arm confirmed on the node: no chequebook"
  return 0
}

# Zero when every node that can spend can pay for the given minutes.
#
# ⛔ The unfunded gateway is deliberately absent. It has no chequebook by construction, and asking
# whether it can pay would refuse the sitting on the strength of its own treatment. That mistake has a
# second home in this repo: `node_metrics.py` reads a missing chequebook as "the budget is unknown",
# which is right for a node that is supposed to have one and would stop this sitting mid-arm. That is
# why the sampler below is never pointed at the unfunded node.
can_afford() {
  local minutes="$1" short=0 who port burn have need
  for pair in "uploader:${UPLOADER_BEE_PORT}:${UPLOADER_BURN_PLUR_PER_MIN}" \
    "funded gateway:${GATEWAY_BEE_PORT}:${GATEWAY_BURN_PLUR_PER_MIN}"; do
    who="${pair%%:*}"
    port="$(echo "${pair}" | cut -d: -f2)"
    burn="$(echo "${pair}" | cut -d: -f3)"
    have="$(available_plur "${port}")"
    # Dividing before the margin keeps a long sitting clear of the 64-bit ceiling, where a wrapped
    # negative would make the comparison below pass. The truncation it costs is twelve orders of
    # magnitude below anything decidable.
    # shellcheck disable=SC2017
    need=$((burn * minutes / 100 * FUNDS_MARGIN_PERCENT))
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

# ⛔⛔ Only removes publishers this run created. The names present beforehand are recorded once and
# excluded from every teardown, because this runs on a box carrying other people's sittings and a
# teardown keyed on a name pattern killed a live paid broadcast on 2026-08-12.
PUBLISHERS_NOT_OURS="$(docker ps -aq --filter 'name=^swarm-hls-publish-' 2>/dev/null | tr '\n' ' ')"

stop_publisher() {
  local id
  # ⛔⛔ Before the removal and never after it. The publisher polls its own container, so it can see it
  # go, and a marker written afterwards leaves a window in which it reports a broadcast this script
  # ended on purpose as a failed publish. See `publisher-stop.sh`.
  request_publisher_stop
  for id in $(docker ps -aq --filter 'name=^swarm-hls-publish-' 2>/dev/null); do
    case " ${PUBLISHERS_NOT_OURS} " in
      *" ${id} "*) continue ;;
    esac
    docker rm -f "${id}" > /dev/null 2>&1 || true
  done
}

start_publisher() {
  local seconds="$1"
  stop_publisher
  (
    cd "${BENCH_REPO}" || exit 1
    # The marker above is cleared by the publisher itself at startup, which is what stops one sitting's
    # teardown from vouching for the next one's failure.
    deploy/scripts/publish-clock.sh \
      "--profile=${PROFILE}" "--portSlot=${PORT_SLOT}" --host=localhost \
      "--seconds=${seconds}" "--size=${SIZE}" "--bitrate=${BITRATE_KBPS}" "--gop=${GOP_SECONDS}" \
      "--stop-file=${PUBLISHER_STOP_FILE}"
  ) >> "${LOG}" 2>&1 &
}

active_streams() {
  curl -s --max-time 5 "http://127.0.0.1:${UPLOADER_API_PORT}/health" 2>/dev/null |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["activeStreams"])' 2>/dev/null
}

wait_for_active_stream() {
  local deadline=$(($(date -u +%s) + STREAM_TIMEOUT_S)) active
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    active="$(active_streams)"
    [ "${active:-0}" -ge 1 ] 2>/dev/null && return 0
    sleep 3
  done
  say "  no stream reached the uploader within ${STREAM_TIMEOUT_S}s of the publisher starting"
  return 1
}

wait_for_quiet() {
  local deadline=$(($(date -u +%s) + QUIET_TIMEOUT_S)) active
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    active="$(active_streams)"
    [ "${active:-1}" -eq 0 ] 2>/dev/null && return 0
    sleep 3
  done
  say "  the uploader still reports a live stream ${QUIET_TIMEOUT_S}s after the publisher was removed"
  return 1
}

# ⛔⛔ By exact name, never by pattern, and for the same reason as the publisher above. The image also
# serves a single Xvfb display, so a leftover container makes every later arm fail with
# `Cannot establish any listening sockets`, which reads as a broken browser rather than a stale one.
reclaim_browser_containers() {
  local name
  for name in "${BROWSER_CONTAINER_NAME}" "${BROWSER_CONTAINER_NAME}-selfcheck" "${BROWSER_CONTAINER_NAME}-check"; do
    if docker ps -aq --filter "name=^${name}$" 2>/dev/null | grep -q .; then
      say "  removing a leftover ${name}, which would hold the Xvfb display against every arm"
      docker rm -f "${name}" > /dev/null 2>&1 || true
    fi
  done
}

# ⛔ The host has no Chrome. `e2e/Dockerfile.browser` is where it lives, together with the Xvfb display
# that makes the page genuinely foregrounded, and this script runs ON the host. `E2E_SSH_TARGET=local`
# because the harness default transport is ssh and neither the container nor the host has a key with
# which to reach the host.
run_in_browser_image() {
  local name="$1"
  shift
  docker run --rm --network host \
    --name "${name}" \
    -u "$(id -u):$(id -g)" \
    -v "${BENCH_REPO}:/repo" \
    -e HOME=/tmp \
    -w /repo \
    -e E2E_SSH_TARGET=local \
    -e E2E_PUBLIC_HOST=127.0.0.1 \
    -e "E2E_PROFILE=${PROFILE}" \
    -e "E2E_PORT_SLOT=${PORT_SLOT}" \
    -e "BROWSER_CLIENT_URL=http://127.0.0.1:${CLIENT_PORT}" \
    "$@"
}

run_browser_arm() {
  local seconds="$1" arm="$2" gateway="$3"
  docker run --rm --network host \
    --name "${BROWSER_CONTAINER_NAME}" \
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
    -e "BROWSER_CLIENT_URL=http://127.0.0.1:${CLIENT_PORT}" \
    -e "BROWSER_WATCH_SECONDS=${seconds}" \
    -e "BROWSER_GOP_SECONDS=${GOP_SECONDS}" \
    -e "BROWSER_GATEWAY_ARM=${arm}" \
    -e "BROWSER_GATEWAY_URL=${gateway}" \
    "${BROWSER_IMAGE}" pnpm browser:watch
}

# Both nodes either side of every arm, not only the one this arm reads.
#
# ⭐ The idle gateway is the control for anything that is not the treatment. If its retrieval counters
# move during an arm it is not serving, then something else on this box is using it, and a difference
# between the arms would be partly that. Reading only the arm's own node is how a sitting ends up with
# a number and no way to rule the neighbours out.
#
# ⛔ The SAMPLER is deliberately not part of this and never points at the unfunded node. Its job is to
# stop a run whose chequebook is draining, and `node_metrics.py` reads a missing chequebook as an
# unknown budget, so an unfunded node would fail the floors check on the strength of being the
# treatment. A node that cannot spend cannot run dry.
# ⭐ `on-funded` rather than `funded`, because the arm is also called funded or unfunded and a file
# named `arm01-round1-unfunded-unfunded-before` does not say which half is the condition and which is
# the node. `arm01-round1-unfunded-on-funded-before` reads as the unfunded arm, read off the funded
# gateway, before it ran.
bracket_both_gateways() {
  local slug="$1" phase="$2"
  snapshot_metrics "${METRICS_DIR}/${slug}-on-funded-${phase}.json" "${slug}-on-funded-${phase}" \
    "${GATEWAY_BEE_PORT}"
  snapshot_metrics "${METRICS_DIR}/${slug}-on-unfunded-${phase}.json" "${slug}-on-unfunded-${phase}" \
    "${UNFUNDED_BEE_PORT}"
}

diff_both_gateways() {
  local slug="$1" headline="$2" which
  for which in funded unfunded; do
    diff_metrics "${METRICS_DIR}/${slug}-on-${which}-before.json" "${METRICS_DIR}/${slug}-on-${which}-after.json" \
      "${METRICS_DIR}/${slug}-on-${which}-diff.txt" "${headline} (read off the ${which} gateway)"
  done
}

record() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$1" "$2" "$3" "$4" "$5" >> "${STATE}"
}

run_arm() {
  local arm="$1" index="$2" round="$3" counted="$4"
  local watch_seconds=$((ARM_MINUTES * 60))
  local slug gateway
  slug="$(printf 'arm%02d-round%d-%s' "${index}" "${round}" "${arm}")"
  gateway="$(gateway_url_for "${arm}")" || {
    say "arm ${index}: ${arm} is not a condition this script knows"
    return 1
  }
  say "arm ${index} (round ${round}): ${arm} via ${gateway}, watching ${watch_seconds}s"

  if [ -f "${STOP_FILE}" ]; then
    say "STOPPING before arm ${index}: an earlier reading crossed a floor and left ${STOP_FILE}"
    return 1
  fi
  if ! can_afford "${ARM_MINUTES}"; then
    say "STOPPING before arm ${index}: cannot pay for it"
    return 1
  fi
  if ! has_capacity "${ARM_MINUTES}"; then
    say "STOPPING before arm ${index}: the postage batch cannot carry it"
    return 1
  fi
  # ⛔ Re-checked per arm rather than once at the top. A node that gained a chequebook, lost one, or
  # went away between arms turns the rest of the sitting into arms of a condition nobody recorded, and
  # it costs one HTTP call to notice.
  if ! conditions_are_distinct; then
    say "STOPPING before arm ${index}: the two gateways are no longer two conditions"
    return 1
  fi
  # The broadcast runs once for the whole sitting, so an arm has to ask whether it is still up rather
  # than starting one of its own.
  if [ "$(active_streams || echo 0)" -lt 1 ] 2>/dev/null; then
    say "  the uploader reports no live stream, so this arm has nothing to watch"
    record "${index}" "${round}" "${arm}" "${counted}" "NO-STREAM"
    return 1
  fi

  bracket_both_gateways "${slug}" before
  # ⛔⛔⛔ Reads GATEWAY_BEE_PORT and never the ultra-light node. `node_metrics.py` treats a missing
  # chequebook as "the budget is unknown" and writes the stop file, so pointing the sampler at the
  # unfunded gateway would abort the sitting on the strength of its own treatment, mid-arm, after the
  # broadcast was paid for. A node that cannot spend cannot run dry.
  start_sampler "${METRICS_DIR}/${slug}-series" "${slug}"

  run_browser_arm "${watch_seconds}" "${arm}" "${gateway}" >> "${LOG}" 2>&1 &
  local watch_pid=$! status=0

  # ⭐ A floor crossed mid-arm stops the BROADCAST and not the watch. Killing the watch would throw
  # away every sample the arm had already taken. The watch runs on to its own deadline against a dead
  # stream, costing time and nothing else, and the stop file says where to cut the series.
  while kill -0 "${watch_pid}" 2>/dev/null; do
    if [ -f "${STOP_FILE}" ]; then
      say "  a floor was crossed mid-arm, stopping the broadcast now and letting the watch write out"
      stop_publisher
      break
    fi
    sleep "${STOP_POLL_S}"
  done
  wait "${watch_pid}" || status=$?

  stop_sampler
  bracket_both_gateways "${slug}" after
  diff_both_gateways "${slug}" "  what the nodes say arm ${index} did:"

  # ⛔ A non-zero watch here is most often the readback refusing the arm, which is the harness working
  # rather than failing. It is recorded as its own outcome so nobody reads it as a viewer result.
  record "${index}" "${round}" "${arm}" "${counted}" \
    "$([ ${status} -eq 0 ] && echo ok || echo "WATCH-FAILED(${status})")"
  say "arm ${index} finished, status ${status}"
  return 0
}

TOTAL_ARMS=$((ROUNDS * 2))
SITTING_SECONDS=$((PUBLISHER_LEAD_S * 2 + TOTAL_ARMS * (ARM_MINUTES * 60 + ARM_GAP_S + ARM_OVERHEAD_S)))
SITTING_MINUTES=$(((SITTING_SECONDS + 59) / 60))

if [ "${ARM_MINUTES}" -lt 2 ]; then
  say "REFUSING TO START: ARM_MINUTES=${ARM_MINUTES} is too short for a player to reach steady state"
  exit 1
fi

say "gateway-funding-arms starting: ${ROUNDS} rounds x 2 arms x ${ARM_MINUTES} min"
say "  one broadcast of ${SITTING_MINUTES} min at a ${GOP_SECONDS}s GOP, ${SIZE} at ${BITRATE_KBPS} kbps"
if [ "${WARMUP_ROUNDS}" -gt 0 ]; then
  say "  the first ${WARMUP_ROUNDS} round(s) are warm-up and are discarded"
else
  say "  no warm-up round, so every arm counts"
fi

# ⛔ Every refusal that costs nothing comes first, and only then is anything touched or run.
if [ -f "${STOP_FILE}" ]; then
  say "REFUSING TO START: a floor was already crossed and ${STOP_FILE} says so:"
  sed 's/^/  /' "${STOP_FILE}" >> "${LOG}"
  exit 1
fi
if ! docker image inspect "${BROWSER_IMAGE}" > /dev/null 2>&1; then
  say "REFUSING TO START: ${BROWSER_IMAGE} is not on this host, so no arm could open a browser"
  exit 1
fi
if ! conditions_are_distinct; then
  say "REFUSING TO START: the two gateways are not two conditions, so this sitting has no contrast"
  exit 1
fi
if ! can_afford "${SITTING_MINUTES}"; then
  say "REFUSING TO START: this sitting cannot pay for itself"
  exit 1
fi
if ! has_capacity "${SITTING_MINUTES}"; then
  say "REFUSING TO START: the postage batch cannot carry this sitting"
  exit 1
fi

bracket_both_gateways sitting before

reclaim_browser_containers

# The order comes from the harness so this script does not carry a second copy of the rule. ⛔ Read
# before the free checks below rather than after, because an unreadable order is a refusal and a
# refusal should cost the least it can.
ARM_ORDER="$(run_in_browser_image "${BROWSER_CONTAINER_NAME}-check" "${BROWSER_IMAGE}" \
  pnpm --silent browser:arm-order "${ROUNDS}" 2>> "${LOG}" | tr -d '\r')"
read -r -a ARMS <<< "${ARM_ORDER}"
if [ "${#ARMS[@]}" -ne "${TOTAL_ARMS}" ]; then
  say "REFUSING TO START: browser:arm-order gave ${#ARMS[@]} arms for ${ROUNDS} rounds, wanted ${TOTAL_ARMS}"
  exit 1
fi
say "  arm order: ${ARM_ORDER}"

if [ "${RUN_SELFCHECK}" = "1" ]; then
  say "  running the free checks before spending anything"
  if ! run_in_browser_image "${BROWSER_CONTAINER_NAME}-selfcheck" "${BROWSER_IMAGE}" \
    pnpm browser:selfcheck >> "${LOG}" 2>&1; then
    say "REFUSING TO START: the browser selfcheck failed, so no arm here could measure a viewer"
    exit 1
  fi
  # ⛔⛔⛔ The one that matters most. A client built without VITE_EXPOSE_PLAYER publishes no switch,
  # every arm then reads the default gateway, both columns hold the same node and the sitting reports
  # that funding makes no difference to a viewer. The per-arm readback catches it too, but only once a
  # broadcast is running and paid for.
  if ! run_in_browser_image "${BROWSER_CONTAINER_NAME}-check" "${BROWSER_IMAGE}" \
    pnpm browser:gateway-check >> "${LOG}" 2>&1; then
    say "REFUSING TO START: the deployed client cannot be moved between gateways, so both arms would be one"
    exit 1
  fi
  say "  free checks passed, and the client can be moved between gateways"
fi

# ⭐ Below every check and above the only thing that spends, so a dry run is a COMPLETE dry run. An
# earlier version stopped before the browser checks, which left the most important precondition in the
# repo, whether the deployed client can be moved between gateways at all, reachable only by starting a
# broadcast. The first real use of that check found the deployed client was eleven hours too old to
# have the switch in it, and finding that in a dry run is the entire point.
[ "${PREFLIGHT_ONLY:-0}" = "1" ] && {
  say "PREFLIGHT_ONLY: every gate passed and nothing was published"
  exit 0
}

# Installed only here, past every exit that publishes nothing, so a run that starts no broadcast can
# never tear one down on its way out.
trap 'stop_sampler; stop_publisher; reclaim_browser_containers' EXIT INT TERM

say "starting the one broadcast this sitting reads, for ${SITTING_SECONDS}s"
say "  budget per arm: ${ARM_MINUTES}m watch + ${ARM_GAP_S}s gap + ${ARM_OVERHEAD_S}s for the join and the readings"
BROADCAST_STARTED_AT="$(date -u +%s)"
start_publisher "${SITTING_SECONDS}"
if ! wait_for_active_stream; then
  stop_publisher
  say "REFUSING TO CONTINUE: the broadcast never reached the uploader"
  exit 1
fi
say "  the broadcast is live, leading the first arm by ${PUBLISHER_LEAD_S}s"
sleep "${PUBLISHER_LEAD_S}"

for index in $(seq 1 "${TOTAL_ARMS}"); do
  round=$(((index + 1) / 2))
  run_arm "${ARMS[index - 1]}" "${index}" "${round}" \
    "$([ "${round}" -le "${WARMUP_ROUNDS}" ] && echo warm-up || echo counted)" || break
  [ "${index}" -lt "${TOTAL_ARMS}" ] && sleep "${ARM_GAP_S}"
done

# ⭐ Whether the broadcast outlasted the arms, as a recorded fact rather than something to infer from a
# NO-STREAM row. An overrun means ARM_OVERHEAD_S is too small for this host, and the next sitting
# should be told a number rather than left to rediscover it.
ARMS_TOOK=$(($(date -u +%s) - BROADCAST_STARTED_AT))
if [ "${ARMS_TOOK}" -gt "${SITTING_SECONDS}" ]; then
  say "⚠️ the arms took ${ARMS_TOOK}s against a ${SITTING_SECONDS}s broadcast, so the last of them ran past it"
  say "   raise ARM_OVERHEAD_S above ${ARM_OVERHEAD_S} before the next sitting"
else
  say "the arms took ${ARMS_TOOK}s of a ${SITTING_SECONDS}s broadcast, $((SITTING_SECONDS - ARMS_TOOK))s to spare"
fi

stop_publisher
wait_for_quiet
bracket_both_gateways sitting after
diff_both_gateways sitting "what the nodes say the whole sitting did:"
say "gateway-funding-arms done: $(wc -l < "${STATE}") arms recorded"
