#!/usr/bin/env bash
#
# The three things an arm-running driver does that are not the arm: ask whether a broadcast is still
# up, write a row to the ledger, and run a browser in the bench image.
#
# Sourced, never executed. The caller supplies:
#   UPLOADER_API_PORT  for active_streams
#   STATE              the arm ledger, tab separated, for record
#   BENCH_REPO PROFILE PORT_SLOT CLIENT_PORT   for run_in_browser_image
#
# shellcheck shell=bash

# ⛔ Prints nothing when the uploader does not answer, which is a distinct state from zero streams.
# A caller treating the empty string as 0 would read an unreachable uploader as a finished broadcast.
active_streams() {
  curl -s --max-time 5 "http://127.0.0.1:${UPLOADER_API_PORT}/health" 2>/dev/null |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["activeStreams"])' 2>/dev/null
}

# ⛔ UTC, because these rows get joined against artefacts that are all stamped UTC.
record() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$1" "$2" "$3" "$4" "$5" >>"${STATE}"
}

# ⭐ `-u` to the caller's own uid, so artefacts written into the mounted repo are not left owned by
# root for the next session to trip over.
run_in_browser_image() {
  local name="$1"
  shift
  docker run --rm --network host \
    --name "${name}" \
    -u "$(id -u):$(id -g)" \
    -v "${BENCH_REPO}:/repo" \
    -e HOME=/tmp \
    -w /repo \
    -e E2E_SSH_TARGET=local \
    -e E2E_PUBLIC_HOST=127.0.0.1 \
    -e "E2E_PROFILE=${PROFILE}" \
    -e "E2E_PORT_SLOT=${PORT_SLOT}" \
    -e "BROWSER_CLIENT_URL=http://127.0.0.1:${CLIENT_PORT}" \
    "$@"
}
