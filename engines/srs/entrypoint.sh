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
