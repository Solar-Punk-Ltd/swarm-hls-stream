#!/usr/bin/env bash
#
# Watch a real browser through several broadcasts, one configuration per arm, on the deployment host.
#
# ## Why this exists next to `sweep-interleaved.sh`
#
# That one varies the publisher and measures capture-to-fetchable with the bench. This one varies the
# publisher and measures **what a viewer's player did**, which is a different question with a
# different instrument and one thing the bench cannot see: hls.js adds
# `min(stallCount, targetduration)` to its latency target on every stall and never lowers it, and
# `targetduration` is `ceil()` of the longest segment. So two GOPs differ by what a stall *costs*,
# not only by segment length.
#
# ## Why an arm is a whole broadcast
#
# The player's buffer target can be moved under a running stream, which is what `browser:buffer-sweep`
# does. **A GOP cannot.** It is an encoder setting, so each arm publishes its own broadcast.
#
# ## Why it runs on the host
#
# `publish-clock.sh --host=localhost` is what makes the repo's own publisher usable from the machine
# it publishes to: `config.json` names every service `manager-host`, which this box cannot resolve for
# itself. Going through that script rather than composing ffmpeg here keeps the publish key
# derivation, the SRT spelling and the detached container in the one place that gets them right.
#
# ⛔ **One browser at a time, and this is not a preference.** The image shares a single Xvfb display,
# so a second browser container fails with `Cannot establish any listening sockets`. The arms are
# sequential for that reason as much as for the interleaving.
#
# Usage, from the repo root on the deployment host:
#   ARMS="obs-default:2.0 shipped:0.5" ROUNDS=3 MINUTES=8 bash deploy/scripts/viewer-arms.sh
set -u

BENCH_REPO="${BENCH_REPO:-/home/solarpunk/swarm-hls-bench}"
PROFILE="${PROFILE:-latbench}"
PORT_SLOT="${PORT_SLOT:-7}"
ROUNDS="${ROUNDS:-3}"
MINUTES="${MINUTES:-8}"
SIZE="${SIZE:-1280x720}"
BITRATE_KBPS="${BITRATE_KBPS:-2500}"
UPLOADER_API_PORT="${UPLOADER_API_PORT:-$((10000 + PORT_SLOT * 10))}"
UPLOADER_BEE_PORT="${UPLOADER_BEE_PORT:-$((10005 + PORT_SLOT * 10))}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-$((10007 + PORT_SLOT * 10))}"

# How long an arm waits for its own broadcast to appear, and for the previous one to go. Generous,
# because both are only how promptly a state change is noticed. Overridable so a test can drive the
# arm ordering without sitting out two real timeouts per arm.
STREAM_TIMEOUT_S="${STREAM_TIMEOUT_S:-180}"
QUIET_TIMEOUT_S="${QUIET_TIMEOUT_S:-120}"

# Arm names, space separated, whose gateway is restarted after the broadcast is live and before the
# browser opens. That is a **cold join**: an empty retrieval cache and no warm peer connections, which
# is the state a real viewer arrives in and the one behind the blank-player failure nobody has
# diagnosed. Named by arm rather than by a flag, so the treatment is visible in every row it produced.
#
# ⚠️ A cold gateway answers `/health` long before it is useful, measured at 2-3x read cost for about
# two minutes. That is the finding, not a problem to wait out, so this waits only for the node to
# answer at all and records how long that took.
COLD_ARMS="${COLD_ARMS:-}"
GATEWAY_CONTAINER="${GATEWAY_CONTAINER:-latbench-bee-gateway-1}"
GATEWAY_READY_TIMEOUT_S="${GATEWAY_READY_TIMEOUT_S:-300}"

# How much of an arm's broadcast is spent outside the watch: the stream has to exist before the
# browser opens and has to still be live when the last sample is taken. Subtracted from the arm, so
# a short MINUTES eats the watch rather than the margin, and at MINUTES=1 the watch would be negative.
PUBLISHER_MARGIN_S="${PUBLISHER_MARGIN_S:-90}"

# The same measured burn and margin `sweep-interleaved.sh` uses, for the same reason: a sitting that
# stops partway leaves rows measured on a node its peers have stopped serving.
UPLOADER_BURN_PLUR_PER_MIN="${UPLOADER_BURN_PLUR_PER_MIN:-325000000000000}"
GATEWAY_BURN_PLUR_PER_MIN="${GATEWAY_BURN_PLUR_PER_MIN:-267000000000000}"
FUNDS_MARGIN_PERCENT="${FUNDS_MARGIN_PERCENT:-140}"

# `name:gop`, in the order round 1 runs them. Even rounds run the reverse, so position within a round
# cannot favour a configuration.
read -r -a ARM_LIST <<< "${ARMS:-obs-default:2.0 shipped:0.5}"

# Outside BENCH_REPO, which is an rsync target with --delete.
OUT_DIR="${OUT_DIR:-/home/solarpunk/viewer-arms/$(date -u +%Y%m%d-%H%M%S)}"
LOG="${OUT_DIR}/viewer-arms.log"
STATE="${OUT_DIR}/viewer-arms-state.tsv"
mkdir -p "${OUT_DIR}"

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >> "${LOG}"; }
bzz() { printf '%d.%03d' "$(($1 / 10000000000000000))" "$((($1 % 10000000000000000) / 10000000000000))"; }

available_plur() {
  curl -s --max-time 5 "http://127.0.0.1:$1/chequebook/balance" 2>/dev/null |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["availableBalance"])' 2>/dev/null
}

# Both nodes are paid: the uploader pays peers to take chunks and the gateway pays to pull them back.
can_afford() {
  local minutes="$1" short=0 who port burn have need
  for pair in "uploader:${UPLOADER_BEE_PORT}:${UPLOADER_BURN_PLUR_PER_MIN}" \
    "gateway:${GATEWAY_BEE_PORT}:${GATEWAY_BURN_PLUR_PER_MIN}"; do
    who="${pair%%:*}"; port="$(echo "${pair}" | cut -d: -f2)"; burn="${pair##*:}"
    have="$(available_plur "${port}")"
    need=$((minutes * burn * FUNDS_MARGIN_PERCENT / 100))
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

# `publish-clock.sh` names its container `swarm-hls-publish-$$`, so there is no fixed name and killing
# the poller only kills the poller: the ffmpeg container is detached so it outlives its ssh session.
# Removing by pattern is what actually stops a broadcast, and a publisher left running holds the
# stream id against every arm that follows.
#
# ⛔⛔ **Only ever removes publishers this run created.** The pattern matches every publisher on the
# box, including one serving somebody else's live sitting, and the teardown is on an EXIT trap. On
# 2026-08-12 a PREFLIGHT_ONLY invocation of this script, which publishes nothing at all, exited
# through that trap and killed the broadcast a paid buffer sweep had been running against for forty
# minutes. The sweep went on sampling a dead stream.
#
# The names present before this run started are recorded once and excluded from every teardown.
PUBLISHERS_NOT_OURS="$(docker ps -aq --filter 'name=^swarm-hls-publish-' 2>/dev/null | tr '\n' ' ')"

stop_publisher() {
  local id
  for id in $(docker ps -aq --filter 'name=^swarm-hls-publish-' 2>/dev/null); do
    case " ${PUBLISHERS_NOT_OURS} " in
      *" ${id} "*) continue ;;
    esac
    docker rm -f "${id}" >/dev/null 2>&1 || true
  done
}

start_publisher() {
  local seconds="$1" gop="$2"
  stop_publisher
  (
    cd "${BENCH_REPO}" || exit 1
    deploy/scripts/publish-clock.sh \
      "--profile=${PROFILE}" "--portSlot=${PORT_SLOT}" --host=localhost \
      "--seconds=${seconds}" "--size=${SIZE}" "--bitrate=${BITRATE_KBPS}" "--gop=${gop}"
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

# The uploader keeps a stream active for a moment after its publisher goes. An arm that opened on the
# previous arm's stream is measuring the previous arm.
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

is_cold_arm() {
  local name="$1" candidate
  for candidate in ${COLD_ARMS}; do
    [ "${candidate}" = "${name}" ] && return 0
  done
  return 1
}

# Restarts the gateway and returns how many seconds it took to answer at all, or the word `never`.
#
# ⛔ Answering is not readiness and this does not pretend otherwise. It is the earliest moment a
# viewer could be served, which is exactly when a real one arrives.
restart_gateway() {
  local started deadline
  started="$(date -u +%s)"
  docker restart "${GATEWAY_CONTAINER}" >/dev/null 2>&1 || { echo never; return; }
  deadline=$((started + GATEWAY_READY_TIMEOUT_S))
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    if curl -s --max-time 5 "http://127.0.0.1:${GATEWAY_BEE_PORT}/health" >/dev/null 2>&1; then
      echo $(($(date -u +%s) - started))
      return
    fi
    sleep 2
  done
  echo never
}

run_arm() {
  local name="$1" gop="$2" round="$3" counted="$4" coldFor="-"
  local watch_seconds=$((MINUTES * 60 - PUBLISHER_MARGIN_S))
  say "round ${round}: ${name} (gop ${gop}) starting, watching ${watch_seconds}s"

  if ! can_afford "${MINUTES}"; then
    say "STOPPING before ${name}: cannot pay for this arm"
    return 1
  fi

  # Outlives the watch on both ends: the stream has to exist before the browser opens, and has to
  # still be live when the last sample is taken.
  start_publisher $((MINUTES * 60)) "${gop}"
  if ! wait_for_active_stream; then
    stop_publisher
    printf '%s\t%s\t%s\t%s\t%s\tcold=%s\tNO-STREAM\n' "$(date -u +%FT%TZ)" "${round}" "${name}" "${gop}" "${counted}" "${coldFor}" >> "${STATE}"
    return 0
  fi

  if is_cold_arm "${name}"; then
    coldFor="$(restart_gateway)"
    say "  gateway restarted for a cold join, answered after ${coldFor}s"
  fi

  (
    cd "${BENCH_REPO}" || exit 1
    BROWSER_CLIENT_URL="http://127.0.0.1:$((10004 + PORT_SLOT * 10))" \
      BROWSER_WATCH_SECONDS="${watch_seconds}" \
      BROWSER_GOP_SECONDS="${gop}" \
      pnpm browser:watch
  ) >> "${LOG}" 2>&1
  local status=$?

  stop_publisher
  wait_for_quiet
  printf '%s\t%s\t%s\t%s\t%s\tcold=%s\t%s\n' "$(date -u +%FT%TZ)" "${round}" "${name}" "${gop}" "${counted}" \
    "${coldFor}" "$([ ${status} -eq 0 ] && echo ok || echo "WATCH-FAILED(${status})")" >> "${STATE}"
  say "round ${round}: ${name} finished, status ${status}"
  return 0
}

# Checked before anything is published, because a negative or trivial watch produces a full set of
# arms, a full ledger and no samples, which reads as a sitting that ran.
WATCH_SECONDS=$((MINUTES * 60 - PUBLISHER_MARGIN_S))
if [ "${WATCH_SECONDS}" -lt 30 ]; then
  say "REFUSING TO START: MINUTES=${MINUTES} leaves ${WATCH_SECONDS}s to watch after a ${PUBLISHER_MARGIN_S}s publisher margin"
  exit 1
fi

TOTAL_ARMS=$((${#ARM_LIST[@]} * ROUNDS))
say "viewer-arms starting: ${#ARM_LIST[@]} arms x ${ROUNDS} rounds x ${MINUTES} min = ${TOTAL_ARMS} broadcasts"
say "  round 1 is warm-up and is discarded"
[ -n "${COLD_ARMS}" ] && say "  cold-join arms (gateway restarted before the browser opens): ${COLD_ARMS}"
if ! can_afford $((TOTAL_ARMS * MINUTES)); then
  say "REFUSING TO START: this sitting cannot pay for itself"
  exit 1
fi
[ "${PREFLIGHT_ONLY:-0}" = "1" ] && { say "PREFLIGHT_ONLY, so stopping here without publishing anything"; exit 0; }

# Installed only here, past every exit that publishes nothing, so a run that starts no broadcast can
# never tear one down on its way out.
trap 'stop_publisher' EXIT INT TERM

for round in $(seq 1 "${ROUNDS}"); do
  order=("${ARM_LIST[@]}")
  # Reversed on even rounds, so a drift across the sitting cannot line up with the swept axis.
  if [ $((round % 2)) -eq 0 ]; then
    order=()
    for ((i = ${#ARM_LIST[@]} - 1; i >= 0; i--)); do order+=("${ARM_LIST[i]}"); done
  fi
  for arm in "${order[@]}"; do
    run_arm "${arm%%:*}" "${arm##*:}" "${round}" \
      "$([ "${round}" -eq 1 ] && echo warm-up || echo counted)" || break 2
  done
done

say "viewer-arms done: $(wc -l < "${STATE}") arms recorded"
