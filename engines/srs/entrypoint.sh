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


# Refuse rather than splice. These values land inside a `sed` s/// expression, where a `/` aborts
# the substitution and `&` expands to the whole match, so a typo would either crash-loop the
# container under `restart: unless-stopped` or silently write a corrupt config.
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

# Segment length, and how much of it the playlist keeps. SRS can only cut on a keyframe, so a
# publisher whose GOP is longer than the fragment produces segments longer than this asks for.
require_number HLS_FRAGMENT "${HLS_FRAGMENT:-1.5}"
require_number HLS_WINDOW "${HLS_WINDOW:-22.5}"
HLS_FRAGMENT="${HLS_FRAGMENT:-1.5}"
HLS_WINDOW="${HLS_WINDOW:-22.5}"

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
  # Deliberately not SRS's `[port]`, which resolves to the port the *source* arrived on. This
  # deployment ingests over SRT on 10080, so `[port]` would aim the republish at the SRT
  # listener and nothing would ever appear. See ossrs/srs#4496.
  ABR_RTMP_PORT="${ABR_RTMP_PORT:-1935}"
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
        hls_window      ${HLS_WINDOW};
        hls_ts_file     [app]/[stream]/[stream]-[seq].ts;
        hls_m3u8_file   [app]/[stream]/index.m3u8;
    }

    http_hooks {
        enabled         on;
        on_publish      http://${SRS_ADAPTER_HOST}:${SRS_ADAPTER_PORT}/engines/srs/streams;
        on_unpublish    http://${SRS_ADAPTER_HOST}:${SRS_ADAPTER_PORT}/engines/srs/streams;
        on_hls          http://${SRS_ADAPTER_HOST}:${SRS_ADAPTER_PORT}/engines/srs/hls;
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

sed -i "s/HLS_FRAGMENT_PLACEHOLDER/${HLS_FRAGMENT}/" "$CONF"
sed -i "s/HLS_WINDOW_PLACEHOLDER/${HLS_WINDOW}/" "$CONF"

# Substitute webhook host and port
sed -i "s/SRS_ADAPTER_HOST_PLACEHOLDER/${SRS_ADAPTER_HOST}/g" "$CONF"
sed -i "s/SRS_ADAPTER_PORT_PLACEHOLDER/${SRS_ADAPTER_PORT}/g" "$CONF"

# Ensure HLS output directories exist with open permissions
# These are shared with the uploader container which needs read + delete access.
# The ABR vhost reuses [app], so the rungs land in these same directories under their own
# per-stream subdirectory — no extra directory is needed when the ladder is on.
mkdir -p ./objs/nginx/html/video
mkdir -p ./objs/nginx/html/audio
chmod 777 ./objs/nginx/html ./objs/nginx/html/video ./objs/nginx/html/audio

echo "srs.conf generated from template"

exec ./objs/srs -c conf/srs.conf
