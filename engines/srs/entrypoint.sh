#!/bin/bash
set -e

CONF=/usr/local/srs/conf/srs.conf
cp /usr/local/srs/conf/srs.conf.template "$CONF"

# Substitute passphrase or remove SRT encryption lines if empty
if [ -n "$SRT_PASSPHRASE" ]; then
  sed -i "s/PASSPHRASE_PLACEHOLDER/$SRT_PASSPHRASE/" "$CONF"
else
  sed -i '/PASSPHRASE_PLACEHOLDER/d' "$CONF"
  sed -i '/pbkeylen/d' "$CONF"
fi

# Refuse rather than splice. These values land inside a `sed` s/// expression, where a `/` aborts the
# substitution and `&` expands to the whole match, so a typo would either crash-loop the container
# under `restart: unless-stopped` or silently write a corrupt config.
require_number() {
  case "$2" in
    '' | *[!0-9.]* | *.*.*) echo "$1 must be a positive number, got '$2'" >&2; exit 1 ;;
  esac
}

# Segment length, and how much of it the playlist keeps.
#
# **This is the largest latency lever on the engine side**, and it is bounded from below by the
# publisher: SRS can only cut on a keyframe, so the segment a viewer waits for is the first keyframe
# at or after `HLS_FRAGMENT`, not `HLS_FRAGMENT` itself. Measured on the deployment host on
# 2026-08-03, a 2s GOP against a 1.5 fragment produced segments of exactly 2.00s on every sample.
# Lowering this alone therefore changes nothing until the GOP comes down with it.
#
# These were configurable on `main` and this branch hard-coded them back to the defaults, which took
# the knob away without anything failing. Restored under the same names and defaults, so a deployment
# setting either is unchanged by the round trip.
require_number HLS_FRAGMENT "${HLS_FRAGMENT:-1.5}"
require_number HLS_WINDOW "${HLS_WINDOW:-22.5}"
sed -i "s/HLS_FRAGMENT_PLACEHOLDER/${HLS_FRAGMENT:-1.5}/" "$CONF"
sed -i "s/HLS_WINDOW_PLACEHOLDER/${HLS_WINDOW:-22.5}/" "$CONF"

# How long SRT holds a packet waiting for a retransmission before delivering without it.
#
# Never configurable, on this branch or on `main`. It is a latency floor on the ingest hop and it
# trades against loss: too low and `tlpktdrop` discards retransmissions that would have arrived,
# too high and every packet waits for a window it does not need. 200ms suits a lossy path, and a
# publisher on the same host as the engine is not on one.
require_number SRT_LATENCY "${SRT_LATENCY:-200}"
sed -i "s/SRT_LATENCY_PLACEHOLDER/${SRT_LATENCY:-200}/" "$CONF"

# The uploader rejects every webhook without this, so an empty value is a misconfiguration worth
# failing on here rather than at the first publish. SRS cannot sign its callbacks or send a header,
# so the credential travels in the hook URL.
if [ -z "${SRS_WEBHOOK_TOKEN:-}" ]; then
  echo "SRS_WEBHOOK_TOKEN is empty. The stream-uploader will reject every webhook." >&2
  echo "Set it in engines/srs/.env: openssl rand -hex 32" >&2
  exit 1
fi

# Substitute webhook host and port
sed -i "s/SRS_ADAPTER_HOST_PLACEHOLDER/${SRS_ADAPTER_HOST:-stream-uploader}/g" "$CONF"
sed -i "s/SRS_WEBHOOK_TOKEN_PLACEHOLDER/${SRS_WEBHOOK_TOKEN}/g" "$CONF"
sed -i "s/SRS_ADAPTER_PORT_PLACEHOLDER/${SRS_ADAPTER_PORT:-3000}/g" "$CONF"

# The ports SRS itself binds, which are not the same question as the ports compose publishes.
#
# Under `COMPOSE_NETWORK=host` docker discards the published-port mapping entirely and the container
# binds the host directly, so a config that hard-codes these makes `--portSlot` a no-op for this
# service: the deploy prints the shifted ports while SRS listens on the originals, and a second
# profile on the same host dies with `SocketBind ... Address already in use` on 8080. Defaults are
# the values that were hard-coded here, so a deployment that sets none of them is unchanged.
sed -i "s/RTMP_PORT_PLACEHOLDER/${SRS_RTMP_PORT:-1935}/g" "$CONF"
sed -i "s/HTTP_PORT_PLACEHOLDER/${SRS_HTTP_PORT:-8080}/g" "$CONF"
sed -i "s/SRT_PORT_PLACEHOLDER/${SRS_SRT_PORT:-10080}/g" "$CONF"

# Ensure HLS output directories exist with open permissions
# These are shared with the uploader container which needs read + delete access
mkdir -p ./objs/nginx/html/video
mkdir -p ./objs/nginx/html/audio
chmod 777 ./objs/nginx/html ./objs/nginx/html/video ./objs/nginx/html/audio

echo "srs.conf generated from template"

exec ./objs/srs -c conf/srs.conf
