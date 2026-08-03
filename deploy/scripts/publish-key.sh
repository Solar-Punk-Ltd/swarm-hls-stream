#!/bin/bash

# Print the publish key for one stream, and the publish URL a broadcaster uses with it. See SEC-28.
#
# Shell rather than a Node entry point because the secret lives in this host's env file and this host
# is not required to have Node on it. The derivation has to agree with `utils/publishKey.ts` exactly,
# so the derivation itself lives in `_lib.sh` as `derive_publish_key`, where a test can call it rather
# than keeping its own copy of the pipeline.

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

usage() {
  echo "Usage: publish-key.sh [--profile=<name>] <app/stream>"
  echo
  echo "  Prints the publish key for one stream id, derived from PUBLISH_KEY_SECRET."
  echo "  The key is per stream: it proves nothing about any other, so it is safe to hand"
  echo "  to whoever broadcasts that stream and only that stream."
  exit 1
}

parse_profile_args "$@"
set -- "${REST_ARGS[@]}"

STREAM_ID="${1:-}"
[ -n "$STREAM_ID" ] || usage
# Same shape the uploader builds its stream ids in, and the key is derived over that exact string, so
# a mistyped id here yields a key the service will refuse rather than a confusing partial match.
case "$STREAM_ID" in
  */*/*) echo "A stream id is <app>/<stream>, with one slash: got '$STREAM_ID'" >&2; exit 1 ;;
  */*) ;;
  *) echo "A stream id is <app>/<stream>: got '$STREAM_ID'" >&2; exit 1 ;;
esac

require_config
load_env
load_engine_envs
apply_port_slot

if [ -z "${PUBLISH_KEY_SECRET:-}" ]; then
  cat >&2 <<EOF
PUBLISH_KEY_SECRET is not set, so publisher authentication is off and there is no key to issue.
Every publisher can currently claim any stream name this deployment serves.

To turn it on, add a secret to $ENV_FILE and redeploy the stream-uploader:

  PUBLISH_KEY_SECRET=\$(openssl rand -hex 32)

Doing so refuses every publisher that does not present a key, so issue the keys first.
EOF
  exit 1
fi

if [ "${#PUBLISH_KEY_SECRET}" -lt 32 ]; then
  echo "PUBLISH_KEY_SECRET must be at least 32 characters, which is what the service enforces at startup" >&2
  exit 1
fi

KEY=$(derive_publish_key "$PUBLISH_KEY_SECRET" "$STREAM_ID")

APP="${STREAM_ID%%/*}"
STREAM="${STREAM_ID#*/}"

# OME takes the whole publish URL as an SRT `streamid`, so the key sits inside a value that is itself
# inside a query. The inner `?` and `/` have to be percent-encoded or the publisher's own URL parser
# eats them: with the plain spelling ffmpeg sends a streamid OME cannot resolve. Encoded by hand
# rather than with a helper, because the alphabet here is fixed and known.
ENCODED_STREAMID="srt%3A%2F%2F<host>%2F$APP%2F$STREAM%3Fkey%3D$KEY"

echo "Stream:      $STREAM_ID"
echo "Publish key: $KEY"
echo
echo "SRS  (RTMP): rtmp://<host>:${SRS_RTMP_PORT:-1935}/$APP/$STREAM?key=$KEY"
echo "OME  (SRT):  srt://<host>:${OME_SRT_PORT:-10080}?streamid=$ENCODED_STREAMID"
echo "             (the streamid is percent-encoded on purpose: unencoded, the publisher's own URL"
echo "              parser splits on the inner ? and OME never sees the key)"
echo
echo "The key is derived from the stream id, so it authorises this stream and no other."
echo "Rotating PUBLISH_KEY_SECRET invalidates every key at once, which is the only revocation there is."
