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

# Segment length, and how much of it the playlist keeps. SRS can only cut on a keyframe, so a
# publisher whose GOP is longer than the fragment produces segments longer than this asks for.
require_number HLS_FRAGMENT "${HLS_FRAGMENT:-1.5}"
require_number HLS_WINDOW "${HLS_WINDOW:-22.5}"
sed -i "s/HLS_FRAGMENT_PLACEHOLDER/${HLS_FRAGMENT:-1.5}/" "$CONF"
sed -i "s/HLS_WINDOW_PLACEHOLDER/${HLS_WINDOW:-22.5}/" "$CONF"

# Substitute webhook host and port
sed -i "s/SRS_ADAPTER_HOST_PLACEHOLDER/${SRS_ADAPTER_HOST:-stream-uploader}/g" "$CONF"
sed -i "s/SRS_ADAPTER_PORT_PLACEHOLDER/${SRS_ADAPTER_PORT:-3000}/g" "$CONF"

# Ensure HLS output directories exist with open permissions
# These are shared with the uploader container which needs read + delete access
mkdir -p ./objs/nginx/html/video
mkdir -p ./objs/nginx/html/audio
chmod 777 ./objs/nginx/html ./objs/nginx/html/video ./objs/nginx/html/audio

echo "srs.conf generated from template"

exec ./objs/srs -c conf/srs.conf
