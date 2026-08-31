#!/usr/bin/env bash
#
# Run a bench on the deployment host instead of on a workstation.
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
#                                   [--script bench:latency]
#
# `--setup-only` syncs, builds and installs, then stops without running anything. That is the state a
# viewer arm of the e2e suite needs, since it mounts this checkout into the browser container.
#
# Anything after `--` is passed to the container as environment, so a knob sweep reads:
#   deploy/scripts/bench-on-host.sh -- BENCH_GOP_SECONDS=4 BENCH_BITRATE_KBPS=1200
#
# `--script` chooses which bench runs, so `bench:longrun` reuses the sync, the image and the container
# arguments rather than copying them into a second script that could drift from this one.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

PROFILE="latbench"
PORT_SLOT="7"
TARGET="manager-host"
# Kept apart from the rsynced deploy payload, which `deploy.sh` owns and overwrites.
REMOTE_DIR="~/swarm-hls-bench"

# `--image` and `--dockerfile` exist so the browser validation runs through this script rather than
# beside it. Everything here other than which image is built — the sync, the frozen install, host
# networking, running as the invoking user, the ssh keepalives a long run needs — is the same problem
# for a browser as for a bench, and a second copy of it would be a second thing to keep true.
IMAGE="swarm-hls-bench"
DOCKERFILE="e2e/Dockerfile.bench"

# Syncing, building and installing are idempotent but not free, and a sweep repeats one setting many
# times over an unchanged tree. `--no-setup` skips all three for the repeat runs.
SETUP=1

# `--setup-only` does the three and stops.
#
# ⛔⛔⛔ Added 2026-08-31 because there was no way to bring the host's checkout up to date without
# running a bench, and the e2e suite needs it current for a reason that has nothing to do with a
# bench: a viewer arm bind-mounts this same directory into the browser container as /repo and runs
# the harness FROM it. The suite itself runs on the workstation, so nothing in its path syncs
# anything. The checkout was found three days stale under a sitting about to be paid for, which is
# the harness-side version of the fifteen-day-stale client that every browser sitting played.
SETUP_ONLY=0
SCRIPT="bench:latency"

# A long run holds one ssh session open for the whole broadcast with nothing crossing it, which is
# exactly the shape a firewall or a NAT table drops. Without these a thirty-minute run can lose its
# connection at the twenty-ninth minute and take the report with it, after the postage is spent.
SSH_OPTS=(-o ServerAliveInterval=30 -o ServerAliveCountMax=20)

BENCH_ENV=()
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --portSlot) PORT_SLOT="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --script) SCRIPT="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --dockerfile) DOCKERFILE="$2"; shift 2 ;;
    --no-setup) SETUP=0; shift ;;
    --setup-only) SETUP_ONLY=1; shift ;;
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
#
# `--shm-size` is for the browser image: Chrome puts its renderer's shared buffers in /dev/shm and
# docker's 64MB default makes it crash partway through a video session rather than at startup, which
# reads as the stream failing. Costs the bench nothing, since shared memory is charged on use.
DOCKER_RUN="docker run --rm --network host \
  -u \$(id -u):\$(id -g) \
  --group-add \$(getent group docker | cut -d: -f3) \
  --shm-size=2g \
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
ssh "${SSH_OPTS[@]}" "${TARGET}" "cd ${REMOTE_DIR} && docker build -q -f ${DOCKERFILE} -t ${IMAGE} e2e/"

echo "bench-on-host: installing dependencies in the container"
ssh "${SSH_OPTS[@]}" "${TARGET}" "cd ${REMOTE_DIR} && ${DOCKER_RUN} ${IMAGE} pnpm install --frozen-lockfile"
fi

if [ "${SETUP_ONLY}" -eq 1 ]; then
  if [ "${SETUP}" -eq 0 ]; then
    echo "bench-on-host: --setup-only with --no-setup does nothing at all, so neither was meant." >&2
    exit 2
  fi
  echo "bench-on-host: --setup-only, ${TARGET}:${REMOTE_DIR} is current and nothing was run"
  exit 0
fi

# `local` is the sentinel that makes the harness shell out instead of ssh, which the host cannot do to
# itself. `127.0.0.1` is what the publisher dials and what the viewer gateway is fetched on.
RUN_ENV="-e E2E_SSH_TARGET=local -e E2E_PUBLIC_HOST=127.0.0.1 -e E2E_PROFILE=${PROFILE} -e E2E_PORT_SLOT=${PORT_SLOT}"
for pair in ${BENCH_ENV[@]+"${BENCH_ENV[@]}"}; do
  RUN_ENV="${RUN_ENV} -e ${pair}"
done

echo "bench-on-host: running ${SCRIPT} on ${TARGET} (profile ${PROFILE}, slot ${PORT_SLOT})"
ssh "${SSH_OPTS[@]}" "${TARGET}" "cd ${REMOTE_DIR} && ${DOCKER_RUN} ${RUN_ENV} ${IMAGE} pnpm ${SCRIPT}"

echo "bench-on-host: collecting reports"
mkdir -p "${REPO_ROOT}/docs/bench"
rsync -az "${TARGET}:${REMOTE_DIR}/docs/bench/" "${REPO_ROOT}/docs/bench/"
echo "bench-on-host: done"
