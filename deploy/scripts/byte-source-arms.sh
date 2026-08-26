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
# or, for a question with one condition rather than two:
#   ARM_PLAN="weeb3:6:warm-up weeb3:180:counted" bash deploy/scripts/byte-source-arms.sh
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
# A sitting whose arms are NOT a counterbalanced pair, as `source:minutes:role` entries. Unset by
# default, and the counterbalance above stays the default for every question that compares two things.
#
# ⭐ It exists for the questions that have ONE condition. A drift slope is read WITHIN an arm, so the
# other byte source answers nothing and a paired sitting would buy a second broadcast hour per hour of
# result. #106 is `weeb3:6:warm-up weeb3:180:counted`, three hours instead of six.
#
# ⛔ Roles are not cosmetic: `read-sitting.py` counts round 1 as warm-up, so the roles here are what
# decide which arms a published table is allowed to contain.
ARM_PLAN="${ARM_PLAN:-}"
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

# ⛔⛔ WHICH PAIR THIS SITTING RUNS. Unset it and nothing changes: gateway against our hybrid client,
# which is every byte-source sitting run so far.
#
# `gateway-less` swaps the gateway condition for weeb-3's OWN PAGE, which is what the owner asked for
# on 2026-08-11 and what the split of PR #183 never measured.
#
# ⚠️ That contrast moves TWO things, whose page and player, and whether a gateway serves the
# manifest. It bounds the cost of going fully gateway-less rather than isolating either one.
ARM_PAIR="${ARM_PAIR:-byte-source}"

# A native arm downloads 4.5 MB of wasm and dials its own peers before it can show a frame, and A2
# timed a first retrieval right after `ready(1)` at 9.4 to 10.5 seconds. Its own boot budget, so
# raising it does not lengthen a hybrid arm that does not need it.
NATIVE_BOOT_S="${NATIVE_BOOT_S:-180}"

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

# The SRS stage this sitting publishes into, which `stage_matches_the_gop_we_asked_for` reads the raw
# `#EXTINF` out of. Named off the profile the same way the compose stack names it.
SRS_CONTAINER="${SRS_CONTAINER:-${PROFILE}-srs-1}"
# How long the fingerprint may wait for the stage to publish enough segments to have a median. At a
# 2.0s GOP the minimum below takes twelve seconds, and a stage that has not managed it in two minutes
# is not one to spend a broadcast against.
STAGE_FINGERPRINT_TIMEOUT_S="${STAGE_FINGERPRINT_TIMEOUT_S:-120}"
STAGE_FINGERPRINT_MIN_SEGMENTS="${STAGE_FINGERPRINT_MIN_SEGMENTS:-6}"

# The ladder the stage is running, which decides how many playlists the fingerprint gate must judge.
# The gate defaults to one rung, so a ladder sitting left to that default would judge a four-rung
# broadcast on one of its four. Read from the same ABR_ENABLED and ABR_LADDER that configure the SRS
# stack, so the count the gate is told is the count the stage was asked to publish.
ABR_ENABLED="${ABR_ENABLED:-false}"
# Kept in step with the entrypoint's ABR_LADDER default and AbrLadder.DEFAULT_LADDER_SPEC. A shell
# driver cannot import either, so the fallback is restated here and only its rung count is read.
DEFAULT_LADDER_SPEC='1080p:1920:1080:5000 720p:1280:720:2800 480p:854:480:1200 360p:640:360:700'
ABR_LADDER="${ABR_LADDER:-${DEFAULT_LADDER_SPEC}}"

# ⛔⛔⛔ A SITTING WITH NO THREAD READING IS REFUSED, BECAUSE THE WARNING WAS NOT ENOUGH.
#
# `browser-cpu.sh` has always said "NO SATURATION READING for <arm>: VIEWER_CDP_PORT is unset" once
# per arm. On 2026-08-15 I launched a proof sitting straight past two of those, in a run whose entire
# output is the thread column, and only noticed because a file was missing from a directory listing.
# A warning inside a detached run nobody is watching is not a control.
#
# ⚠️ Some sittings genuinely do not need it, which is why this is an opt-out rather than a hard wire.
ALLOW_NO_THREAD_READING="${ALLOW_NO_THREAD_READING:-0}"

BROWSER_IMAGE="${BROWSER_IMAGE:-swarm-hls-browser:latest}"
BROWSER_CONTAINER_NAME="${BROWSER_CONTAINER_NAME:-byte-source-browser}"
RUN_SELFCHECK="${RUN_SELFCHECK:-1}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARM_RUNTIME="${HERE}/arm-runtime.sh"
# shellcheck source=deploy/scripts/arm-runtime.sh
. "${ARM_RUNTIME}" || {
  echo "cannot read ${ARM_RUNTIME}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}

# A sibling of this file rather than a path under BENCH_REPO, which names the bench CHECKOUT and is
# about where a driver runs from, not where its own gates live. Overridable the same way
# `capacity-gate.sh` names `stamp-guard.sh`.
STAGE_FINGERPRINT="${STAGE_FINGERPRINT:-${HERE}/stage-fingerprint.sh}"

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

# ⛔⛔ WHAT THE STAGE PUBLISHED, NOT WHAT THIS DRIVER ASKED FOR.
#
# `--gop` above is a request. Until 2026-08-17 nothing checked the answer, so a sitting could run for
# hours against a stage configured differently and label every artefact with the GOP it wanted. A
# co-tenant session on this host changed `hls_fragment` on its own SRS stack that day, which is one
# wrong compose file away from being ours.
#
# ⭐ Placed after the stream is live and before the publisher lead, so a mismatch costs the seconds
# already spent reaching ingest rather than the whole broadcast. It cannot move earlier: there is no
# playlist to read until something is publishing.

# The rung count the fingerprint gate should expect. One with the ladder off, so a non-ABR sitting
# tells the gate exactly what its default already was and nothing changes. With the ladder on it is
# the word count of ABR_LADDER. The gate cross-checks this against the playlists the stage actually
# published, so a ladder judged on one rung, or a count that does not match what is running, is
# refused rather than passed.
abr_rung_count() {
  case "${ABR_ENABLED}" in
    true | 1) ;;
    *) printf '1'; return ;;
  esac
  printf '%s\n' "${ABR_LADDER}" | awk '{ print NF }'
}

stage_matches_the_gop_we_asked_for() {
  local deadline=$(($(date -u +%s) + STAGE_FINGERPRINT_TIMEOUT_S)) status
  while :; do
    # ⛔ Appended to the log AND read for its exit code. A gate whose reasoning is not in the sitting
    # record is a gate nobody can audit afterwards.
    MIN_SEGMENTS="${STAGE_FINGERPRINT_MIN_SEGMENTS}" \
      "${STAGE_FINGERPRINT}" --container "${SRS_CONTAINER}" --gop "${GOP_SECONDS}" \
      --rungs "$(abr_rung_count)" >> "${LOG}" 2>&1
    status=$?
    [ "${status}" -eq 0 ] && return 0
    # 3 is "the broadcast has not published enough segments yet", which is ordinary at this point in a
    # sitting. Anything else is a verdict and retrying it only wastes the deadline.
    [ "${status}" -ne 3 ] && return 1
    if [ "$(date -u +%s)" -ge "${deadline}" ]; then
      say "  the stage never published ${STAGE_FINGERPRINT_MIN_SEGMENTS} segments within ${STAGE_FINGERPRINT_TIMEOUT_S}s"
      return 1
    fi
    sleep 3
  done
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

# ⭐ WHO THE NATIVE ARM WATCHES, TAKEN FROM THE PUBLISHER'S OWN LOG.
#
# weeb-3's route is `#/live/stream/<owner>/<uuid>` and our uploader's `streamRawTopic` is a
# `crypto.randomUUID()`, so our identifiers paste straight in. `notifyStart` logs the catalog entry
# it announces, which carries the owner, the topic and the announce time in one line.
#
# ⭐⭐ Read from the log rather than from the catalog feed on purpose. A feed read would be a gateway
# retrieval taken during a sitting whose whole question is what reaches a gateway, and it would need
# bee-js on the host. The publisher's own record needs neither.
NATIVE_OWNER=""
NATIVE_TOPIC=""
NATIVE_BROADCAST_START_MS=""
# ⛔⛔ THE ANNOUNCE LANDS AFTER `activeStreams` REACHES 1, AND READING ONCE CATCHES THE PREVIOUS DAY'S.
# Measured on the first real run: ingest was live at 09:54:37, the catalog entry was written at
# 09:54:39.642, and a single read in between returned an announce from 26 hours earlier. Polled with a
# budget instead. The uploader retries a failed announce on its own cadence, so this waits rather than
# giving up on the first miss.
CATALOG_ANNOUNCE_TIMEOUT_S="${CATALOG_ANNOUNCE_TIMEOUT_S:-180}"

# The newest catalog announce this sitting produced, or empty. ⭐ `--since` the sitting's own start, so
# a previous day's entry cannot be read at all and the timestamp check below is a second line rather
# than the only one.
newest_announce() {
  docker logs --since "${BROADCAST_STARTED_AT}" "${UPLOADER_CONTAINER}" 2>&1 |
    grep 'Adding stream to list:' | tail -1
}

discover_native_stream() {
  local line="" deadline=$(($(date -u +%s) + CATALOG_ANNOUNCE_TIMEOUT_S))
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    line="$(newest_announce)" || true
    [ -n "${line}" ] && break
    sleep 3
  done

  if [ -z "${line}" ]; then
    say "  no catalog announce in ${CATALOG_ANNOUNCE_TIMEOUT_S}s of this broadcast, so a native arm"
    say "  has no stream to open. The uploader keeps retrying a failed announce, so this is not a"
    say "  timing miss: check msSinceCatalogAnnounceFailed on the uploader health endpoint."
    return 1
  fi

  NATIVE_OWNER="$(printf '%s' "${line}" | python3 -c 'import sys,json,re;m=re.search(r"\{.*\}",sys.stdin.read());print(json.loads(m.group(0))["owner"] if m else "")')"
  NATIVE_TOPIC="$(printf '%s' "${line}" | python3 -c 'import sys,json,re;m=re.search(r"\{.*\}",sys.stdin.read());print(json.loads(m.group(0))["topic"] if m else "")')"
  NATIVE_BROADCAST_START_MS="$(printf '%s' "${line}" | python3 -c 'import sys,json,re;m=re.search(r"\{.*\}",sys.stdin.read());print(json.loads(m.group(0))["timestamp"] if m else "")')"

  if [ -z "${NATIVE_OWNER}" ] || [ -z "${NATIVE_TOPIC}" ] || [ -z "${NATIVE_BROADCAST_START_MS}" ]; then
    say "  the catalog announce did not parse into owner, topic and timestamp: ${line}"
    return 1
  fi

  # ⛔⛔⛔ THE ANNOUNCE HAS TO BELONG TO THIS BROADCAST, AND `tail -1` ALONE DOES NOT SAY THAT.
  # Proved against the real log on 2026-08-16: the newest announce in the uploader's container was
  # from the PREVIOUS DAY. A publisher that starts but fails to announce would leave that line in
  # place, and the native arm would open a broadcast that finished yesterday, hold its end frame, and
  # be filed as a live arm. The driver's own exhaustion guard would catch that only if the recording
  # happened to run out inside the window.
  local announced_at=$((NATIVE_BROADCAST_START_MS / 1000))
  if [ "${announced_at}" -lt "${BROADCAST_STARTED_AT}" ]; then
    say "  the newest catalog announce is from $(date -u -d "@${announced_at}" +%FT%TZ), before this"
    say "  sitting started at $(date -u -d "@${BROADCAST_STARTED_AT}" +%FT%TZ), so it is a STALE stream"
    return 1
  fi

  # ⚠️ The announce time, not the first frame. It carries a constant offset from media position zero
  # that nothing here can measure, and that offset CANCELS in both the arm-to-arm contrast and the
  # within-arm drift, which is what the sitting reads. It does NOT cancel in the absolute value, so
  # no table may quote the absolute distance from live as if it were the viewer's true latency.
  say "  native arm will open owner ${NATIVE_OWNER} topic ${NATIVE_TOPIC}, announced at ${NATIVE_BROADCAST_START_MS}"
  return 0
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

# ⭐ `BROWSER_GATEWAY_URL` is passed for BOTH arms and is the same node in both. It is not the
# treatment here, it is held fixed: seeding it makes the sitting state its gateway rather than inherit
# whatever the build defaults to, and it turns on the second request-log gate, which refuses an arm
# that fetched from any host but this one.
# weeb-3's own page, opened on OUR broadcast, with nothing served by a gateway. A different driver
# because it is a different viewer: our client is not in this arm at all.
#
# ⭐ `WEEB3_NATIVE_METRICS_BRACKETED_BY` rather than `ALLOW_NO_NODE_METRICS=1`. This wrapper already
# brackets every arm through `bracket_gateway`, and the opt-out would make the artefact say it has no
# node-side evidence while the evidence sits beside it.
run_native_arm() {
  local seconds="$1"
  docker run --rm --network host \
    --name "${BROWSER_CONTAINER_NAME}" \
    -u "$(id -u):$(id -g)" \
    --group-add "$(getent group docker | cut -d: -f3)" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${BENCH_REPO}:/repo" \
    -e HOME=/tmp \
    -w /repo \
    -e "WEEB3_NATIVE_LIVE=1" \
    -e "WEEB3_NATIVE_OWNER=${NATIVE_OWNER}" \
    -e "WEEB3_NATIVE_TOPIC=${NATIVE_TOPIC}" \
    -e "WEEB3_NATIVE_BROADCAST_START_MS=${NATIVE_BROADCAST_START_MS}" \
    -e "WEEB3_NATIVE_WATCH_S=${seconds}" \
    -e "WEEB3_NATIVE_BOOT_S=${NATIVE_BOOT_S}" \
    -e "WEEB3_NATIVE_METRICS_BRACKETED_BY=byte-source-arms" \
    -e "VIEWER_CDP_PORT=${VIEWER_CDP_PORT:-}" \
    "${BROWSER_IMAGE}" pnpm browser:weeb3-native
}

run_browser_arm() {
  local seconds="$1" source="$2"
  if [ "${source}" = "native" ]; then
    run_native_arm "${seconds}"
    return $?
  fi
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
    -e "VIEWER_CDP_PORT=${VIEWER_CDP_PORT:-}" \
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

run_arm() {
  local source="$1" index="$2" round="$3" counted="$4" minutes="$5"
  local watch_seconds=$((minutes * 60))
  local slug
  slug="$(printf 'arm%02d-round%d-%s' "${index}" "${round}" "${source}")"
  say "arm ${index} (round ${round}): segment bytes from ${source}, watching ${watch_seconds}s"

  if [ -f "${STOP_FILE}" ]; then
    say "STOPPING before arm ${index}: an earlier reading crossed a floor and left ${STOP_FILE}"
    return 1
  fi
  if ! can_afford "${minutes}"; then
    say "STOPPING before arm ${index}: cannot pay for it"
    return 1
  fi
  if ! has_capacity "${minutes}"; then
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
  # ⭐⭐ The other half of the same gap, and the reason the cost reading above cannot be quoted as a
  # ceiling. weeb-3 is one JS thread, so a gateway arm and a weeb-3 arm that both cost two cores are
  # still different products if one of them has its node at 0.95 of a thread. Sampled by URL because
  # this browser has more than one page in it, and one of them is deliberately blocked.
  # ⛔ The two conditions are DIFFERENT PAGES, so one URL filter cannot find both. A native arm
  # sampled for '/watch/' would report no main thread at all, which reads as a free viewer.
  local thread_url='/watch/'
  [ "${source}" = "native" ] && thread_url='lat-murmeldjur'
  start_main_thread "${METRICS_DIR}/${slug}-mainthread.jsonl" "${slug}" "${thread_url}"

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
  stop_main_thread
  summarize_browser_cpu "${METRICS_DIR}/${slug}-cpu.txt" "${slug}"
  summarize_main_thread "${METRICS_DIR}/${slug}-mainthread.jsonl" "${slug}"
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

PLAN_SOURCES=()
PLAN_MINUTES=()
PLAN_ROLES=()
PLAN_ROUNDS=()

# ⛔ Everything here runs before the first gate and long before the first spend, so a malformed plan
# costs nothing. The alternative is a typo discovered by a three-hour broadcast.
parse_arm_plan() {
  local entry source minutes role counted_so_far=0
  for entry in ${ARM_PLAN}; do
    if [ "$(awk -F: '{print NF}' <<< "${entry}")" -ne 3 ]; then
      say "REFUSING TO START: ARM_PLAN entry '${entry}' is not source:minutes:role"
      return 1
    fi
    source="$(cut -d: -f1 <<< "${entry}")"
    minutes="$(cut -d: -f2 <<< "${entry}")"
    role="$(cut -d: -f3 <<< "${entry}")"
    if ! [ "${minutes}" -ge 2 ] 2>/dev/null; then
      say "REFUSING TO START: ARM_PLAN entry '${entry}' asks for ${minutes} min, too short for a player to reach steady state"
      return 1
    fi
    case "${role}" in
      warm-up) PLAN_ROUNDS+=(1) ;;
      # ⭐ Round 1 is reserved for warm-up because that is the boundary `read-sitting.py` reads. A
      # counted arm numbered into it would be dropped from its own sitting's table.
      counted)
        counted_so_far=$((counted_so_far + 1))
        PLAN_ROUNDS+=($((counted_so_far + 1)))
        ;;
      *)
        say "REFUSING TO START: ARM_PLAN entry '${entry}' has role '${role}', wanted warm-up or counted"
        return 1
        ;;
    esac
    PLAN_SOURCES+=("${source}")
    PLAN_MINUTES+=("${minutes}")
    PLAN_ROLES+=("${role}")
  done
  [ "${#PLAN_SOURCES[@]}" -gt 0 ] || {
    say "REFUSING TO START: ARM_PLAN is set but parsed to no arms at all"
    return 1
  }
  return 0
}

if [ -n "${ARM_PLAN}" ]; then
  parse_arm_plan || exit 1
  TOTAL_ARMS="${#PLAN_SOURCES[@]}"
  SITTING_SECONDS=$((PUBLISHER_LEAD_S * 2))
  for minutes in "${PLAN_MINUTES[@]}"; do
    SITTING_SECONDS=$((SITTING_SECONDS + minutes * 60 + ARM_GAP_S + ARM_OVERHEAD_S))
  done
else
  TOTAL_ARMS=$((ROUNDS * 2))
  SITTING_SECONDS=$((PUBLISHER_LEAD_S * 2 + TOTAL_ARMS * (ARM_MINUTES * 60 + ARM_GAP_S + ARM_OVERHEAD_S)))
  if [ "${ARM_MINUTES}" -lt 2 ]; then
    say "REFUSING TO START: ARM_MINUTES=${ARM_MINUTES} is too short for a player to reach steady state"
    exit 1
  fi
fi
SITTING_MINUTES=$(((SITTING_SECONDS + 59) / 60))
# ⛔ The settle is spent inside the watch and before its window opens, so an overhead that does not
# cover it makes the broadcast run out under the last arms.
if [ "${ARM_OVERHEAD_S}" -le "${SETTLE_SECONDS}" ]; then
  say "REFUSING TO START: ARM_OVERHEAD_S=${ARM_OVERHEAD_S} does not cover the ${SETTLE_SECONDS}s settle"
  exit 1
fi

if [ -n "${ARM_PLAN}" ]; then
  say "byte-source-arms starting: a ${TOTAL_ARMS}-arm plan, ${ARM_PLAN}"
else
  say "byte-source-arms starting: ${ROUNDS} rounds x 2 arms x ${ARM_MINUTES} min"
fi
say "  one LIVE broadcast of ${SITTING_MINUTES} min at a ${GOP_SECONDS}s GOP, ${SIZE} at ${BITRATE_KBPS} kbps"
say "  each arm settles ${SETTLE_SECONDS}s from playback before its window opens"
if [ -n "${ARM_PLAN}" ]; then
  say "  the plan names each arm's own role, so WARMUP_ROUNDS does not apply"
elif [ "${WARMUP_ROUNDS}" -gt 0 ]; then
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
if [ -z "${VIEWER_CDP_PORT:-}" ] && [ "${ALLOW_NO_THREAD_READING}" != "1" ]; then
  say "REFUSING TO START: VIEWER_CDP_PORT is unset, so no arm would measure the page main thread"
  say "  Set it to any free port, for example VIEWER_CDP_PORT=9222, or pass ALLOW_NO_THREAD_READING=1"
  say "  if this sitting genuinely does not need the saturation column."
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

# ⭐ Asked for one round even in plan mode, where the order is not wanted but the SOURCE NAMES are.
# One round of a counterbalance is every condition exactly once, so this is the harness stating which
# byte sources exist, and a plan is checked against that rather than against a list copied into shell.
# A plan that named `weeb-3` would otherwise reach a real browser three hours into a paid broadcast.
ORDER_SCRIPT="browser:byte-source-order"
[ "${ARM_PAIR}" = "gateway-less" ] && ORDER_SCRIPT="browser:viewer-order"
ARM_ORDER="$(run_in_browser_image "${BROWSER_CONTAINER_NAME}-check" "${BROWSER_IMAGE}" \
  pnpm --silent "${ORDER_SCRIPT}" "$([ -n "${ARM_PLAN}" ] && echo 1 || echo "${ROUNDS}")" 2>> "${LOG}" | tr -d '\r')"
read -r -a ARMS <<< "${ARM_ORDER}"
if [ -n "${ARM_PLAN}" ]; then
  for source in "${PLAN_SOURCES[@]}"; do
    case " ${ARM_ORDER} " in
      *" ${source} "*) ;;
      *)
        say "REFUSING TO START: ARM_PLAN names condition '${source}', which the harness does not know. It knows: ${ARM_ORDER}"
        exit 1
        ;;
    esac
  done
  ARMS=("${PLAN_SOURCES[@]}")
  say "  arm plan: ${ARM_PLAN}"
elif [ "${#ARMS[@]}" -ne "${TOTAL_ARMS}" ]; then
  say "REFUSING TO START: ${ORDER_SCRIPT} gave ${#ARMS[@]} arms for ${ROUNDS} rounds, wanted ${TOTAL_ARMS}"
  exit 1
else
  say "  arm order: ${ARM_ORDER}"
fi

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
trap 'stop_sampler; stop_browser_cpu; stop_main_thread; stop_publisher; reclaim_browser_containers' EXIT INT TERM

say "starting the one broadcast this sitting reads, for ${SITTING_SECONDS}s"
say "  budget per arm: $([ -n "${ARM_PLAN}" ] && echo "its own minutes" || echo "${ARM_MINUTES}m")" \
  "watch + ${SETTLE_SECONDS}s settle + ${ARM_GAP_S}s gap + the join"
BROADCAST_STARTED_AT="$(date -u +%s)"
start_publisher "${SITTING_SECONDS}"
if ! wait_for_active_stream; then
  stop_publisher
  say "REFUSING TO CONTINUE: the broadcast never reached the uploader"
  exit 1
fi
if ! stage_matches_the_gop_we_asked_for; then
  stop_publisher
  say "REFUSING TO CONTINUE: the stage is not publishing the ${GOP_SECONDS}s GOP this sitting asked for"
  exit 1
fi
# ⛔⛔ BEFORE THE LEAD, NOT AT THE FIRST NATIVE ARM. A native arm that cannot find the stream would
# fail three quarters of an hour into a paid broadcast, having already spent for it. Discovering here
# costs a `docker logs` and turns that into a refusal before the lead is even waited out.
if printf '%s\n' "${ARMS[@]}" | grep -qx native; then
  if ! discover_native_stream; then
    stop_publisher
    say "REFUSING TO CONTINUE: a native arm is planned and the publisher announced no catalog entry"
    exit 1
  fi
fi

say "  the broadcast is live, leading the first arm by ${PUBLISHER_LEAD_S}s"
sleep "${PUBLISHER_LEAD_S}"

for index in $(seq 1 "${TOTAL_ARMS}"); do
  if [ -n "${ARM_PLAN}" ]; then
    arm_round="${PLAN_ROUNDS[index - 1]}"
    arm_role="${PLAN_ROLES[index - 1]}"
    arm_minutes="${PLAN_MINUTES[index - 1]}"
  else
    arm_round=$(((index + 1) / 2))
    arm_role="$([ "${arm_round}" -le "${WARMUP_ROUNDS}" ] && echo warm-up || echo counted)"
    arm_minutes="${ARM_MINUTES}"
  fi
  run_arm "${ARMS[index - 1]}" "${index}" "${arm_round}" "${arm_role}" "${arm_minutes}" || break
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
