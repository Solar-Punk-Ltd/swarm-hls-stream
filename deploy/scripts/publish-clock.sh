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

# `%{localtime}` is evaluated per frame at draw time, so the number in the picture is when that frame
# was encoded rather than when the graph started. Resolution is one second, which is enough to judge a
# buffer measured in seconds and is deliberately not dressed up as more.
DRAW="drawtext=text='%{localtime\\:%H\\\\\\:%M\\\\\\:%S}':fontsize=72:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12:x=(w-text_w)/2:y=h-text_h-40"

log_info "publishing ${SIZE} @ ${FPS}fps ${BITRATE_KBPS}k, ${GOP_SECONDS}s GOP, for ${SECONDS_TO_RUN}s"
log_info "stream ${STREAM_ID} into UDP ${PORT} on ${TARGET}"

# Runs in the bench image because it already carries ffmpeg with drawtext, and on the host network so
# the ingest is reached over loopback.
REMOTE_CMD="docker run --rm --network host swarm-hls-bench \
  ffmpeg -hide_banner -loglevel error \
  -f lavfi -i testsrc2=size=${SIZE}:rate=${FPS} \
  -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -vf \"${DRAW},realtime\" -af arealtime \
  -c:v libx264 -preset veryfast -tune zerolatency -b:v ${BITRATE_KBPS}k \
  -g ${GOP_FRAMES} -sc_threshold 0 -pix_fmt yuv420p \
  -c:a aac -ar 48000 -b:a 128k \
  -t ${SECONDS_TO_RUN} \
  -f mpegts '${URL}'"

if [ "${TARGET}" = "localhost" ]; then
  bash -c "${REMOTE_CMD}"
else
  ssh "${TARGET}" "${REMOTE_CMD}"
fi

log_ok "publish finished"
