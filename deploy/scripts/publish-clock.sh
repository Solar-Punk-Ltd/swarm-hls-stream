#!/bin/bash
#
# Publish a test pattern with the wall clock burned into the picture, so a latency claim can be read
# off a real player instead of derived.
#
# ## Why this exists next to a bench that already measures latency
#
# `bench:latency` measures capture to fetchable: the instant a segment could first be retrieved from
# the gateway. A viewer does not watch the fetchable edge, they watch whatever their player chose to
# play, which sits a further `LIVE_SYNC_DURATION_S` behind it. Everything this project claims about
# what a viewer sees is that measurement plus a buffer the player was configured with, and no part of
# it has been observed in a browser.
#
# A clock in the frame closes that. Screenshot the player, read the time in the picture, subtract it
# from the time on the wall, and the difference is the whole path with the player's own behaviour
# inside it. It needs no instrumentation in the client and no cooperation from the manifest, which
# matters because SRS publishes no `EXT-X-PROGRAM-DATE-TIME` and `hls.playingDate` is therefore
# unavailable on this engine.
#
# ## Why it publishes from the deployment host
#
# The same reason the bench does. Publishing from a workstation put about 15% of SRT packets on the
# floor and cost 3.18s of an 8.18s reading, which is the operator's uplink and not the product. The
# clock is drawn from the host's clock for the same reason: the reader compares it against their own,
# and two machines can disagree by more than the quantity being measured.
#
# Usage:
#   deploy/scripts/publish-clock.sh [--profile=<name>] [--portSlot=<N>] [--stream=video/clock]
#                                   [--seconds=300] [--size=1280x720] [--bitrate=2500] [--gop=1.0]
#                                   [--stop-file=<path>]

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

require_jq
require_config

STREAM_ID="video/clock"
SECONDS_TO_RUN=300
SIZE="1280x720"
BITRATE_KBPS=2500
GOP_SECONDS=1.0
FPS=30
# Where a harness says it stopped this publisher on purpose. See the block above the wait below.
STOP_REQUEST_FILE=""
REMAINING_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --stop-file=*) STOP_REQUEST_FILE="${arg#*=}" ;;
    --stream=*) STREAM_ID="${arg#*=}" ;;
    --seconds=*) SECONDS_TO_RUN="${arg#*=}" ;;
    --size=*) SIZE="${arg#*=}" ;;
    --bitrate=*) BITRATE_KBPS="${arg#*=}" ;;
    --gop=*) GOP_SECONDS="${arg#*=}" ;;
    --fps=*) FPS="${arg#*=}" ;;
    *) REMAINING_ARGS+=("$arg") ;;
  esac
done

parse_profile_args ${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}

load_env
load_engine_envs
apply_port_slot

TARGET="$(get_target srs)"
PORT="${SRS_SRT_PORT:?SRS_SRT_PORT is unset after apply_port_slot}"

# An unauthenticated publish is refused by the engine when the secret is set, and the refusal reads as
# an ordinary connection failure from the publisher's end, so the key is derived rather than omitted.
KEY_QUERY=""
if [ -n "${PUBLISH_KEY_SECRET:-}" ]; then
  if ! KEY=$(derive_publish_key "$STREAM_ID"); then
    exit 1
  fi
  KEY_QUERY="?key=${KEY}"
fi

# SRS's SRT publish form. The key rides inside the `r=` value, where SRS finds it as `param` with no
# leading `?`, which is the spelling `e2e/src/harness/engine.ts` measured against this image.
# `publish-key.sh` prints the RTMP form for SRS and the SRT form only for OME, so this is composed
# here rather than read from it.
URL="srt://127.0.0.1:${PORT}?streamid=#!::r=${STREAM_ID}${KEY_QUERY},m=publish"

# Rounded to the frame, so `-g` takes an integer count rather than a fraction it would truncate.
GOP_FRAMES=$(awk -v f="${FPS}" -v g="${GOP_SECONDS}" 'BEGIN { printf "%d", (f * g) + 0.5 }')

log_info "publishing ${SIZE} @ ${FPS}fps ${BITRATE_KBPS}k, ${GOP_SECONDS}s GOP, for ${SECONDS_TO_RUN}s"
log_info "stream ${STREAM_ID} into UDP ${PORT} on ${TARGET}"

# The payload is composed here and fed to the remote shell on **stdin**, with the values quoted by
# `printf %q` and the filter body taken verbatim from a quoted heredoc.
#
# That is not style. `drawtext` uses `:` as its own option separator, so every colon inside the text
# has to reach ffmpeg as `\:`, and a command sent as an ssh argument is re-parsed by the local shell,
# then by the remote shell, then by docker. Four attempts at spelling the escape through those layers
# all arrived as `text=%{localtime\:%H\\:%M\\:%S}`, where the doubled backslash escapes itself and the
# next colon ends the text, which ffmpeg reports as "Both text and text file provided". On stdin there
# are no layers to survive.
#
# The clock is drawn as epoch seconds for the same reason, leaving one colon rather than three, and it
# is also the easiest thing to read back: a viewer's screenshot carries a number that subtracts
# directly from `Date.now() / 1000`. Resolution is one second, which is enough to judge a buffer
# measured in seconds and is deliberately not dressed up as more.
#
# ## Why it is started detached and then waited on, rather than run in the foreground
#
# The publisher used to run in the foreground of one ssh session for the whole broadcast. ffmpeg at
# `-loglevel error` sends nothing across that session for the entire run, so an hour-long broadcast is
# an hour of an idle connection, and if it drops the remote shell takes SIGHUP and ffmpeg dies with
# it. The viewer then measures a broadcast that stopped, which looks exactly like the product failing.
#
# Detached, the ffmpeg container outlives its ssh session, and the wait below is a series of short
# calls: a blip costs one poll instead of the run. This is what makes a sixty minute run worth
# starting.
CONTAINER="swarm-hls-publish-$$"

run_remote() {
  if [ "${TARGET}" = "localhost" ]; then
    bash -s
  else
    # The same keepalives `bench-on-host.sh` uses, for the same reason.
    ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=20 "${TARGET}" bash -s
  fi
}

# The last line of an inspect result that carries anything, which is the only line that answers.
#
# ⛔⛔⛔ EVERY READ BELOW IS `docker inspect ... || echo missing`, AND THE TWO HALVES CAN BOTH SPEAK.
# For a container that is gone, docker writes an EMPTY LINE to stdout and then exits non-zero, so the
# guard appends a second line and the value that comes back is "\nmissing" rather than "missing". A
# whole-string comparison against `missing` therefore misses, the vanished branch is skipped, and a
# stop this harness asked for is reported as a failed broadcast. That is what the floor-check sitting
# of 2026-08-14 printed, in a broadcast the harness had stopped on purpose:
#
#   ✗ publish FAILED (exit
#   missing). Nothing usable was broadcast, so do not measure against this.
#
# ⭐⭐⭐ Gate lesson AHL, again: an alarm that fires on every successful stop is one the operator
# learns to skip, and the next time it is real nobody reads it. PR #188 removed this alarm from one
# path and this is the other.
last_line() {
  printf '%s\n' "$1" | grep -v '^[[:space:]]*$' | tail -1
}

# ## Telling a stop this run was ASKED for apart from a publisher that died
#
# A harness stops the broadcast the moment its arms are done rather than paying for the slack it
# budgeted, and it does that by removing this container. The wait below then had nothing left to read
# an exit status from, synthesised 127, and every successful sitting ended with "publish FAILED.
# Nothing usable was broadcast" against a broadcast that had been fine for the whole run. ⛔⛔⛔ An
# alarm that fires on every good run is one the operator learns to skip. See `publisher-stop.sh`.
#
# ⭐ Only the branch where the container VANISHED consults this. A publisher that exited on its own is
# still read straight off `.State.ExitCode`, so no marker and no signal can quiet a genuine
# mid-broadcast death, which is what the rest of this file is arranged around.
#
# ⛔⛔ The path arrives as `--stop-file=` and never from the environment, and this clears it here so a
# marker found later cannot be a previous sitting's. Both halves are load-bearing:
# `overnight-chain.sh` exports a `STOP_FILE` naming the chain's own halt signal into everything it
# runs, so an ambient name would have this delete that; and `phase06-light-vs-ultralight.sh` writes
# every sitting into one fixed `OUT_DIR`, so a marker left by one run would silence the next run's
# real failure.
STOP_REQUESTED=0
if [ -n "${STOP_REQUEST_FILE}" ]; then
  rm -f "${STOP_REQUEST_FILE}"
fi

stop_was_requested() {
  if [ "${STOP_REQUESTED}" = "1" ]; then
    return 0
  fi
  [ -n "${STOP_REQUEST_FILE}" ] && [ -f "${STOP_REQUEST_FILE}" ]
}

# Set before the trap below can fire, so an interruption during startup still has a number to report.
BROADCAST_STARTED_AT="$(date -u +%s)"

# How much of the broadcast actually happened, which is the one thing an early stop has to say. A
# teardown that reads as success without it is how a truncated sitting gets measured against.
broadcast_so_far() {
  printf 'after %ss of a %ss broadcast' "$(($(date -u +%s) - BROADCAST_STARTED_AT))" "${SECONDS_TO_RUN}"
}

# Killed rather than left running when this script is interrupted, so a Ctrl-C does not leave a
# publisher holding the stream id and blocking every run that follows.
cleanup_publisher() {
  printf 'docker rm -f %q >/dev/null 2>&1 || true\n' "${CONTAINER}" | run_remote || true
}

# An operator's Ctrl-C is a stop this run was asked for, exactly like a harness's, and the handler has
# to EXIT. Returning from it put the wait back on a container the handler had just removed, so an
# interruption produced the same false failure by a second route.
stop_on_signal() {
  STOP_REQUESTED=1
  cleanup_publisher
  log_ok "publish stopped on request $(broadcast_so_far)"
  exit 0
}
trap stop_on_signal INT TERM

{
  printf 'CONTAINER=%q\nSIZE=%q\nFPS=%q\nBITRATE=%q\nGOP_FRAMES=%q\nSECONDS_TO_RUN=%q\nURL=%q\n' \
    "${CONTAINER}" "${SIZE}" "${FPS}" "${BITRATE_KBPS}" "${GOP_FRAMES}" "${SECONDS_TO_RUN}" "${URL}"
  cat <<'PUBLISH_BODY'
set -e
DRAW="drawtext=text='%{localtime\:%s}':fontsize=64:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=14:x=(w-text_w)/2:y=h-text_h-40"
docker run -d --name "${CONTAINER}" --network host swarm-hls-bench \
  ffmpeg -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=${SIZE}:rate=${FPS}" \
  -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -vf "${DRAW},realtime" -af arealtime \
  -c:v libx264 -preset veryfast -tune zerolatency -b:v "${BITRATE}k" \
  -g "${GOP_FRAMES}" -sc_threshold 0 -pix_fmt yuv420p \
  -c:a aac -ar 48000 -b:a 128k \
  -t "${SECONDS_TO_RUN}" \
  -f mpegts "${URL}" >/dev/null
PUBLISH_BODY
} | run_remote
# The exit status of a pipeline is its last command's, and `set -e` does not fire on the left-hand
# side of one, so a failed ffmpeg reached the success line below and the script exited 0. That
# happened three times on 2026-08-05: twice a second publisher collided with one still holding the
# stream id and died in a second, once the port was wrong, and each time this printed "publish
# finished" and the run that followed measured whatever was left over from before.
START_STATUS=$?

if [ "${START_STATUS}" -ne 0 ]; then
  log_error "publish FAILED to start (exit ${START_STATUS}). Nothing was broadcast."
  exit "${START_STATUS}"
fi

# Polled rather than `docker wait`, which would hold a session open for the whole broadcast and put
# the problem back exactly where it was. Generous, because the poll is only how promptly the end is
# noticed and the broadcast length is already known.
POLL_SECONDS=10

# How many consecutive polls may fail to be taken before this stops waiting.
#
# **A poll that could not be taken is not a broadcast that ended**, and reading it as one is what
# this exists for. `|| echo missing` guards `docker inspect` failing on the far side and cannot guard
# `ssh` failing on the near side: a refused connection, a momentary DNS failure or a dead mux socket
# exits 255 having written only to stderr, so the substitution comes back empty. Empty is not `true`,
# so the loop broke while ffmpeg was still broadcasting, `.State.ExitCode` read 0 because it reads 0
# for a *running* container, and this script deleted the live publisher and printed `publish
# finished` with exit 0. A sixty minute run ended at whatever minute the first blip landed, with its
# postage and BZZ already spent and nothing in the record marking where it stopped.
#
# Six is a minute at the interval above: long enough to outlast a restarted sshd or a laptop changing
# network, short enough that a host which is genuinely gone is not waited on for the rest of the run.
MAX_CONSECUTIVE_POLL_FAILURES=6

# Whether the wait ended because the container was GONE rather than because it had stopped. The two
# used to collapse into one exit-status read, and that is what made a teardown indistinguishable from
# a death: only this one is ambiguous about who ended the broadcast.
CONTAINER_VANISHED=0

POLL_FAILURES=0
while true; do
  if ! RUNNING=$(printf 'docker inspect -f {{.State.Running}} %q 2>/dev/null || echo missing\n' "${CONTAINER}" | run_remote) ||
    [ -z "$(last_line "${RUNNING}")" ]; then
    POLL_FAILURES=$((POLL_FAILURES + 1))
    if [ "${POLL_FAILURES}" -ge "${MAX_CONSECUTIVE_POLL_FAILURES}" ]; then
      log_error "publish UNKNOWN: ${MAX_CONSECUTIVE_POLL_FAILURES} consecutive polls of ${TARGET} could not be taken."
      log_error "The broadcast may still be running. Do not measure against this, and check for a leftover ${CONTAINER}."
      exit 1
    fi
    sleep "${POLL_SECONDS}"
    continue
  fi

  # Reset on any poll that was actually taken, so this counts a run of failures rather than their
  # total. One blip an hour is the case the whole detached design exists to survive.
  POLL_FAILURES=0
  RUNNING="$(last_line "${RUNNING}")"
  case "${RUNNING}" in
    true) sleep "${POLL_SECONDS}" ;;
    # `missing` is the `|| echo missing` above firing: `docker inspect` was answered and the container
    # was not there to be inspected. `false` is a container that is present and stopped, which still
    # carries its own exit status and is never ambiguous.
    missing)
      CONTAINER_VANISHED=1
      break
      ;;
    *) break ;;
  esac
done

# Only reached once a poll has actually reported the container is no longer running, which is what
# makes this read meaningful: `.State.ExitCode` is 0 for a running container, so asking it while the
# broadcast is live cannot tell a clean finish from anything else.
PUBLISH_STATUS=""
if [ "${CONTAINER_VANISHED}" -eq 0 ]; then
  # `missing` rather than the 127 this used to synthesise. The container can still go between the poll
  # above and this read, and an exit code invented here is indistinguishable from one ffmpeg actually
  # returned: 127 was reported as a real failure, with wording naming a cause it could not know.
  if ! PUBLISH_STATUS=$(printf 'docker inspect -f {{.State.ExitCode}} %q 2>/dev/null || echo missing\n' "${CONTAINER}" | run_remote) ||
    [ -z "$(last_line "${PUBLISH_STATUS}")" ]; then
    # Distinguished from a failed publish, because it is a different thing to act on: the broadcast may
    # have been fine and this could not find out. Either way it must not read as success.
    log_error "publish UNKNOWN: could not read the publisher's exit status from ${TARGET}."
    log_error "Do not measure against this, and check for a leftover ${CONTAINER}."
    exit 1
  fi
  PUBLISH_STATUS="$(last_line "${PUBLISH_STATUS}")"
  if [ "${PUBLISH_STATUS}" = "missing" ]; then
    CONTAINER_VANISHED=1
  fi
fi

if [ "${CONTAINER_VANISHED}" -eq 1 ]; then
  if stop_was_requested; then
    log_ok "publish stopped on request $(broadcast_so_far)"
    exit 0
  fi
  # Deliberately not the wording below. Nothing here knows how much was broadcast, and the usual cause
  # is not a stream-id collision: something removed a container this script was still watching.
  log_error "publish FAILED: the publisher container went away and nothing asked this script to stop."
  log_error "How much was broadcast is unknown, so do not measure against this. Check who removed ${CONTAINER}."
  exit 1
fi

if [ "${PUBLISH_STATUS}" != "0" ]; then
  log_error "publish FAILED (exit ${PUBLISH_STATUS}). Nothing usable was broadcast, so do not measure against this."
  log_error "The usual cause is another publisher still holding ${STREAM_ID}. Wait for it, or use --stream=."
  printf 'docker logs --tail 20 %q 2>&1 || true\n' "${CONTAINER}" | run_remote || true
  cleanup_publisher
  exit 1
fi

cleanup_publisher
log_ok "publish finished"
