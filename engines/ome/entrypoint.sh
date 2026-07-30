#!/bin/bash
set -e

CONF_DIR=/opt/ovenmediaengine/bin/origin_conf
CONF="$CONF_DIR/Server.xml"
TEMPLATE=/opt/ovenmediaengine/conf-template/Server.xml.template

# Substituting an empty secret would render an empty SecretKey element and leave OME either refusing the
# config or signing admission requests with an empty key, which the uploader rejects. Both surface as
# an unexplained ingest failure, so fail here with the reason instead.
if [ -z "${OME_ADMISSION_SECRET:-}" ]; then
  echo "OME_ADMISSION_SECRET is empty. Set it in engines/ome/.env, e.g. openssl rand -hex 32" >&2
  exit 1
fi

mkdir -p "$CONF_DIR"
cp "$TEMPLATE" "$CONF"

# Substitute webhook host and port
sed -i "s/OME_ADAPTER_HOST_PLACEHOLDER/${OME_ADAPTER_HOST:-stream-uploader}/g" "$CONF"
sed -i "s/OME_ADAPTER_PORT_PLACEHOLDER/${OME_ADAPTER_PORT:-3000}/g" "$CONF"
sed -i "s|OME_ADMISSION_SECRET_PLACEHOLDER|${OME_ADMISSION_SECRET:-}|g" "$CONF"

echo "Server.xml generated from template"

exec /opt/ovenmediaengine/bin/OvenMediaEngine -c "$CONF_DIR"
