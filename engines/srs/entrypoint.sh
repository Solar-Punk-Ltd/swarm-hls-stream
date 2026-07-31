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

# Ensure HLS output directories exist with open permissions
# These are shared with the uploader container which needs read + delete access
mkdir -p ./objs/nginx/html/video
mkdir -p ./objs/nginx/html/audio
chmod 777 ./objs/nginx/html ./objs/nginx/html/video ./objs/nginx/html/audio

echo "srs.conf generated from template"

exec ./objs/srs -c conf/srs.conf
