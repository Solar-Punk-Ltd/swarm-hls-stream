#!/usr/bin/env bash
#
# Run `pnpm bench:latency` on the deployment host instead of on a workstation.
#
# The bench publishes and fetches from one machine, deliberately, because that is what keeps the
# capture instant and the fetch instant on a single clock and keeps clock skew out of the total.
# The cost is that whatever network sits between the operator and the deployment lands inside the
# measurement. Measured on 2026-08-03 from a laptop: about 15% of SRT packets lost, segments arriving
# with 14 to 24 video frames where the local self-check produces 60, and a `segment` hop of 2.83s to
# 3.13s against a 2s GOP because SRS cannot cut on a damaged keyframe. That was over a third of the
# reported total, and none of it was the product.
#
# So the bench runs here, over loopback. Nothing is installed on the host: the source is synced and
# the run happens inside the image built from `e2e/Dockerfile.bench`.
#
# Usage:
#   deploy/scripts/bench-on-host.sh [--profile latbench] [--portSlot 7] [--target manager-host]
#
# Anything after `--` is passed to the container as environment, so a knob sweep reads:
#   deploy/scripts/bench-on-host.sh -- BENCH_GOP_SECONDS=4 BENCH_BITRATE_KBPS=1200
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

PROFILE="latbench"
PORT_SLOT="7"
TARGET="manager-host"
# Kept apart from the rsynced deploy payload, which `deploy.sh` owns and overwrites.
REMOTE_DIR="~/swarm-hls-bench"
IMAGE="swarm-hls-bench"

# Syncing, building and installing are idempotent but not free, and a sweep repeats one setting many
# times over an unchanged tree. `--no-setup` skips all three for the repeat runs.
SETUP=1

BENCH_ENV=()
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --portSlot) PORT_SLOT="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --no-setup) SETUP=0; shift ;;
    --) shift; BENCH_ENV=("$@"); break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Runs as the invoking user so the installed tree and the written reports do not come back owned by
# root, and joins the host network so the publisher and the gateway are both reached over loopback.
#
# `--group-add` carries the host's docker group in as a supplementary group. Without it the socket is
# mounted but unreadable, because dropping to the invoking user also drops the group that owns it,
# and the run fails at the first log read after the self-check has already published.
DOCKER_RUN="docker run --rm --network host \
  -u \$(id -u):\$(id -g) \
  --group-add \$(getent group docker | cut -d: -f3) \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v ${REMOTE_DIR}:/repo \
  -e HOME=/tmp \
  -w /repo"

if [ "${SETUP}" -eq 1 ]; then
echo "bench-on-host: syncing source to ${TARGET}:${REMOTE_DIR}"
# `node_modules` is excluded because the container installs into the bind mount and the two trees are
# built for different platforms. `.git` is excluded because nothing here reads history.
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'reports' \
  --exclude 'docs/bench' \
  "${REPO_ROOT}/" "${TARGET}:${REMOTE_DIR}/"

echo "bench-on-host: building ${IMAGE} on ${TARGET}"
ssh "${TARGET}" "cd ${REMOTE_DIR} && docker build -q -f e2e/Dockerfile.bench -t ${IMAGE} e2e/"

echo "bench-on-host: installing dependencies in the container"
ssh "${TARGET}" "cd ${REMOTE_DIR} && ${DOCKER_RUN} ${IMAGE} pnpm install --frozen-lockfile"
fi

# `local` is the sentinel that makes the harness shell out instead of ssh, which the host cannot do to
# itself. `127.0.0.1` is what the publisher dials and what the viewer gateway is fetched on.
RUN_ENV="-e E2E_SSH_TARGET=local -e E2E_PUBLIC_HOST=127.0.0.1 -e E2E_PROFILE=${PROFILE} -e E2E_PORT_SLOT=${PORT_SLOT}"
for pair in ${BENCH_ENV[@]+"${BENCH_ENV[@]}"}; do
  RUN_ENV="${RUN_ENV} -e ${pair}"
done

echo "bench-on-host: running the bench on ${TARGET} (profile ${PROFILE}, slot ${PORT_SLOT})"
ssh "${TARGET}" "cd ${REMOTE_DIR} && ${DOCKER_RUN} ${RUN_ENV} ${IMAGE} pnpm bench:latency"

echo "bench-on-host: collecting reports"
mkdir -p "${REPO_ROOT}/docs/bench"
rsync -az "${TARGET}:${REMOTE_DIR}/docs/bench/" "${REPO_ROOT}/docs/bench/"
echo "bench-on-host: done"
