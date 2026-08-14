#!/usr/bin/env bash
#
# What a viewer gets when the segment bytes come from a Swarm node IN THEIR OWN TAB, against the same
# viewer reading the same broadcast through a gateway, under a single LIVE broadcast.
#
# ## The gap this closes
#
# #92 phase A2 proved the in-tab path works and plays: a full recording, every segment byte from the
# node, zero `/bytes/` requests against the gateway arm's 118, all seeks landed. ⚠️ That was **VOD**.
# A recording lets a player fetch as far ahead as it likes, and the weeb-3 arm used that freedom: it
# held 19.99s of buffer against the gateway arm's 47.98s and played real time anyway. A live edge has
# no ahead to fetch into. Nothing measured so far says whether the in-tab node keeps up when the only
# segment available is the one that was published a moment ago.
#
# ## Why one broadcast
#
# ⛔⛔⛔ Two arms drawing from two broadcasts is how the fragment-size cliff was found and withdrawn:
# both arms drew from one corpus whose health was moving, and neither a within-round contrast nor a
# replicate saved it. The publisher runs ONCE here, so both arms read the same content, from the same
# encoder, over the same window, into the same network.
#
# ## Why this is one client build and not eight
#
# A2 compared the two paths by rebuilding and redeploying the client between arms, because the byte
# source was a build-time flag. That put two differences into one comparison and made a counterbalanced
# order impractical. PR #185 moved the switch to runtime, so the whole sitting runs on one build and
# the arms differ in one thing.
#
# ## ⛔ What differs between the arms, stated rather than implied
#
# Only SEGMENT bytes move. The catalog, the feed and the manifest still come from the gateway in both
# arms, by the design of PR #183. A weeb-3 arm is not a gateway-less viewer, it is a viewer whose video
# comes from its own node. #44 was withdrawn for blurring exactly that line.
#
# ## Two warm gateways, neither of them touched
#
# ⛔ This script never restarts, recreates or funds a node. The gateway is expected warm and peered,
# since a cold one costs 2-3x for about two minutes and a fresh one needs some thirteen minutes of
# chain sync.
#
# Usage, from the repo root on the deployment host:
#   ROUNDS=4 ARM_MINUTES=6 bash deploy/scripts/byte-source-arms.sh
set -u

BENCH_REPO="${BENCH_REPO:-/home/solarpunk/swarm-hls-bench}"
PROFILE="${PROFILE:-latbench}"
PORT_SLOT="${PORT_SLOT:-7}"

# Four rounds of two arms. The order is counterbalanced and comes from the harness rather than from
# arithmetic repeated here, see `browser:byte-source-order`.
ROUNDS="${ROUNDS:-4}"
# ⛔ The first arms of a sitting run differently, which has cost two sittings here. One round is
# discarded by default, which at two arms per round is the two the record says to drop.
WARMUP_ROUNDS="${WARMUP_ROUNDS:-1}"
ARM_MINUTES="${ARM_MINUTES:-6}"
ARM_GAP_S="${ARM_GAP_S:-20}"
# ⛔⛔ HIGHER THAN THE GATEWAY SITTING'S 90, AND THE DIFFERENCE IS NOT PADDING. Every arm here also
# waits out `BROWSER_SETTLE_SECONDS` before its window opens, and a weeb-3 arm spends part of that
# booting a node: 4.5 MB of wasm and a peer dial that A2 timed at 9.4-10.5s. An overhead budgeted for
# the gateway sitting would run the broadcast out before the last arms, which is how a paid sitting
# comes back short of the replicates it was booked for.
ARM_OVERHEAD_S="${ARM_OVERHEAD_S:-170}"
# How long the broadcast leads the first arm and outlives the last.
PUBLISHER_LEAD_S="${PUBLISHER_LEAD_S:-60}"
# Passed to the watch, which measures it from playback starting rather than from the switch, so both
# conditions open their window on a player of the same age.
SETTLE_SECONDS="${SETTLE_SECONDS:-60}"
# What every arm's viewer is held at, applied identically to both conditions so it stays a constant
# rather than becoming a second treatment.
#
# ⛔⛔⛔ 6 IS WHERE THE 2026-08-13 SITTING COULD NOT TELL THE TWO CONDITIONS APART. Every weeb-3 arm
# read exactly 6.03s against a `LIVE_SYNC_DURATION_S` of 6, and so did two of three gateway arms. A
# column sitting at a configured cap says both conditions reached the target and nothing at all about
# which of them could have gone lower. Cutting it is what gives them room to separate.
TARGET_LATENCY_S="${TARGET_LATENCY_S:-2}"

SIZE="${SIZE:-1280x720}"
BITRATE_KBPS="${BITRATE_KBPS:-2500}"
GOP_SECONDS="${GOP_SECONDS:-0.5}"

UPLOADER_API_PORT="${UPLOADER_API_PORT:-$((10000 + PORT_SLOT * 10))}"
UPLOADER_BEE_PORT="${UPLOADER_BEE_PORT:-$((10005 + PORT_SLOT * 10))}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-$((10007 + PORT_SLOT * 10))}"
CLIENT_PORT="${CLIENT_PORT:-$((10004 + PORT_SLOT * 10))}"

STREAM_TIMEOUT_S="${STREAM_TIMEOUT_S:-180}"
QUIET_TIMEOUT_S="${QUIET_TIMEOUT_S:-120}"
STOP_POLL_S="${STOP_POLL_S:-5}"

BROWSER_IMAGE="${BROWSER_IMAGE:-swarm-hls-browser:latest}"
BROWSER_CONTAINER_NAME="${BROWSER_CONTAINER_NAME:-byte-source-browser}"
RUN_SELFCHECK="${RUN_SELFCHECK:-1}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RATES="${HERE}/burn-rates.sh"
# shellcheck source=deploy/scripts/burn-rates.sh
. "${RATES}" || {
  echo "cannot read ${RATES}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}

OUT_DIR="${OUT_DIR:-/home/solarpunk/byte-source-arms/$(date -u +%Y%m%d-%H%M%S)}"
LOG="${OUT_DIR}/byte-source-arms.log"
STATE="${OUT_DIR}/byte-source-arms-state.tsv"
mkdir -p "${OUT_DIR}"

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >> "${LOG}"; }

GATES="${HERE}/capacity-gate.sh"
# shellcheck source=deploy/scripts/capacity-gate.sh
. "${GATES}" || {
  echo "cannot read ${GATES}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}
# ⛔⛔⛔ SET BEFORE metrics-bracket.sh IS SOURCED, WHERE IT DEFAULTS TO ZERO AND DISABLES THE SAMPLER.
# The sampler is the only thing in this repo that writes STOP_FILE, and STOP_FILE is what this
# driver's three floor checks read. Left at zero, a sitting logs a mid-arm floor check that polls a
# file no process in the run will ever create. The two sittings of 2026-08-13 ran that way.
METRICS_INTERVAL_S="${METRICS_INTERVAL_S:-30}"
BRACKET="${HERE}/metrics-bracket.sh"
# shellcheck source=deploy/scripts/metrics-bracket.sh
. "${BRACKET}" || {
  echo "cannot read ${BRACKET}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}
CEILING="${HERE}/spend-ceiling.sh"
# What the viewer cost a machine. ⛔ The process-tree total and NOT a saturation reading: it cannot
# say whether weeb-3's single JS thread is pegged. See browser-cpu.sh.
# shellcheck source=deploy/scripts/browser-cpu.sh
. "${HERE}/browser-cpu.sh" || {
  echo "cannot read ${HERE}/browser-cpu.sh: sync deploy/scripts as a directory, not one script" >&2
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

# Zero when every node that can spend can pay for the given minutes.
can_afford() {
  local minutes="$1" short=0 who port burn have need
  for pair in "uploader:${UPLOADER_BEE_PORT}:${UPLOADER_BURN_PLUR_PER_MIN}" \
    "gateway:${GATEWAY_BEE_PORT}:${GATEWAY_BURN_PLUR_PER_MIN}"; do
    who="${pair%%:*}"
    port="$(echo "${pair}" | cut -d: -f2)"
    burn="$(echo "${pair}" | cut -d: -f3)"
    have="$(available_plur "${port}")"
    # Dividing before the margin keeps a long sitting clear of the 64-bit ceiling, where a wrapped
    # negative would make the comparison below pass.
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

# Sourced here rather than beside the other gates, because it reads a chequebook through
# available_plur() and refuses a caller that has not defined one yet.
# shellcheck source=deploy/scripts/spend-ceiling.sh
. "${CEILING}" || {
  echo "cannot read ${CEILING}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
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

# ⛔⛔ By exact name, never by pattern. The image also serves a single Xvfb display, so a leftover
# container makes every later arm fail with `Cannot establish any listening sockets`, which reads as a
# broken browser rather than a stale one.
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
# that makes the page genuinely foregrounded, and this script runs ON the host.
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

# ⭐ `BROWSER_GATEWAY_URL` is passed for BOTH arms and is the same node in both. It is not the
# treatment here, it is held fixed: seeding it makes the sitting state its gateway rather than inherit
# whatever the build defaults to, and it turns on the second request-log gate, which refuses an arm
# that fetched from any host but this one.
run_browser_arm() {
  local seconds="$1" source="$2"
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
    -e "BROWSER_GATEWAY_ARM=funded" \
    -e "BROWSER_GATEWAY_URL=http://127.0.0.1:${GATEWAY_BEE_PORT}" \
    -e "BROWSER_FETCH_BACKEND=${source}" \
    -e "BROWSER_SETTLE_SECONDS=${SETTLE_SECONDS}" \
    -e "BROWSER_TARGET_LATENCY_S=${TARGET_LATENCY_S}" \
    "${BROWSER_IMAGE}" pnpm browser:watch
}

# ⭐⭐ The node-side half of the arm check, and it is independent of anything the browser reports. A
# gateway arm should move `bee_retrieval_*` by roughly a segment per half second; a weeb-3 arm should
# barely move it at all, because only the feed and manifest reads still go that way. Two instruments
# disagreeing is how the 2026-08-13 smoke was caught, where both arms honestly reported two gateways
# while fetching all their video from one.
bracket_gateway() {
  local slug="$1" phase="$2"
  snapshot_metrics "${METRICS_DIR}/${slug}-on-gateway-${phase}.json" "${slug}-on-gateway-${phase}" \
    "${GATEWAY_BEE_PORT}"
}

record() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$1" "$2" "$3" "$4" "$5" >> "${STATE}"
}

run_arm() {
  local source="$1" index="$2" round="$3" counted="$4"
  local watch_seconds=$((ARM_MINUTES * 60))
  local slug
  slug="$(printf 'arm%02d-round%d-%s' "${index}" "${round}" "${source}")"
  say "arm ${index} (round ${round}): segment bytes from ${source}, watching ${watch_seconds}s"

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
  # The broadcast runs once for the whole sitting, so an arm has to ask whether it is still up rather
  # than starting one of its own.
  if [ "$(active_streams || echo 0)" -lt 1 ] 2>/dev/null; then
    say "  the uploader reports no live stream, so this arm has nothing to watch"
    record "${index}" "${round}" "${source}" "${counted}" "NO-STREAM"
    return 1
  fi

  bracket_gateway "${slug}" before
  # ⭐ What makes the mid-arm floor check below a control rather than a poll of a file nobody writes.
  # It also gives the arm a series, which two endpoint readings cannot: a weeb-3 arm that quietly lost
  # its node halfway through reads exactly like one that never had it, unless the shape is on record.
  start_sampler "${METRICS_DIR}/${slug}-series" "${slug}"
  # ⭐ The named CPU gap. Both arms decode the same picture, so anything this separates is the cost of
  # the byte source: a weeb-3 arm runs a Swarm node in the tab and a gateway arm does not.
  start_browser_cpu "${METRICS_DIR}/${slug}-cpu.txt" "${slug}"

  run_browser_arm "${watch_seconds}" "${source}" >> "${LOG}" 2>&1 &
  local watch_pid=$! status=0

  # ⭐ A floor crossed mid-arm stops the BROADCAST and not the watch. Killing the watch would throw
  # away every sample the arm had already taken.
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
  stop_browser_cpu
  summarize_browser_cpu "${METRICS_DIR}/${slug}-cpu.txt" "${slug}"
  bracket_gateway "${slug}" after
  diff_metrics "${METRICS_DIR}/${slug}-on-gateway-before.json" "${METRICS_DIR}/${slug}-on-gateway-after.json" \
    "${METRICS_DIR}/${slug}-on-gateway-diff.txt" "  what the gateway says arm ${index} (${source}) asked of it:"

  # ⛔ A non-zero watch here is most often a gate refusing the arm, which is the harness working rather
  # than failing. It is recorded as its own outcome so nobody reads it as a viewer result.
  record "${index}" "${round}" "${source}" "${counted}" \
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
# ⛔ The settle is spent inside the watch and before its window opens, so an overhead that does not
# cover it makes the broadcast run out under the last arms.
if [ "${ARM_OVERHEAD_S}" -le "${SETTLE_SECONDS}" ]; then
  say "REFUSING TO START: ARM_OVERHEAD_S=${ARM_OVERHEAD_S} does not cover the ${SETTLE_SECONDS}s settle"
  exit 1
fi

say "byte-source-arms starting: ${ROUNDS} rounds x 2 arms x ${ARM_MINUTES} min"
say "  one LIVE broadcast of ${SITTING_MINUTES} min at a ${GOP_SECONDS}s GOP, ${SIZE} at ${BITRATE_KBPS} kbps"
say "  each arm settles ${SETTLE_SECONDS}s from playback before its window opens"
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
if ! can_afford "${SITTING_MINUTES}"; then
  say "REFUSING TO START: this sitting cannot pay for itself"
  exit 1
fi
if ! has_capacity "${SITTING_MINUTES}"; then
  say "REFUSING TO START: the postage batch cannot carry this sitting"
  exit 1
fi
# ⛔ Distinct from can_afford above, which asks whether the node CAN pay and so authorises the whole
# balance. This asks whether the owner said it may, and it is the only one of the two that can see
# what an earlier sitting tonight already spent.
if ! within_ceiling "${SITTING_MINUTES}"; then
  say "REFUSING TO START: this sitting would spend past the authorisation in ${SPEND_LEDGER}"
  exit 1
fi

bracket_gateway sitting before

reclaim_browser_containers

ARM_ORDER="$(run_in_browser_image "${BROWSER_CONTAINER_NAME}-check" "${BROWSER_IMAGE}" \
  pnpm --silent browser:byte-source-order "${ROUNDS}" 2>> "${LOG}" | tr -d '\r')"
read -r -a ARMS <<< "${ARM_ORDER}"
if [ "${#ARMS[@]}" -ne "${TOTAL_ARMS}" ]; then
  say "REFUSING TO START: browser:byte-source-order gave ${#ARMS[@]} arms for ${ROUNDS} rounds, wanted ${TOTAL_ARMS}"
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
  # ⛔⛔⛔ THE ONE THAT MATTERS MOST, AND IT DOES TWO THINGS.
  #
  # A client built without VITE_EXPOSE_PLAYER publishes no switch, every arm then reads segments
  # through the gateway, both columns agree, and the sitting reports that an in-tab Swarm node holds a
  # live edge exactly as well as a gateway does. That is the most attractive headline this line of work
  # has, produced by nothing happening.
  #
  # ⭐ It also BOOTS A REAL NODE. A host where weeb-3 cannot reach a peer would pass every other check
  # and produce a sitting whose treatment arm simply fetched no video, and finding that out costs ten
  # seconds here against a paid broadcast there.
  if ! run_in_browser_image "${BROWSER_CONTAINER_NAME}-check" "${BROWSER_IMAGE}" \
    pnpm browser:fetch-backend-check >> "${LOG}" 2>&1; then
    say "REFUSING TO START: the client cannot be moved between byte sources here, so both arms would be one"
    exit 1
  fi
  say "  free checks passed, the switch moves, and an in-tab node can join from this host"
fi

# ⭐ Below every check and above the only thing that spends, so a dry run is a COMPLETE dry run.
[ "${PREFLIGHT_ONLY:-0}" = "1" ] && {
  say "PREFLIGHT_ONLY: every gate passed and nothing was published"
  exit 0
}

# Installed only here, past every exit that publishes nothing, so a run that starts no broadcast can
# never tear one down on its way out.
trap 'stop_sampler; stop_browser_cpu; stop_publisher; reclaim_browser_containers' EXIT INT TERM

say "starting the one broadcast this sitting reads, for ${SITTING_SECONDS}s"
say "  budget per arm: ${ARM_MINUTES}m watch + ${SETTLE_SECONDS}s settle + ${ARM_GAP_S}s gap + the join"
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
# NO-STREAM row.
ARMS_TOOK=$(($(date -u +%s) - BROADCAST_STARTED_AT))
if [ "${ARMS_TOOK}" -gt "${SITTING_SECONDS}" ]; then
  say "⚠️ the arms took ${ARMS_TOOK}s against a ${SITTING_SECONDS}s broadcast, so the last of them ran past it"
  say "   raise ARM_OVERHEAD_S above ${ARM_OVERHEAD_S} before the next sitting"
else
  say "the arms took ${ARMS_TOOK}s of a ${SITTING_SECONDS}s broadcast, $((SITTING_SECONDS - ARMS_TOOK))s to spare"
fi

stop_publisher
wait_for_quiet
bracket_gateway sitting after
diff_metrics "${METRICS_DIR}/sitting-on-gateway-before.json" "${METRICS_DIR}/sitting-on-gateway-after.json" \
  "${METRICS_DIR}/sitting-on-gateway-diff.txt" "what the gateway says the whole sitting asked of it:"
say "byte-source-arms done: $(wc -l < "${STATE}") arms recorded"
