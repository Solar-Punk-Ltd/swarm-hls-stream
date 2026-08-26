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

require_int() {
  case "$2" in
    '' | *[!0-9]*) echo "$1 must be a positive integer, got '$2'" >&2; exit 1 ;;
  esac
}

# Names reach the generated config as bare tokens and as part of an RTMP URL, so anything
# outside this set could terminate a directive early or redirect the republish elsewhere.
require_name() {
  case "$2" in
    '' | *[!a-zA-Z0-9._-]*) echo "$1 must match [a-zA-Z0-9._-]+, got '$2'" >&2; exit 1 ;;
  esac
}

# Segment length, and how much of it the playlist keeps.
#
# **This is the largest latency lever on the engine side**, and it is bounded from below by the
# publisher: SRS prefers to cut on a keyframe, so the segment a viewer waits for is the first keyframe
# at or after `HLS_FRAGMENT`, not `HLS_FRAGMENT` itself. Measured on the deployment host on
# 2026-08-03, a 2s GOP against a 1.5 fragment produced segments of exactly 2.00s on every sample.
# Lowering this alone therefore changes nothing until the GOP comes down with it.
#
# **Except past `HLS_AOF_RATIO`, which this comment used to omit and which cost twelve runs.** SRS
# force-closes a segment at `HLS_FRAGMENT * HLS_AOF_RATIO` whether a keyframe has arrived or not, so
# the preference above is only a preference while the GOP fits inside that product. On 2026-08-05 a
# fragment of 0.25 against a 2s GOP produced 0.53s segments of 13 packets, against 2.11s and 59 at a
# fragment of 1.0: SRS's default ratio is 2.1, and 0.25 * 2.1 is 0.525. Every one of those segments
# was cut mid-GOP and carried no keyframe, and 281 of them could not be read at all.
#
# So the pair has a rule: **`HLS_FRAGMENT <= GOP <= HLS_FRAGMENT * HLS_AOF_RATIO`**. A sweep that
# holds the fragment still while moving the GOP has to raise the ratio far enough to cover the whole
# range, which is what the ratio is a knob for.
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
require_number HLS_FRAGMENT "${HLS_FRAGMENT:-0.5}"
require_number HLS_WINDOW "${HLS_WINDOW:-15}"
# 2.1 is SRS's own default, so naming it here changes no deployment that does not set it.
require_number HLS_AOF_RATIO "${HLS_AOF_RATIO:-5.0}"
HLS_FRAGMENT="${HLS_FRAGMENT:-0.5}"
HLS_WINDOW="${HLS_WINDOW:-15}"
HLS_AOF_RATIO="${HLS_AOF_RATIO:-5.0}"

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

SRS_ADAPTER_HOST="${SRS_ADAPTER_HOST:-stream-uploader}"
SRS_ADAPTER_PORT="${SRS_ADAPTER_PORT:-3000}"

# ---------------------------------------------------------------------------------------------
# ABR ladder
#
# Off by default: with ABR_ENABLED unset this file produces exactly the single-rendition config
# it always has. Enabled, the ingest vhost stops segmenting and becomes a transcode source, and
# each rung is republished onto a second vhost that carries the HLS and the webhooks.
#
# The second vhost is not tidiness. Transcode scope is matched at vhost, app and stream level and
# the matches are cumulative (srs_app_encoder.cpp, parse_scope_engines), so a rung republished
# into the vhost that transcodes would match the same rule and be transcoded again, and its
# output again, without limit. A vhost with no transcode block is what terminates that.
#
# Audio is muxed into every rung rather than split into an EXT-X-MEDIA rendition group. Four
# copies of the audio track cost single-digit percent against the video ladder, and muxing keeps
# A/V sync and alternate-track handling out of a POC whose question is whether ABR works over
# Swarm feeds at all. TODO: split audio once the ladder is proven.
# ---------------------------------------------------------------------------------------------

# ABR_ENABLED is read by the stream-uploader as well, through a parser that accepts only
# true/1/false/0 and quietly falls back to its default for anything else. Accepting a wider
# spelling here than it does would let one value turn the ladder on for SRS and off for the
# uploader — four encodes published as four unrelated streams, with no ladder for anyone. So
# refuse what the other side cannot read, rather than guess.
abr_enabled() {
  case "${ABR_ENABLED:-false}" in
    true | 1) return 0 ;;
    false | 0) return 1 ;;
    *)
      echo "ABR_ENABLED must be one of true, 1, false, 0 — got '$ABR_ENABLED'." >&2
      echo "The stream-uploader reads this same value and accepts only those four." >&2
      exit 1
      ;;
  esac
}

TRANSCODE_FRAGMENT=/tmp/srs-transcode.conf
ABR_VHOST_FRAGMENT=/tmp/srs-abr-vhost.conf

if abr_enabled; then
  ABR_VHOST="${ABR_VHOST:-abr}"
  # The transcode republish dials SRS's own RTMP listener over loopback, so this has to be the port
  # SRS actually bound, which is SRS_RTMP_PORT and shifts with --portSlot. Default to it rather than
  # a fixed 1935, or the ladder produces no segments the moment the RTMP port is slotted. Deliberately
  # not SRS's `[port]` macro, which resolves to the port the source arrived on: this deployment
  # ingests over SRT on 10080, so `[port]` would aim the republish at the SRT listener. See ossrs/srs#4496.
  ABR_RTMP_PORT="${ABR_RTMP_PORT:-${SRS_RTMP_PORT:-1935}}"
  ABR_FPS="${ABR_FPS:-30}"
  ABR_PRESET="${ABR_PRESET:-veryfast}"
  ABR_PROFILE="${ABR_PROFILE:-main}"
  ABR_THREADS="${ABR_THREADS:-0}"
  ABR_ACODEC="${ABR_ACODEC:-copy}"
  ABR_AUDIO_BITRATE="${ABR_AUDIO_BITRATE:-128}"
  ABR_VBV_SECONDS="${ABR_VBV_SECONDS:-1}"
  ABR_LADDER="${ABR_LADDER:-1080p:1920:1080:5000 720p:1280:720:2800 480p:854:480:1200 360p:640:360:700}"

  require_name ABR_VHOST "$ABR_VHOST"
  require_int ABR_RTMP_PORT "$ABR_RTMP_PORT"
  require_int ABR_FPS "$ABR_FPS"
  require_int ABR_THREADS "$ABR_THREADS"
  require_int ABR_VBV_SECONDS "$ABR_VBV_SECONDS"
  require_int ABR_AUDIO_BITRATE "$ABR_AUDIO_BITRATE"
  require_name ABR_PRESET "$ABR_PRESET"
  require_name ABR_PROFILE "$ABR_PROFILE"
  require_name ABR_ACODEC "$ABR_ACODEC"

  # Every rung must place its keyframes at the same media timestamps, or a switch lands in the
  # middle of a GOP and produces a gap or an overlap. `force_key_frames` does the real work;
  # g/keyint_min/sc_threshold stop x264 inserting extra ones in between, which would not break a
  # switch but would waste bitrate. A GOP that is not a whole number of frames cannot be
  # expressed, and silently rounding it is exactly the drift this is meant to prevent, so refuse.
  ABR_GOP=$(awk -v f="$ABR_FPS" -v d="$HLS_FRAGMENT" 'BEGIN { printf "%.6f", f * d }')
  case "$ABR_GOP" in
    *.000000) ABR_GOP="${ABR_GOP%.000000}" ;;
    *)
      echo "ABR_FPS ($ABR_FPS) x HLS_FRAGMENT ($HLS_FRAGMENT) = $ABR_GOP, which is not a whole number of frames." >&2
      echo "Pick values whose product is an integer, otherwise the rungs cannot share keyframe positions." >&2
      exit 1
      ;;
  esac

  {
    echo "    # Generated by entrypoint.sh from ABR_LADDER. One ffmpeg process per engine, each"
    echo "    # decoding the source independently — this is the CPU floor of the ladder."
    echo "    transcode {"
    echo "        enabled     on;"
    echo "        ffmpeg      ./objs/ffmpeg/bin/ffmpeg;"
  } > "$TRANSCODE_FRAGMENT"

  for rung in $ABR_LADDER; do
    IFS=':' read -r name width height vbitrate <<< "$rung"
    if [ -z "$name" ] || [ -z "$width" ] || [ -z "$height" ] || [ -z "$vbitrate" ]; then
      echo "ABR_LADDER entry '$rung' must be name:width:height:kbps" >&2
      exit 1
    fi
    require_name "ABR_LADDER rung name" "$name"
    require_int "ABR_LADDER width ($name)" "$width"
    require_int "ABR_LADDER height ($name)" "$height"
    require_int "ABR_LADDER bitrate ($name)" "$vbitrate"

    # x264 rejects odd dimensions outright; catching it here beats a crash-looping ffmpeg.
    if [ $((width % 2)) -ne 0 ] || [ $((height % 2)) -ne 0 ]; then
      echo "ABR_LADDER rung '$name' has odd dimensions ${width}x${height}; H.264 requires even ones" >&2
      exit 1
    fi

    {
      echo ""
      echo "        engine ${name} {"
      echo "            enabled         on;"
      echo "            iformat         flv;"
      echo "            oformat         flv;"
      echo "            vcodec          libx264;"
      echo "            vbitrate        ${vbitrate};"
      echo "            vfps            ${ABR_FPS};"
      echo "            vwidth          ${width};"
      echo "            vheight         ${height};"
      echo "            vthreads        ${ABR_THREADS};"
      echo "            vprofile        ${ABR_PROFILE};"
      echo "            vpreset         ${ABR_PRESET};"
      echo "            vparams {"
      echo "                g                   ${ABR_GOP};"
      echo "                keyint_min          ${ABR_GOP};"
      echo "                sc_threshold        0;"
      echo "                force_key_frames    expr:gte(t,n_forced*${HLS_FRAGMENT});"
      # vbitrate alone reaches x264 as -b:v, which is an average it is free to overshoot: measured
      # against a 700kbps rung it ran 40% over, and every one of those bytes is a chunk a viewer has
      # to retrieve. maxrate plus bufsize is the VBV constraint that makes the target a ceiling.
      #
      # bufsize equal to maxrate is one second of buffer — tight, which is what a live ladder wants:
      # a larger buffer lets a complex scene borrow bitrate from its neighbours and produces exactly
      # the segment-size spikes that stall retrieval. Raise ABR_VBV_SECONDS if quality suffers more
      # than the spikes cost.
      echo "                maxrate             ${vbitrate}k;"
      echo "                bufsize             $((vbitrate * ABR_VBV_SECONDS))k;"
      echo "            }"
      echo "            acodec          ${ABR_ACODEC};"
      if [ "$ABR_ACODEC" != "copy" ]; then
        echo "            abitrate        ${ABR_AUDIO_BITRATE};"
        echo "            asample_rate    44100;"
        echo "            achannels       2;"
      fi
      echo "            aparams {"
      echo "            }"
      echo "            output          rtmp://127.0.0.1:${ABR_RTMP_PORT}/[app]/[stream]_${name}?vhost=${ABR_VHOST};"
      echo "        }"
    } >> "$TRANSCODE_FRAGMENT"
  done

  echo "    }" >> "$TRANSCODE_FRAGMENT"

  # The vhost the rungs land on. It has no transcode block, and must not grow one.
  cat > "$ABR_VHOST_FRAGMENT" <<EOF
vhost ${ABR_VHOST} {
    hls {
        enabled         on;
        hls_path        ./objs/nginx/html;
        hls_fragment    ${HLS_FRAGMENT};
        # Without this the rungs run on SRS's own 2.1 default while the ingest vhost runs on
        # the configured ratio, so an enabled ladder force-closes segments the single-rendition
        # path does not. 0.5 * 5.0 = 2.5s, the ceiling latbench has always run.
        hls_aof_ratio   ${HLS_AOF_RATIO};
        hls_window      ${HLS_WINDOW};
        hls_ts_file     [app]/[stream]/[stream]-[seq].ts;
        hls_m3u8_file   [app]/[stream]/index.m3u8;
    }

    http_hooks {
        enabled         on;
        on_publish      http://${SRS_ADAPTER_HOST}:${SRS_ADAPTER_PORT}/engines/srs/streams?token=SRS_WEBHOOK_TOKEN_PLACEHOLDER;
        on_unpublish    http://${SRS_ADAPTER_HOST}:${SRS_ADAPTER_PORT}/engines/srs/streams?token=SRS_WEBHOOK_TOKEN_PLACEHOLDER;
        on_hls          http://${SRS_ADAPTER_HOST}:${SRS_ADAPTER_PORT}/engines/srs/hls?token=SRS_WEBHOOK_TOKEN_PLACEHOLDER;
    }
}
EOF

  sed -i "s/INGEST_HLS_PLACEHOLDER/off/" "$CONF"
  sed -i -e "/TRANSCODE_PLACEHOLDER/r $TRANSCODE_FRAGMENT" -e "/TRANSCODE_PLACEHOLDER/d" "$CONF"
  sed -i -e "/ABR_VHOST_PLACEHOLDER/r $ABR_VHOST_FRAGMENT" -e "/ABR_VHOST_PLACEHOLDER/d" "$CONF"

  echo "ABR ladder enabled: [$ABR_LADDER] -> vhost '$ABR_VHOST', ${ABR_FPS}fps, GOP ${ABR_GOP}, audio '${ABR_ACODEC}'"
else
  sed -i "s/INGEST_HLS_PLACEHOLDER/on/" "$CONF"
  sed -i -e '/TRANSCODE_PLACEHOLDER/d' -e '/ABR_VHOST_PLACEHOLDER/d' "$CONF"
fi

sed -i "s/HLS_FRAGMENT_PLACEHOLDER/${HLS_FRAGMENT:-0.5}/" "$CONF"
sed -i "s/HLS_AOF_RATIO_PLACEHOLDER/${HLS_AOF_RATIO:-5.0}/" "$CONF"
sed -i "s/HLS_WINDOW_PLACEHOLDER/${HLS_WINDOW:-15}/" "$CONF"

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
# These are shared with the uploader container which needs read + delete access.
# The ABR vhost reuses [app], so the rungs land in these same directories under their own
# per-stream subdirectory — no extra directory is needed when the ladder is on.
mkdir -p ./objs/nginx/html/video
mkdir -p ./objs/nginx/html/audio
chmod 777 ./objs/nginx/html ./objs/nginx/html/video ./objs/nginx/html/audio

echo "srs.conf generated from template"

exec ./objs/srs -c conf/srs.conf
