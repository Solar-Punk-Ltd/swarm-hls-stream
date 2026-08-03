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
# These were configurable on `main` and this branch hard-coded them back, which took the knob away
# without anything failing. Restored under main's names.
#
# The default is 1.0 rather than main's 1.5, from the sweep of 2026-08-03: 105 samples across four
# segment durations on the deployment host, where capture to fetchable came out at 1.96s, 2.94s,
# 5.00s and 9.42s for segments of 0.5s, 1.0s, 2.0s and 4.0s. It is close to linear in the segment,
# and the segment is not the only term that moves, because a shorter one is less data to write into
# Swarm and less to pull back.
#
# 1.0 rather than the 0.5 that measured best, because segment count is an operational cost as well as
# a latency lever: per minute of broadcast, 0.5s segments mean four times the uploads and four times
# the manifest feed writes of the 2.0s this replaces. 1.0 takes most of the latency and doubles that
# rate rather than quadrupling it. 0.5 is measured, supported, and there for anyone who wants it.
#
# `LIVE_SYNC_DURATION_S` in the client is 6 for exactly this default. The two were chosen together:
# a deployment that raises this has to raise that or it will rebuffer.
# `HLS_WINDOW` stays at fifteen fragments, which is what 22.5 against 1.5 already was.
require_number HLS_FRAGMENT "${HLS_FRAGMENT:-1.0}"
require_number HLS_WINDOW "${HLS_WINDOW:-15}"
sed -i "s/HLS_FRAGMENT_PLACEHOLDER/${HLS_FRAGMENT:-1.0}/" "$CONF"
sed -i "s/HLS_WINDOW_PLACEHOLDER/${HLS_WINDOW:-15}/" "$CONF"

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
