#!/bin/bash
set -e

CONF_DIR=/opt/ovenmediaengine/bin/origin_conf
CONF="$CONF_DIR/Server.xml"
TEMPLATE=/opt/ovenmediaengine/conf-template/Server.xml.template

mkdir -p "$CONF_DIR"
cp "$TEMPLATE" "$CONF"


# Refuse rather than splice. These values land inside a `sed` s/// expression, where a `/` aborts
# the substitution and `&` expands to the whole match, so a typo would either crash-loop the
# container under `restart: unless-stopped` or silently write a corrupt config.
require_number() {
  case "$2" in
    '' | *[!0-9.]* | *.*.*) echo "$1 must be a positive number, got '$2'" >&2; exit 1 ;;
  esac
}

# Segment length and playlist depth, applied to both the video and audio applications.
# Defaults reproduce the previous hardcoded values, which were 2s where SRS used 1.5s.
require_number HLS_SEGMENT_DURATION "${HLS_SEGMENT_DURATION:-2}"
require_number HLS_SEGMENT_COUNT "${HLS_SEGMENT_COUNT:-5}"
sed -i "s/SEGMENT_DURATION_PLACEHOLDER/${HLS_SEGMENT_DURATION:-2}/g" "$CONF"
sed -i "s/SEGMENT_COUNT_PLACEHOLDER/${HLS_SEGMENT_COUNT:-5}/g" "$CONF"

# Substitute webhook host and port
sed -i "s/OME_ADAPTER_HOST_PLACEHOLDER/${OME_ADAPTER_HOST:-stream-uploader}/g" "$CONF"
sed -i "s/OME_ADAPTER_PORT_PLACEHOLDER/${OME_ADAPTER_PORT:-3000}/g" "$CONF"
sed -i "s|OME_ADMISSION_SECRET_PLACEHOLDER|${OME_ADMISSION_SECRET:-}|g" "$CONF"

echo "Server.xml generated from template"

exec /opt/ovenmediaengine/bin/OvenMediaEngine -c "$CONF_DIR"
