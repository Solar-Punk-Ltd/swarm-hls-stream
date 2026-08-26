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
#   deploy/scripts/stage-fingerprint.sh --container latbench-srs-1 --gop 0.5 --rungs 4
#
#   --rungs <n>  How many playlists to judge, newest first. One per rung of the ABR ladder the
#                driver configured. Defaults to 1, which is what this did before ABR existed, so an
#                ABR sitting has to ask: without it four rungs go unjudged and a sitting can run on
#                a profile nothing looked at.
#
# Overrides that replace the two container reads and nothing else, for tests and for reading a
# playlist somebody already captured:
#   --conf-file <path>      the SRS config to read hls_fragment and hls_aof_ratio from
#   --playlist-file <path>  the m3u8 to read raw #EXTINF from. Repeatable, one per rung.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CONTAINER=""
GOP=""
CONF_FILE=""
# Where SRS writes its playlists, from `engines/srs/srs.conf.template`: `hls_path ./objs/nginx/html`
# and `hls_m3u8_file [app]/[stream]/index.m3u8`, against the stock image's working directory.
HLS_ROOT="${HLS_ROOT:-/usr/local/srs/objs/nginx/html}"
SRS_CONF="${SRS_CONF:-/usr/local/srs/conf/srs.conf}"
MIN_SEGMENTS="${MIN_SEGMENTS:-6}"
TOLERANCE="${TOLERANCE:-0.10}"

# How many playlists to pull out of the container, newest first.
#
# ⭐ One per rung, and the count comes from the driver because the driver is what configured the
# ladder. A live rung is written every fragment, so the live ones occupy the newest entries of
# `ls -t` and a leftover playlist from a finished broadcast cannot outrank one: asking for exactly
# the rungs that should be live therefore cannot pull in a stale file, and if fewer are live than
# asked for, the stale one that fills the gap is itself the fault worth refusing on.
#
# Defaults to 1, which is what this did before ABR existed. A ladder sitting has to say so.
RUNGS="${RUNGS:-1}"

# Newline-separated, since `sh` has no arrays and a path may contain a space.
PLAYLIST_FILES=""

while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --gop) GOP="$2"; shift 2 ;;
    --conf-file) CONF_FILE="$2"; shift 2 ;;
    --rungs) RUNGS="$2"; shift 2 ;;
    --playlist-file)
      PLAYLIST_FILES="${PLAYLIST_FILES}${PLAYLIST_FILES:+
}$2"
      shift 2
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "${GOP}" ] || { echo "stage-fingerprint: --gop is required" >&2; exit 2; }
if [ -z "${CONTAINER}" ] && { [ -z "${CONF_FILE}" ] || [ -z "${PLAYLIST_FILES}" ]; }; then
  echo "stage-fingerprint: --container is required unless both file overrides are given" >&2
  exit 2
fi
case "${RUNGS}" in
  ''|*[!0-9]*|0) echo "stage-fingerprint: --rungs must be a positive whole number, got '${RUNGS}'" >&2; exit 2 ;;
esac

WORK=""
cleanup() { [ -n "${WORK}" ] && rm -rf "${WORK}"; }
trap cleanup EXIT

if [ -z "${CONF_FILE}" ] || [ -z "${PLAYLIST_FILES}" ]; then
  WORK="$(mktemp -d)"
fi

if [ -z "${CONF_FILE}" ]; then
  CONF_FILE="${WORK}/srs.conf"
  docker exec "${CONTAINER}" sh -c "cat ${SRS_CONF}" > "${CONF_FILE}" 2>/dev/null
fi

# ⭐ The NEWEST playlists under the tree, not paths built from an app and stream name the driver would
# have to be told. The driver's belief about which stream is live is one of the things being checked,
# so deriving the paths from it would let a mismatch pick its own evidence. The file name is kept as
# the local name, because with a ladder it is what identifies the rung in the verdict.
if [ -z "${PLAYLIST_FILES}" ]; then
  REMOTE_PATHS="$(docker exec "${CONTAINER}" sh -c \
    "find ${HLS_ROOT} -name '*.m3u8' -exec ls -t {} + 2>/dev/null | head -${RUNGS}" 2>/dev/null)"

  OLD_IFS="${IFS}"
  IFS='
'
  for remote in ${REMOTE_PATHS}; do
    # `[app]/[stream]/index.m3u8`, so the stream directory is the rung's name and the file never is.
    local_name="$(printf '%s' "${remote}" | awk -F/ '{ print $(NF-1) ".m3u8" }')"
    docker exec "${CONTAINER}" sh -c "cat '${remote}'" > "${WORK}/${local_name}" 2>/dev/null
    PLAYLIST_FILES="${PLAYLIST_FILES}${PLAYLIST_FILES:+
}${WORK}/${local_name}"
  done
  IFS="${OLD_IFS}"

  if [ -z "${PLAYLIST_FILES}" ]; then
    # A missing playlist is not a passing stage. See the note at the top of this file: "I could not
    # find a playlist" and "the playlist says nothing is wrong" must not be the same return value.
    PLAYLIST_FILES="${WORK}/index.m3u8"
    : > "${PLAYLIST_FILES}"
  fi
fi

# Rebuilt as positional parameters so each `--playlist` reaches python as one argument whatever the
# path contains. The parse loop above has already consumed the real ones.
set --
OLD_IFS="${IFS}"
IFS='
'
for playlist in ${PLAYLIST_FILES}; do
  IFS="${OLD_IFS}"
  set -- "$@" --playlist "${playlist}"
  IFS='
'
done
IFS="${OLD_IFS}"

exec python3 "${HERE}/stage-fingerprint.py" \
  --gop "${GOP}" \
  --conf "${CONF_FILE}" \
  "$@" \
  --rungs "${RUNGS}" \
  --source "${CONTAINER:-$(printf '%s' "${PLAYLIST_FILES}" | head -1)}" \
  --min-segments "${MIN_SEGMENTS}" \
  --tolerance "${TOLERANCE}"
