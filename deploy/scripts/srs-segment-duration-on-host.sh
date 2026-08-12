#!/usr/bin/env bash
# The same segment-duration probe as `srs-segment-duration.mjs`, with the media engine on the
# deployment host and the publisher still on this laptop.
#
# ⭐ THIS IS THE ARM THAT MATTERS FOR #78. Every local arm shares one machine and one loopback, so
# none of them can reproduce a publish that crosses the internet. The deployment's 1.905s segments
# were produced by exactly this pairing: ffmpeg here, media engine there, MPEG-TS over SRT between
# them. What is deliberately absent is bee, the uploader and postage, so the run costs nothing and
# isolates the transport from everything downstream of it.
#
# ⛔ It creates its own container on its own ports and removes it afterwards. It must never be
# pointed at the `latbench` stack: that one has an uploader behind it, and publishing to it spends.
#
# Usage: deploy/scripts/srs-segment-duration-on-host.sh <fragment> <gop> <recipe> [seconds]
#   recipe: `bench` for wallclock-stamped MPEG-TS over SRT, `bench-nostamp` for the same transport
#   with an invented timeline.
set -euo pipefail

FRAGMENT="${1:?usage: srs-segment-duration-on-host.sh <fragment> <gop> <recipe> [seconds]}"
GOP="${2:?missing gop}"
RECIPE="${3:?missing recipe}"
SECONDS_TO_PUBLISH="${4:-60}"

HOST="${PROBE_HOST:-manager-host}"
HOST_ADDR="${PROBE_HOST_ADDR:-49.12.149.62}"
CONTAINER="srs-fragment-probe-host"
RTMP_PORT=11935
SRT_PORT=11936
REMOTE_DIR="/tmp/${CONTAINER}"
FPS=30
# Overridable, because the interesting follow-up to "the path stretches a 6 Mbps stream" is which
# bitrate it stops stretching at, and that is the same arm with one number changed.
SIZE="${PROBE_SIZE:-1920x1080}"
BITRATE_KBPS="${PROBE_BITRATE_KBPS:-6000}"
# Deliberately high so SRS's absolute-overflow path cannot fire, which is what isolates the
# fragment-versus-GOP relationship from the ceiling. Overridable, because the ceiling is itself worth
# probing: `HLS_FRAGMENT * HLS_AOF_RATIO` is what SRS force-closes at, and the shipped pair is 0.5 and
# 4.2 rather than the 10 assumed here. ⛔ An arm run with a non-default ratio is NOT comparable with
# `gop-vs-fragment-2026-08-12.md`, every row of which was measured at 10.
AOF_RATIO="${PROBE_AOF_RATIO:-10}"
# Held at 200 throughout the bench profiles.
SRT_LATENCY_MS=200

# SRS writes its segments as root through the bind mount, so the login user cannot delete them and a
# plain `rm -rf` leaves the whole tree behind on a host whose disk is not ours to fill. The removal
# therefore runs in a container, which is the only thing here with the rights to do it.
cleanup() {
  ssh -o ConnectTimeout=15 "$HOST" "
    docker rm -f ${CONTAINER} >/dev/null 2>&1 || true
    docker run --rm -v ${REMOTE_DIR}:/victim alpine:latest sh -c 'rm -rf /victim/hls /victim/probe.conf' >/dev/null 2>&1 || true
    rmdir ${REMOTE_DIR} 2>/dev/null || true
  "
}
trap cleanup EXIT

ssh -o ConnectTimeout=20 "$HOST" "bash -s" <<REMOTE
set -euo pipefail
docker rm -f ${CONTAINER} >/dev/null 2>&1 || true
# ⛔ Removed through a container, not with a plain rm. Docker creates a missing bind-mount source as
# root, so after one run the login user owns none of this and \`rm -rf\` fails. Under \`set -e\` that
# failure aborted the setup, the container never started, and the arm reported "no segments" — which
# is the third unrelated cause of that same symptom this instrument has produced.
docker run --rm -v /tmp:/hosttmp alpine:latest sh -c 'rm -rf /hosttmp/${CONTAINER}' >/dev/null 2>&1 || true
mkdir -p ${REMOTE_DIR}/hls
cat > ${REMOTE_DIR}/probe.conf <<'CONF'
listen              ${RTMP_PORT};
max_connections     100;
daemon              off;
srs_log_tank        console;

srt_server {
    enabled         on;
    listen          ${SRT_PORT};
    latency         ${SRT_LATENCY_MS};
    tlpktdrop       on;
    tsbpdmode       on;
}

vhost __defaultVhost__ {
    srt {
        enabled     on;
    }

    hls {
        enabled         on;
        hls_fragment    ${FRAGMENT};
        hls_aof_ratio   ${AOF_RATIO};
        hls_window      600;
        hls_cleanup     off;
        hls_dispose     0;
        hls_path        /hls;
        hls_m3u8_file   [app]/[stream].m3u8;
        hls_ts_file     [app]/[stream]-[seq].ts;
    }
}
CONF
docker run --rm -d --name ${CONTAINER} \
  -p ${RTMP_PORT}:${RTMP_PORT} -p ${SRT_PORT}:${SRT_PORT}/udp \
  -v ${REMOTE_DIR}/probe.conf:/usr/local/srs/conf/probe.conf:ro \
  -v ${REMOTE_DIR}/hls:/hls \
  ossrs/srs:6 ./objs/srs -c conf/probe.conf >/dev/null
REMOTE

# ⭐ Checked rather than assumed. An arm that reports no segments has three known causes here, and
# two of them are the setup rather than the measurement, so the setup gets to fail in its own words.
if ! ssh -o ConnectTimeout=15 "$HOST" "docker ps --format '{{.Names}}' | grep -qx ${CONTAINER}"; then
  echo "the media engine did not start on ${HOST}, so nothing below would have measured anything" >&2
  exit 1
fi

# The container reports healthy before SRT is bound, and a publisher that arrives early is refused
# with no retry, so the wait is on the port rather than on docker.
for _ in $(seq 1 40); do
  if ssh -o ConnectTimeout=10 "$HOST" "docker exec ${CONTAINER} sh -c 'netstat -lun 2>/dev/null | grep -q :${SRT_PORT}'" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

# ⛔ Expanded below as `${STAMP_ARGS[@]+...}` rather than plainly, because bash 3.2 is what macOS
# ships and it treats an empty array expansion as an unbound variable under `set -u`. The stamped arm
# never hit it, so the failure waited for the unstamped one.
STAMP_ARGS=()
TAIL_ARGS=(-t "${SECONDS_TO_PUBLISH}")
if [ "$RECIPE" = "bench" ]; then
  STAMP_ARGS=(-use_wallclock_as_timestamps 1)
  # ⛔ `-t` is measured against output timestamps, which under `-copyts` are epoch values, so a
  # stamped arm is stopped on the wall clock instead.
  TAIL_ARGS=(-copyts)
fi

GOP_FRAMES=$(awk -v f="$FPS" -v g="$GOP" 'BEGIN { printf "%d", f * g + 0.5 }')

set +e
ffmpeg -hide_banner -loglevel error -stats \
  ${STAMP_ARGS[@]+"${STAMP_ARGS[@]}"} -f lavfi -i "testsrc2=size=${SIZE}:rate=${FPS}" \
  ${STAMP_ARGS[@]+"${STAMP_ARGS[@]}"} -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -vf realtime -af arealtime \
  -c:v libx264 -preset veryfast -tune zerolatency -b:v "${BITRATE_KBPS}k" \
  -g "$GOP_FRAMES" -sc_threshold 0 -pix_fmt yuv420p \
  -c:a aac -ar 48000 -b:a 128k \
  "${TAIL_ARGS[@]}" \
  -f mpegts "srt://${HOST_ADDR}:${SRT_PORT}?streamid=#!::r=live/t,m=publish" 2>&1 &
FF_PID=$!
if [ "$RECIPE" = "bench" ]; then
  sleep "$SECONDS_TO_PUBLISH"
  kill -INT "$FF_PID" 2>/dev/null || true
fi
wait "$FF_PID"
set -e

echo
echo "=== #EXTINF, ${RECIPE} fragment=${FRAGMENT} gop=${GOP} ${SIZE} ${BITRATE_KBPS}k on ${HOST} ==="
ssh -o ConnectTimeout=15 "$HOST" "cat ${REMOTE_DIR}/hls/live/t.m3u8 2>/dev/null" |
  awk -F: '/#EXTINF/ { sub(/,.*/, "", $2); print $2 }'
