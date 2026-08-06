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
REMAINING_ARGS=()
for arg in "$@"; do
  case "$arg" in
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

# Killed rather than left running when this script is interrupted, so a Ctrl-C does not leave a
# publisher holding the stream id and blocking every run that follows.
cleanup_publisher() {
  printf 'docker rm -f %q >/dev/null 2>&1 || true\n' "${CONTAINER}" | run_remote || true
}
trap cleanup_publisher INT TERM

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
while true; do
  RUNNING=$(printf 'docker inspect -f {{.State.Running}} %q 2>/dev/null || echo missing\n' "${CONTAINER}" | run_remote)
  case "${RUNNING}" in
    true) sleep "${POLL_SECONDS}" ;;
    *) break ;;
  esac
done

PUBLISH_STATUS=$(printf 'docker inspect -f {{.State.ExitCode}} %q 2>/dev/null || echo 127\n' "${CONTAINER}" | run_remote)

if [ "${PUBLISH_STATUS}" != "0" ]; then
  log_error "publish FAILED (exit ${PUBLISH_STATUS}). Nothing usable was broadcast, so do not measure against this."
  log_error "The usual cause is another publisher still holding ${STREAM_ID}. Wait for it, or use --stream=."
  printf 'docker logs --tail 20 %q 2>&1 || true\n' "${CONTAINER}" | run_remote || true
  cleanup_publisher
  exit 1
fi

cleanup_publisher
log_ok "publish finished"
