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
# ## The gates in front of the driver
#
# Since 2026-09-04 the driver starts only after the ten preflight gates in `e2e/suites/preflight`
# have passed, `client-shape` and `uploader-log-shape` among them. That is not implemented here:
# `bench-on-host.sh` reads the script's own definition at launch and puts them in front of every
# script that does not run them first itself, the `browser:*` drivers and the benches among them,
# so a sitting launched any other way through it is gated too. A refusal opens no browser and exits
# non-zero, and it names the stage fault rather than leaving it to be read out of a viewer's numbers.
# There is no flag to switch it off. See that script's header for the two sittings it cost.
#
# Usage, against a broadcast that is already running:
#   deploy/scripts/browser-on-host.sh
#   deploy/scripts/browser-on-host.sh -- BROWSER_WATCH_SECONDS=300
#
# Anything after `--` is passed to the container as environment, exactly as `bench-on-host.sh` does.
#
# `--own-network` and `--shape-kbps <n>` are forwarded, and either moves the client from loopback to
# `host.docker.internal` along with every other address the container dials. See `bench-on-host.sh`
# for what they are for. Arm 2 of the throttle probe, which repeats it over a real shaped link
# instead of Chrome's emulation:
#   deploy/scripts/browser-on-host.sh --own-network --shape-kbps 2800 \
#     --script browser:in-tab-throttle-probe -- PROBE_CAP_MODE=external PROBE_CAP_KBPS=2800
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Named apart from `_lib.sh`'s own PROFILE and PORT_SLOT, which sourcing it resets. Reading them
# back after the source produced `--portSlot=0`, which silently means "keep the env file's ports",
# and the run went looking for the client on the unshifted default port instead of this profile's.
WANT_PROFILE="latbench"
WANT_PORT_SLOT="7"
TARGET="manager-host"
PASSTHROUGH=()
FORWARDED=()
# `browser:selfcheck` answers whether the browser is a usable instrument and needs no broadcast, so
# it is the cheap first call whenever anything about the image or the host has changed.
SCRIPT="browser:watch"

# Where the client is, from inside the container. Loopback while the container shares the host's
# network namespace, which is every run that does not ask for one of its own.
CLIENT_HOST="127.0.0.1"

while [ $# -gt 0 ]; do
  case "$1" in
    --script) SCRIPT="$2"; shift 2 ;;
    --profile) WANT_PROFILE="$2"; FORWARDED+=(--profile "$2"); shift 2 ;;
    --portSlot) WANT_PORT_SLOT="$2"; FORWARDED+=(--portSlot "$2"); shift 2 ;;
    --target) TARGET="$2"; FORWARDED+=(--target "$2"); shift 2 ;;
    --no-setup) FORWARDED+=(--no-setup); shift ;;
    --own-network) CLIENT_HOST="host.docker.internal"; FORWARDED+=(--own-network); shift ;;
    # Implies --own-network on the far side, so the client has to move with it here too.
    --shape-kbps) CLIENT_HOST="host.docker.internal"; FORWARDED+=(--shape-kbps "$2"); shift 2 ;;
    --) shift; PASSTHROUGH=("$@"); break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

parse_profile_args "--profile=${WANT_PROFILE}" "--portSlot=${WANT_PORT_SLOT}"
load_env
apply_port_slot

CLIENT_PORT="${CLIENT_PORT:?CLIENT_PORT is unset after apply_port_slot}"

# Reached over loopback from inside the host-networked container, which is the same origin a viewer
# on this machine would use and keeps the operator's uplink out of the reading. With `--own-network`
# the container's loopback holds nothing, so the client is one hop away on the docker bridge and the
# reading gains that hop. That is the price of shaping this container's link without shaping every
# bee node and co-tenant on the machine.
echo "browser-on-host: client at ${CLIENT_HOST}:${CLIENT_PORT} on ${TARGET}"

exec "${REPO_ROOT}/deploy/scripts/bench-on-host.sh" \
  ${FORWARDED[@]+"${FORWARDED[@]}"} \
  --image swarm-hls-browser \
  --dockerfile e2e/Dockerfile.browser \
  --script "${SCRIPT}" \
  -- "BROWSER_CLIENT_URL=http://${CLIENT_HOST}:${CLIENT_PORT}" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
