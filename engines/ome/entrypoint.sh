#!/bin/bash
set -e

CONF_DIR=/opt/ovenmediaengine/bin/origin_conf
CONF="$CONF_DIR/Server.xml"
TEMPLATE=/opt/ovenmediaengine/conf-template/Server.xml.template
# A config file of the operator's own, mounted here by deploy/docker-compose.ome-conf.yml when
# OME_CONF_FILE is set. It goes through every substitution below exactly as the template does: a
# *_PLACEHOLDER token it keeps is filled, one it dropped is simply not there. See engines/README.md,
# "Your own config file".
CUSTOM=/opt/ovenmediaengine/conf-template/Server.xml.custom

# Substituting an empty secret would render an empty SecretKey element and leave OME either refusing the
# config or signing admission requests with an empty key, which the uploader rejects. Both surface as
# an unexplained ingest failure, so fail here with the reason instead.
if [ -z "${OME_ADMISSION_SECRET:-}" ]; then
  echo "OME_ADMISSION_SECRET is empty. Set it in engines/ome/.env, e.g. openssl rand -hex 32" >&2
  exit 1
fi

mkdir -p "$CONF_DIR"
# --- config source ---
# Docker mounts a host path that names nothing as an empty directory, so a directory here is a
# OME_CONF_FILE that is wrong on the machine that runs compose. Running on the template instead would
# look exactly like the file being honoured, from outside and in this log.
if [ -d "$CUSTOM" ]; then
  echo "error: $CUSTOM is a directory, which is what docker mounts when OME_CONF_FILE names a path that is not a file on the machine that runs compose. Fix the path, or unset it to run on the template." >&2
  exit 1
fi
if [ -f "$CUSTOM" ]; then
  cp "$CUSTOM" "$CONF"
  CONF_SOURCE="the custom config file"
else
  cp "$TEMPLATE" "$CONF"
  CONF_SOURCE="the template"
fi
# --- end config source ---


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

# The ports OME itself binds, which used to be hardcoded in the template at 10080 and 8081 while
# `OME_SRT_PORT` and `OME_HLS_PORT` existed only as compose publish mappings.
#
# On the bridge that difference is invisible, because the mapping translates the fixed container port
# to whatever the operator asked for. **Under `network_mode: host` compose discards the mapping**, so
# those two variables became inert: OME stayed on 10080 and 8081, the publisher dialled the port it
# was configured with and reached nothing, and the uploader's puller polled an HLS port where nothing
# served. Every scenario then failed on its warmup with no admission ever logged, which reads as a
# broken engine rather than as a port that was never applied. Measured on 2026-08-03.
#
# Binding what the operator configured also makes two OME stacks on one host possible at all. They
# previously collided on 10080 and 8081 however they were configured.
sed -i "s/OME_SRT_PORT_PLACEHOLDER/${OME_SRT_PORT:-10080}/g" "$CONF"
sed -i "s/OME_HLS_PORT_PLACEHOLDER/${OME_HLS_PORT:-8081}/g" "$CONF"

echo "Server.xml generated from $CONF_SOURCE"

exec /opt/ovenmediaengine/bin/OvenMediaEngine -c "$CONF_DIR"
