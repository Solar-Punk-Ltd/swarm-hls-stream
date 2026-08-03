#!/bin/bash

# Print the publish key for one stream, and the publish URL a broadcaster uses with it. See SEC-28.
#
# A shell entry point because it reads this host's env file and sits beside the other operator
# scripts, but the derivation itself is `derive_publish_key` in `_lib.sh`, where a test can call it
# rather than keeping its own copy, and where the secret is kept out of any command line.

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

# Mirrors STREAM_ID_SEGMENT and MAX_STREAM_ID_LENGTH in packages/stream-uploader/src/utils/streamId.ts.
#
# The one-slash check alone was not the same shape the service accepts, only the same shape it is
# spelled in, so this issued a real key and exited 0 for ids like `-weird/demo`, `video/my demo` and
# `video/a&b`. Every one is refused by parseAppStream as an unusable name, which from the outside
# looks exactly like an authentication failure, which is the confusion this check exists to prevent.
#
# `&` in particular also breaks the printed URL: it terminates the outer query, so the key is lost
# before OME sees it. The hand-rolled encoder below is complete for every id the service would accept
# and for none of the ones it would not, so screening here is what keeps that true.
readonly SEGMENT_RE='^[A-Za-z0-9][A-Za-z0-9._-]*$'
readonly MAX_STREAM_ID_LENGTH=128

case "$STREAM_ID" in
  */*/*) echo "A stream id is <app>/<stream>, with one slash: got '$STREAM_ID'" >&2; exit 1 ;;
  */*) ;;
  *) echo "A stream id is <app>/<stream>: got '$STREAM_ID'" >&2; exit 1 ;;
esac

if [ "${#STREAM_ID}" -gt "$MAX_STREAM_ID_LENGTH" ]; then
  echo "A stream id is at most $MAX_STREAM_ID_LENGTH characters, which is what the service enforces" >&2
  exit 1
fi

for segment in "${STREAM_ID%%/*}" "${STREAM_ID#*/}"; do
  if [[ ! "$segment" =~ $SEGMENT_RE ]]; then
    echo "'$segment' is not a usable app or stream name: the service accepts letters, digits, dot," >&2
    echo "underscore and hyphen, beginning with a letter or digit. A key issued for this id would be" >&2
    echo "refused, and the refusal would look like an authentication failure." >&2
    exit 1
  fi
done

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

# Checked rather than trusted. `derive_publish_key` exits non-zero on a secret the service would
# reject, and printing an empty key with a zero status is the failure that hands an operator a
# `?key=` nobody can publish with while telling them it worked.
if ! KEY=$(derive_publish_key "$STREAM_ID"); then
  exit 1
fi
if [[ ! "$KEY" =~ ^[a-f0-9]{32}$ ]]; then
  echo "Derived a publish key that is not 32 hex characters, refusing to print it" >&2
  exit 1
fi

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
