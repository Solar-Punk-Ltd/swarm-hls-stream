#!/usr/bin/env bash
#
# Watch a live broadcast in a real browser, on the deployment host, and report what the viewer got.
#
# ## Why on the host, and why a browser at all
#
# Everything this project has measured stops at capture-to-fetchable: the instant a segment could
# first be pulled from the gateway. A viewer watches neither the fetchable edge nor the gateway, they
# watch whatever their player chose to play, which sits a further `LIVE_SYNC_DURATION_S` behind. That
# constant was derived from arrival times, and derived is all it has ever been.
#
# On the host for the same reason the bench is: from a workstation, the operator's uplink lands
# inside the measurement, and it cost 39% of one reading on 2026-08-03.
#
# ## What makes this different from every earlier attempt
#
# The browser is headed against an Xvfb display, so the page is genuinely foregrounded. The previous
# attempt ran in a pane that reported `visibilityState: hidden` permanently, and Chromium answers a
# hidden page by pausing muted video and throttling timers to about one a minute once playback
# stalls. hls.js loads fragments off those timers, so the first stall guaranteed the next and the
# player ended up 578 seconds behind live. That was the harness, and nothing in the number said so.
#
# The run now checks its own instrument on every sample and reports VOID rather than a figure when
# the browser was degrading what it measured. See `e2e/src/browser/instrument.ts`.
#
# Usage, against a broadcast that is already running:
#   deploy/scripts/browser-on-host.sh
#   deploy/scripts/browser-on-host.sh -- BROWSER_WATCH_SECONDS=300
#
# Anything after `--` is passed to the container as environment, exactly as `bench-on-host.sh` does.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

PROFILE="latbench"
PORT_SLOT="7"
TARGET="manager-host"
PASSTHROUGH=()
FORWARDED=()

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; FORWARDED+=(--profile "$2"); shift 2 ;;
    --portSlot) PORT_SLOT="$2"; FORWARDED+=(--portSlot "$2"); shift 2 ;;
    --target) TARGET="$2"; FORWARDED+=(--target "$2"); shift 2 ;;
    --no-setup) FORWARDED+=(--no-setup); shift ;;
    --) shift; PASSTHROUGH=("$@"); break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

parse_profile_args "--profile=${PROFILE}" "--portSlot=${PORT_SLOT}"
load_env
apply_port_slot

CLIENT_PORT="${CLIENT_PORT:?CLIENT_PORT is unset after apply_port_slot}"

# Reached over loopback from inside the host-networked container, which is the same origin a viewer
# on this machine would use and keeps the operator's uplink out of the reading.
echo "browser-on-host: client at 127.0.0.1:${CLIENT_PORT} on ${TARGET}"

exec "${REPO_ROOT}/deploy/scripts/bench-on-host.sh" \
  ${FORWARDED[@]+"${FORWARDED[@]}"} \
  --image swarm-hls-browser \
  --dockerfile e2e/Dockerfile.browser \
  --script browser:watch \
  -- "BROWSER_CLIENT_URL=http://127.0.0.1:${CLIENT_PORT}" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
