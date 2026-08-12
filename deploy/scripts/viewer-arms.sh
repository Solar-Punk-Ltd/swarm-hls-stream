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
# How many leading rounds are discarded. One by default, because the first arms of a sitting run
# differently and comparing them against later ones has cost two sittings here. ⛔ Set to 0 for a
# **soak**, which has no arm to compare against and nothing to warm up for: labelling its only round
# as discarded would file a four-hour broadcast as a warm-up nobody counted.
WARMUP_ROUNDS="${WARMUP_ROUNDS:-1}"
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
#
# ⭐⭐⭐ COST IS PER BROADCAST, NOT ONLY PER MINUTE. Measured 2026-08-12 night, two sittings.
#
# The 120-minute soak burned **0.78 BZZ/hr on the uploader and 0.64 on the gateway, and the rate was
# FLAT**: four independent 30-minute windows read 0.80, 0.75, 0.79, 0.80. That is a replicate inside
# one sitting, and it is the marginal cost of broadcasting.
#
# ⛔ The arm sitting earlier the same night cost **2.06 BZZ/hr of broadcast**, idle-to-idle, which is
# 2.6x that. Eight broadcasts in 56 minutes against one in 119. Subtracting the marginal rate leaves
# about **1.19 BZZ across 8 starts, so roughly 0.15 BZZ per broadcast STARTED**, independent of how
# long it then runs.
#
# ⚠️ That per-broadcast figure is a FIT across two sittings, not a measurement. Its window also
# contains four failed launches and an alternating GOP. What would test it is two sittings of equal
# total broadcast time and different arm counts. Until then it is priced conservatively here, because
# being wrong about a fixed cost overstates a sweep's runway and understates a soak's.
#
# ⛔⛔ Three different values were used for these constants in one evening. The 0.0325/0.0267 that
# stood for a week, a refit DOWN to 0.0214/0.0095 that would have approved a soak the balance could
# not finish, and a refit UP to 0.0437/0.0355 derived from an arm sitting whose cost was mostly
# setup. Each was defended with arithmetic. **The one that survives is the one measured over a long
# continuous window and replicated within it.**
#
# ⚠️ 1080p burns more again. Override for a sitting that is not 720p.
UPLOADER_BURN_PLUR_PER_MIN="${UPLOADER_BURN_PLUR_PER_MIN:-130000000000000}"
GATEWAY_BURN_PLUR_PER_MIN="${GATEWAY_BURN_PLUR_PER_MIN:-107000000000000}"
# Charged once per broadcast the sitting will start, on top of the per-minute rate above.
UPLOADER_SETUP_PLUR="${UPLOADER_SETUP_PLUR:-1500000000000000}"
GATEWAY_SETUP_PLUR="${GATEWAY_SETUP_PLUR:-1200000000000000}"
FUNDS_MARGIN_PERCENT="${FUNDS_MARGIN_PERCENT:-140}"

# What the nodes themselves say they did, either side of every arm, and periodically through a long
# one. ⛔ This is not decoration on the result. Seventeen arms of the buffer sweep were scored
# entirely on what the harness saw from outside while both bee nodes kept a complete account of the
# same events that nothing read. `bee_pusher_sync_time` is the publish race; `bee_retrieval_*` is the
# fetch hop. Set METRICS_INTERVAL_S above zero for an arm long enough to need a series rather than
# two endpoints, which is also the only mid-flight funding check a single-arm sitting gets.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_METRICS="${NODE_METRICS:-${HERE}/node-metrics.sh}"
STAMP_GUARD="${STAMP_GUARD:-${HERE}/stamp-guard.sh}"
METRICS_INTERVAL_S="${METRICS_INTERVAL_S:-0}"
UPLOADER_CONTAINER="${UPLOADER_CONTAINER:-latbench-stream-uploader-1}"
# How often the arm loop looks for a crossed floor while its watch runs. Five seconds against a
# four-hour arm is under a thousandth of it; a test with a stubbed watch pays it per arm, so it is
# overridable.
STOP_POLL_S="${STOP_POLL_S:-5}"

BROWSER_IMAGE="${BROWSER_IMAGE:-swarm-hls-browser:latest}"
BROWSER_CONTAINER_NAME="${BROWSER_CONTAINER_NAME:-viewer-arms-browser}"

# The free canary, run once per sitting before anything is published. It launches the browser, loads
# the client page and proves the instrument can fail, for no broadcast and no BZZ.
# ⭐ Three separate faults on 2026-08-12 were found by a paid arm when a free check could have found
# them, which is the lesson the selfcheck was written for in the first place.
RUN_SELFCHECK="${RUN_SELFCHECK:-1}"

# `name:gop`, in the order round 1 runs them. Even rounds run the reverse, so position within a round
# cannot favour a configuration.
read -r -a ARM_LIST <<< "${ARMS:-obs-default:2.0 shipped:0.5}"

# Outside BENCH_REPO, which is an rsync target with --delete.
OUT_DIR="${OUT_DIR:-/home/solarpunk/viewer-arms/$(date -u +%Y%m%d-%H%M%S)}"
LOG="${OUT_DIR}/viewer-arms.log"
STATE="${OUT_DIR}/viewer-arms-state.tsv"
METRICS_DIR="${OUT_DIR}/node-metrics"
# Written by the sampler when a floor is crossed, read by the arm loop and by whatever runs next.
# ⭐ Its presence is the record of WHEN a sitting stopped being trustworthy, which two endpoint
# readings cannot show and which no amount of care after the fact can reconstruct.
#
# Overridable so a chain of sittings can share one, which is what makes a crossed floor stop the
# night rather than one sitting: the node does not refill between them.
STOP_FILE="${STOP_FILE:-${OUT_DIR}/STOP}"
mkdir -p "${OUT_DIR}" "${METRICS_DIR}"

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >> "${LOG}"; }

bzz() { printf '%d.%03d' "$(($1 / 10000000000000000))" "$((($1 % 10000000000000000) / 10000000000000))"; }

available_plur() {
  curl -s --max-time 5 "http://127.0.0.1:$1/chequebook/balance" 2>/dev/null |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["availableBalance"])' 2>/dev/null
}

# Both nodes are paid: the uploader pays peers to take chunks and the gateway pays to pull them back.
#
# ⭐ Priced as minutes AND broadcasts, because the two sittings of 2026-08-12 night differed by 2.6x
# per broadcast hour and the difference tracks how many broadcasts each started, not how long each
# ran. A sweep of eight short arms is dominated by setup; a soak is dominated by minutes.
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

# ⛔ Read off the container that is actually publishing, never off a file. `.env.latbench` is
# gitignored and lives on the host, `/stamps` lists four batches of which three are dead, and
# "the stamp" has meant a different row on three separate days here. The uploader's own environment
# is the only source that cannot be stale.
resolve_stamp() {
  [ -n "${STAMP:-}" ] && { printf '%s' "${STAMP}"; return 0; }
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${UPLOADER_CONTAINER}" 2>/dev/null |
    sed -n 's/^STAMP=//p' | head -1
}

# Capacity, checked the same way funding is: before the spend, as something that refuses.
#
# ⛔ The rule this enforces was already written down, in bold, in two places, and read automatically
# by `e2e/src/browser/resources.ts` — which warns at the END of a run, after the broadcast is paid
# for. Three sittings ran past the 75% line on 2026-08-12 because remembering to look was the only
# thing between the threshold and the spend.
has_capacity() {
  local minutes="$1" batch
  batch="$(resolve_stamp)"
  if [ -z "${batch}" ]; then
    say "  REFUSING: could not read STAMP off ${UPLOADER_CONTAINER}, so batch capacity is unknown"
    return 1
  fi
  if ! STAMP_GUARD_PORT="${UPLOADER_BEE_PORT}" bash "${STAMP_GUARD}" \
    --batch "${batch}" --minutes "${minutes}" --port "${UPLOADER_BEE_PORT}" >> "${LOG}" 2>&1; then
    say "  REFUSING: stamp-guard says this sitting cannot finish on batch ${batch:0:8}"
    return 1
  fi
  return 0
}

snapshot_metrics() {
  local out="$1" label="$2"
  UPLOADER_BEE_PORT="${UPLOADER_BEE_PORT}" GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT}" \
    UPLOADER_API_PORT="${UPLOADER_API_PORT}" bash "${NODE_METRICS}" snapshot "${out}" "${label}" \
    >> "${LOG}" 2>&1 || say "  node-metrics snapshot ${label} failed, so this arm has no node account"
}

SAMPLER_PID=""
start_sampler() {
  local dir="$1" label="$2"
  [ "${METRICS_INTERVAL_S}" -gt 0 ] 2>/dev/null || return 0
  mkdir -p "${dir}"
  # ⛔ STAMP is passed because the sampler's capacity floor applies to the batch this sitting writes
  # to and to no other. /stamps lists every batch the node ever bought, three of which are dead here.
  UPLOADER_BEE_PORT="${UPLOADER_BEE_PORT}" GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT}" \
    UPLOADER_API_PORT="${UPLOADER_API_PORT}" STAMP="$(resolve_stamp)" bash "${NODE_METRICS}" \
    watch "${dir}" "${METRICS_INTERVAL_S}" "${STOP_FILE}" "${label}" >> "${LOG}" 2>&1 &
  SAMPLER_PID=$!
  say "  sampling both nodes every ${METRICS_INTERVAL_S}s into $(basename "${dir}")"
}

stop_sampler() {
  [ -n "${SAMPLER_PID}" ] || return 0
  kill "${SAMPLER_PID}" 2>/dev/null || true
  wait "${SAMPLER_PID}" 2>/dev/null || true
  SAMPLER_PID=""
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

# Reclaim this driver's own browser container, by the exact name it gives them and nothing else.
#
# ⛔ The image serves one Xvfb display, so a leftover container makes every later run fail with
# `Cannot establish any listening sockets`, which reads as a broken browser rather than as a stale
# one. Killing a chain leaves exactly that: the driver dies, its `docker run` does not.
#
# ⛔⛔ By exact name, never by pattern. A teardown keyed on a name pattern killed a live paid
# broadcast on 2026-08-12, and this box carries forty other bee nodes and eight unrelated stacks
# whose containers are not ours to touch.
reclaim_browser_containers() {
  local name
  for name in "${BROWSER_CONTAINER_NAME}" "${BROWSER_CONTAINER_NAME}-selfcheck"; do
    if docker ps -aq --filter "name=^${name}$" 2>/dev/null | grep -q .; then
      say "  removing a leftover ${name}, which would hold the Xvfb display against every arm"
      docker rm -f "${name}" >/dev/null 2>&1 || true
    fi
  done
}

# Run a browser script in the image that actually has a browser in it.
#
# ⛔ The host has no Chrome. `e2e/Dockerfile.browser` is where it lives, together with the Xvfb
# display that makes the page genuinely foregrounded, and this script runs ON the host. A first
# version called `pnpm browser:watch` directly and every arm published, paid, and then died on
# `Failed to launch chromium because executable doesn't exist at /opt/google/chrome/chrome`.
#
# `E2E_SSH_TARGET=local` for the same reason `sweep-interleaved.sh` sets it: the harness's default
# transport is `ssh`, and neither the container nor the host has a key with which to reach the host.
#
# ⛔ One at a time. The image shares a single Xvfb display, so a second container fails with
# `Cannot establish any listening sockets`, which is why arms are sequential.
run_browser() {
  local seconds="$1" gop="$2"
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
    -e "BROWSER_CLIENT_URL=http://127.0.0.1:$((10004 + PORT_SLOT * 10))" \
    -e "BROWSER_WATCH_SECONDS=${seconds}" \
    -e "BROWSER_GOP_SECONDS=${gop}" \
    "${BROWSER_IMAGE}" pnpm browser:watch
}

# The free canary, in the same image the arms will use. A selfcheck run anywhere else proves nothing
# about the browser that does the measuring.
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
  local slug="round${round}-${name}"
  say "round ${round}: ${name} (gop ${gop}) starting, watching ${watch_seconds}s"

  if [ -f "${STOP_FILE}" ]; then
    say "STOPPING before ${name}: an earlier arm crossed a floor and left ${STOP_FILE}"
    return 1
  fi
  if ! can_afford "${MINUTES}" 1; then
    say "STOPPING before ${name}: cannot pay for this arm"
    return 1
  fi
  if ! has_capacity "${MINUTES}"; then
    say "STOPPING before ${name}: the postage batch cannot carry this arm"
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

  # Taken after the gateway restart, so a cold arm's reading is of the node the viewer actually got.
  snapshot_metrics "${METRICS_DIR}/${slug}-before.json" "${slug}-before"
  start_sampler "${METRICS_DIR}/${slug}-series" "${slug}"

  run_browser "${watch_seconds}" "${gop}" >> "${LOG}" 2>&1 &
  local watch_pid=$! status=0

  # ⭐ The publisher is what spends, so a floor crossed mid-arm is answered by stopping the broadcast
  # and NOT by killing the watch. Killing it would throw away every sample the arm had already taken,
  # which on a four-hour arm is the whole result. The watch runs on to its own deadline against a
  # dead stream, costing time and nothing else, and the stop file says where to cut the series.
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
  stop_publisher
  wait_for_quiet
  snapshot_metrics "${METRICS_DIR}/${slug}-after.json" "${slug}-after"
  bash "${NODE_METRICS}" diff "${METRICS_DIR}/${slug}-before.json" "${METRICS_DIR}/${slug}-after.json" \
    > "${METRICS_DIR}/${slug}-diff.txt" 2>> "${LOG}" || true
  say "  what the nodes say this arm did:"
  sed 's/^/    /' "${METRICS_DIR}/${slug}-diff.txt" >> "${LOG}" 2>/dev/null || true

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
if [ "${WARMUP_ROUNDS}" -gt 0 ]; then
  say "  the first ${WARMUP_ROUNDS} round(s) are warm-up and are discarded"
else
  say "  no warm-up round, so every arm counts"
fi
[ -n "${COLD_ARMS}" ] && say "  cold-join arms (gateway restarted before the browser opens): ${COLD_ARMS}"
if ! docker image inspect "${BROWSER_IMAGE}" >/dev/null 2>&1; then
  say "REFUSING TO START: ${BROWSER_IMAGE} is not on this host, so no arm could open a browser"
  exit 1
fi
say "  watching in ${BROWSER_IMAGE}"

# ⛔ Every refusal that costs nothing comes first, and only then does anything get touched or run.
# A sitting that is going to refuse should leave the box exactly as it found it, which is why the
# container reclaim and the fifteen-second selfcheck sit below all four cheap gates rather than
# above them.
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
# The whole instrument surface either side of the sitting, not only either side of each arm, so a
# drift across the hour has a reading that spans it.
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

for round in $(seq 1 "${ROUNDS}"); do
  order=("${ARM_LIST[@]}")
  # Reversed on even rounds, so a drift across the sitting cannot line up with the swept axis.
  if [ $((round % 2)) -eq 0 ]; then
    order=()
    for ((i = ${#ARM_LIST[@]} - 1; i >= 0; i--)); do order+=("${ARM_LIST[i]}"); done
  fi
  for arm in "${order[@]}"; do
    run_arm "${arm%%:*}" "${arm##*:}" "${round}" \
      "$([ "${round}" -le "${WARMUP_ROUNDS}" ] && echo warm-up || echo counted)" || break 2
  done
done

snapshot_metrics "${METRICS_DIR}/sitting-after.json" "sitting-after"
bash "${NODE_METRICS}" diff "${METRICS_DIR}/sitting-before.json" "${METRICS_DIR}/sitting-after.json" \
  > "${METRICS_DIR}/sitting-diff.txt" 2>> "${LOG}" || true
say "what the nodes say the whole sitting did:"
sed 's/^/  /' "${METRICS_DIR}/sitting-diff.txt" >> "${LOG}" 2>/dev/null || true
say "viewer-arms done: $(wc -l < "${STATE}") arms recorded"
