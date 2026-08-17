#!/usr/bin/env bash
#
# Refuse a sitting whose stage is not producing the segment length the driver asked for.
#
# ## The gap this closes
#
# `byte-source-arms.sh` passes `--gop` to the publisher and then writes that number into every
# artefact the sitting produces. Nothing has ever checked what came out the other side. A sitting can
# run for hours against a stage configured differently from what the driver believes, and every report
# it writes names a segment length that was never published.
#
# ⛔⛔ This stopped being hypothetical on 2026-08-17. A co-tenant session on this host changed
# `hls_fragment` to 2.0 on its own SRS stack. Ours was untouched, and the only reason anyone knows
# that is that somebody ran `docker exec` by hand. The neighbouring stack is one wrong compose file
# away from being ours.
#
# ⛔ The failure is not only a neighbour's. SRS publishes `segment = ceil(fragment / GOP) * GOP`,
# bounded to `[fragment, fragment * aof_ratio]`, and this project has left that range twice by its own
# hand.
#
# ## Why a gate rather than a column in the report
#
# A number written into an artefact is read after the money is spent. A threshold you wrote down is
# not a control and only a gate that refuses is one, so this exits non-zero and sits between the
# driver and its first arm.
#
# ## ⛔⛔⛔ It refuses on absence, and that is the point
#
# "I could not find a playlist" and "the playlist says nothing is wrong" are the same return value to
# anything that only checks for a mismatch. Every way of learning nothing here is a refusal: no
# container, no playlist, no `#EXTINF` lines, too few of them, an unreadable config.
#
# ⭐ This file gathers, and `stage-fingerprint.py` judges. The split is not taste: the judgement lived
# here as `python3 -c '...'` for one revision and **exited 0 without running, silently**, because a
# python comment contained an apostrophe that closed the shell string. The gate approved everything it
# was built to refuse, and printed nothing while doing it.
#
# Usage:
#   deploy/scripts/stage-fingerprint.sh --container latbench-srs-1 --gop 0.5
#
# Overrides that replace the two container reads and nothing else, for tests and for reading a
# playlist somebody already captured:
#   --conf-file <path>      the SRS config to read hls_fragment and hls_aof_ratio from
#   --playlist-file <path>  the m3u8 to read raw #EXTINF from
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CONTAINER=""
GOP=""
CONF_FILE=""
PLAYLIST_FILE=""
# Where SRS writes its playlists, from `engines/srs/srs.conf.template`: `hls_path ./objs/nginx/html`
# and `hls_m3u8_file [app]/[stream]/index.m3u8`, against the stock image's working directory.
HLS_ROOT="${HLS_ROOT:-/usr/local/srs/objs/nginx/html}"
SRS_CONF="${SRS_CONF:-/usr/local/srs/conf/srs.conf}"
MIN_SEGMENTS="${MIN_SEGMENTS:-6}"
TOLERANCE="${TOLERANCE:-0.10}"

while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --gop) GOP="$2"; shift 2 ;;
    --conf-file) CONF_FILE="$2"; shift 2 ;;
    --playlist-file) PLAYLIST_FILE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "${GOP}" ] || { echo "stage-fingerprint: --gop is required" >&2; exit 2; }
if [ -z "${CONTAINER}" ] && { [ -z "${CONF_FILE}" ] || [ -z "${PLAYLIST_FILE}" ]; }; then
  echo "stage-fingerprint: --container is required unless both file overrides are given" >&2
  exit 2
fi

WORK=""
cleanup() { [ -n "${WORK}" ] && rm -rf "${WORK}"; }
trap cleanup EXIT

if [ -z "${CONF_FILE}" ] || [ -z "${PLAYLIST_FILE}" ]; then
  WORK="$(mktemp -d)"
fi

if [ -z "${CONF_FILE}" ]; then
  CONF_FILE="${WORK}/srs.conf"
  docker exec "${CONTAINER}" sh -c "cat ${SRS_CONF}" > "${CONF_FILE}" 2>/dev/null
fi

# ⭐ The NEWEST playlist under the tree, not a path built from an app and stream name the driver would
# have to be told. The driver's belief about which stream is live is one of the things being checked,
# so deriving the path from it would let a mismatch pick its own evidence.
if [ -z "${PLAYLIST_FILE}" ]; then
  PLAYLIST_FILE="${WORK}/index.m3u8"
  docker exec "${CONTAINER}" sh -c \
    "find ${HLS_ROOT} -name '*.m3u8' -exec ls -t {} + 2>/dev/null | head -1 | xargs -r cat 2>/dev/null" \
    > "${PLAYLIST_FILE}" 2>/dev/null
fi

exec python3 "${HERE}/stage-fingerprint.py" \
  --gop "${GOP}" \
  --conf "${CONF_FILE}" \
  --playlist "${PLAYLIST_FILE}" \
  --source "${CONTAINER:-${PLAYLIST_FILE}}" \
  --min-segments "${MIN_SEGMENTS}" \
  --tolerance "${TOLERANCE}"
