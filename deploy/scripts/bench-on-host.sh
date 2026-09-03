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
# ⛔ THIS SYNCS THE HARNESS. IT DOES NOT REDEPLOY THE STACK. The stream-uploader ships as a prebuilt
# `dist/` through `deploy/scripts/deploy.sh`, so a run launched from here measures THIS checkout's
# harness against WHATEVER WAS LAST DEPLOYED. On 2026-09-01 that cost a paid sitting: a log line the
# harness parses was reworded here and not deployed, so two scenarios reported the uploader never
# publishing manifests on a stage that was publishing them throughout. The e2e preflight
# `uploader-log-shape` now refuses that before the first frame, but it only covers the log messages.
# Deploy first whenever the change is in the uploader rather than in the suite.
#
# Anything after `--` is passed to the container as environment, so a knob sweep reads:
#   deploy/scripts/bench-on-host.sh -- BENCH_GOP_SECONDS=4 BENCH_BITRATE_KBPS=1200
#
# `--script` chooses which bench runs, so `bench:longrun` reuses the sync, the image and the container
# arguments rather than copying them into a second script that could drift from this one.
#
# `--own-network` gives the container a network namespace of its own instead of the host's, and
# points every address the harness dials at `host.docker.internal`. Needed by anything that shapes
# its own link: with `--network host` a shaper would throttle the bee nodes, the uploader and every
# co-tenant on the machine, because they are all in the same namespace. Nothing else wants it, since
# sharing the host's namespace is what keeps the operator's uplink out of every reading.
#
# `--shape-kbps <n>` caps the container's DOWNLOAD at n kbit/s over a real `tc` ingress policer, and
# implies `--own-network`. This is the alternative to Chrome's `Network.emulateNetworkConditions`,
# which is what every "slow connection" this project has measured actually was. The shaper refuses
# the whole run unless it can prove the rate it installed against a download from the host, so a
# shaped arm either measures a shaped link or does not start. See
# `deploy/scripts/shape-container-ingress.sh`.
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

# Docker's own name for the host as seen from a bridge network, published into the container with
# `--add-host=…:host-gateway`. Not resolvable by default on Linux, which is why the flag is there.
HOST_GATEWAY_ALIAS="host.docker.internal"

# Off by default, so a run without the flag builds the same container arguments byte for byte.
OWN_NETWORK=0
SHAPE_KBPS=""

# Where the shaper leaves the rate it proved. Sourced by the container command below so the driver
# can label its rows with a measured cap rather than with the number that was asked for.
SHAPE_ENV_FILE="/tmp/swarm-shape-cap.env"

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
    --own-network) OWN_NETWORK=1; shift ;;
    # Implies --own-network rather than asking for both, because a policer in the host's namespace
    # would throttle every bee node and co-tenant on the machine. The shaper checks it again from
    # the inside, since a flag is a statement and the namespace is a fact.
    --shape-kbps) SHAPE_KBPS="$2"; OWN_NETWORK=1; shift 2 ;;
    --) shift; BENCH_ENV=("$@"); break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Screened here as well as in the shaper, because this value is interpolated into a docker command
# carried over ssh, where anything but digits has no business.
if [ -n "${SHAPE_KBPS}" ]; then
  case "${SHAPE_KBPS}" in
    0 | *[!0-9]*)
      echo "--shape-kbps must be a positive whole number of kbit/s and is '${SHAPE_KBPS}'" >&2
      exit 2
      ;;
  esac
fi

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
# ⛔ `--own-network` swaps the host's namespace for one of the container's own, and that is the ONLY
# thing it swaps: the docker socket, the invoking user, the docker group, the shared memory and the
# repo mount are all the same problem either way. What it costs is loopback. Nothing the deployment
# runs is on the container's own loopback any more, so `E2E_LOCAL_HOST_ADDRESS` and
# `E2E_PUBLIC_HOST` both move to the host as docker publishes it, and `browser-on-host.sh` moves
# `BROWSER_CLIENT_URL` with them. An address left behind would name the empty inside of the
# container, which answers nothing at all.
NETWORK_ARGS="--network host"
if [ "${OWN_NETWORK}" -eq 1 ]; then
  NETWORK_ARGS="--add-host=${HOST_GATEWAY_ALIAS}:host-gateway"
fi

# ⚠️ `--cap-add` puts NET_ADMIN in the container's capability sets, and this container runs as the
# invoking user rather than as root, which on some runc versions leaves it permitted but not
# effective. The shaper refuses the run with that named as the cause when `tc` is denied, so the
# arrangement either works or says why it did not, rather than measuring an unshaped link.
if [ -n "${SHAPE_KBPS}" ]; then
  NETWORK_ARGS="${NETWORK_ARGS} --cap-add=NET_ADMIN"
fi

DOCKER_RUN="docker run --rm ${NETWORK_ARGS} \
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
# built for different platforms. `.git` is excluded because nothing here reads history. Agent worktrees
# under `.claude/worktrees` are whole second copies of this tree, so they are excluded too.
rsync -az --delete \
  --exclude '.git' \
  --exclude '.claude/worktrees' \
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
# itself. `127.0.0.1` is what the publisher dials and what the viewer gateway is fetched on, until
# the container has a namespace of its own and neither is on its loopback.
HOST_ADDRESS="127.0.0.1"
if [ "${OWN_NETWORK}" -eq 1 ]; then
  HOST_ADDRESS="${HOST_GATEWAY_ALIAS}"
fi

# The four sources whose content decides what a viewer is served. `deploy.sh` stamps the client image
# with the same four, and `deploy/test/clientBuildStamp.test.js` holds the two lists together.
CLIENT_SOURCE_PATHS=(
  "packages/client"
  "packages/shared"
  "deploy/Dockerfile.client"
  "deploy/client-nginx.conf.template"
)

# ⛔ `.git` is excluded from the rsync above, so the harness cannot answer this for itself once it is
# on the host. Computed here, on the operator's machine, and carried in as the expectation the
# `client-shape` preflight measures the served client's own build stamp against.
#
# Only a resolved object name is passed on. Anything else would be interpolated into a docker command
# carried over ssh, and an unset expectation is refused by the gate rather than guessed at.
git_tree_or_empty() {
  local resolved
  resolved="$(git -C "${REPO_ROOT}" rev-parse "HEAD:$1" 2>/dev/null || true)"
  case "${resolved}" in
    '' | *[!0-9a-f]*) printf '' ;;
    *) printf '%s' "${resolved}" ;;
  esac
}

EXPECT_CLIENT_TREE="$(git_tree_or_empty packages/client)"
EXPECT_SHARED_TREE="$(git_tree_or_empty packages/shared)"
EXPECT_CLIENT_DIRTY=0
if [ -n "$(git -C "${REPO_ROOT}" status --porcelain -- "${CLIENT_SOURCE_PATHS[@]}" 2>/dev/null || true)" ]; then
  EXPECT_CLIENT_DIRTY=1
fi

RUN_ENV="-e E2E_SSH_TARGET=local -e E2E_PUBLIC_HOST=${HOST_ADDRESS} -e E2E_PROFILE=${PROFILE} -e E2E_PORT_SLOT=${PORT_SLOT}"
RUN_ENV="${RUN_ENV} -e E2E_EXPECT_CLIENT_TREE=${EXPECT_CLIENT_TREE}"
RUN_ENV="${RUN_ENV} -e E2E_EXPECT_SHARED_TREE=${EXPECT_SHARED_TREE}"
RUN_ENV="${RUN_ENV} -e E2E_EXPECT_CLIENT_DIRTY=${EXPECT_CLIENT_DIRTY}"
if [ "${OWN_NETWORK}" -eq 1 ]; then
  RUN_ENV="${RUN_ENV} -e E2E_LOCAL_HOST_ADDRESS=${HOST_ADDRESS}"
fi
if [ -n "${SHAPE_KBPS}" ]; then
  RUN_ENV="${RUN_ENV} -e SHAPE_KBPS=${SHAPE_KBPS} -e SHAPE_ENV_FILE=${SHAPE_ENV_FILE}"
fi
# Last wins in docker, so anything after `--` overrides what this script decided.
for pair in ${BENCH_ENV[@]+"${BENCH_ENV[@]}"}; do
  RUN_ENV="${RUN_ENV} -e ${pair}"
done

# ⛔ The shaper runs in the same shell as the script it shapes, and `&&` is what makes it a gate: a
# refusal exits non-zero and the driver never starts, so a shaped arm cannot fall back to measuring
# an unshaped link. Sourcing the file the shaper wrote is what carries the PROVED rate into the
# driver's environment, which is the only cap figure a report may print.
CONTAINER_CMD="pnpm ${SCRIPT}"
if [ -n "${SHAPE_KBPS}" ]; then
  CONTAINER_CMD="bash -c 'deploy/scripts/shape-container-ingress.sh && . ${SHAPE_ENV_FILE} && exec pnpm ${SCRIPT}'"
fi

# The network mode is printed because it decides every address inside the container, and this repo
# has already paid for a run whose report named a setting the container never read.
if [ "${OWN_NETWORK}" -eq 1 ]; then
  echo "bench-on-host: own network namespace, the host is ${HOST_ADDRESS}"
fi
if [ -n "${SHAPE_KBPS}" ]; then
  echo "bench-on-host: shaping inbound at ${SHAPE_KBPS} kbit/s, and refusing the run if it cannot be proved"
fi
echo "bench-on-host: running ${SCRIPT} on ${TARGET} (profile ${PROFILE}, slot ${PORT_SLOT})"
# ⛔ The run's exit code is kept, not obeyed. Under `set -e` a red suite used to end this script here,
# and the reports of exactly the runs that need reading stayed on the host: both proving sittings of
# 2026-09-02 left their V4 artifacts there. Collect first, then exit with the run's own code, so a
# caller chaining on the exit code still sees the red.
set +e
ssh "${SSH_OPTS[@]}" "${TARGET}" "cd ${REMOTE_DIR} && ${DOCKER_RUN} ${RUN_ENV} ${IMAGE} ${CONTAINER_CMD}"
RUN_RC=$?
set -e

echo "bench-on-host: collecting reports (run exited ${RUN_RC})"
mkdir -p "${REPO_ROOT}/docs/bench"
rsync -az "${TARGET}:${REMOTE_DIR}/docs/bench/" "${REPO_ROOT}/docs/bench/"
echo "bench-on-host: done"
exit "${RUN_RC}"
