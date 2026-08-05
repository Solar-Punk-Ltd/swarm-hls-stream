#!/bin/bash
#
# The screening sweep, run ON the deployment host so it outlives the laptop that started it.
#
# ## Why it interleaves
#
# Measured 2026-08-05: two sittings of one configuration, 720p 2500kbps at a 2.0s GOP, differed by
# **1.05s** while runs within a sitting agreed to 0.1s. It is not the postage batch, which was
# controlled for, and not the publisher, whose `segment` and `upload` hops were identical. Both hops
# that moved were the ones where Swarm delivers to a reader. See `docs/bench/between-session-drift.md`.
#
# That drift is larger than most of what a profile sweep is trying to detect, so a blocked sweep
# (A,A,A then B,B,B) would report it as the difference between A and B and it would look like a
# result. This runs one round of every configuration before repeating any of them, and **reverses the
# order on even rounds**, so position within a round cannot favour a configuration either.
#
# ## Why nothing here redeploys
#
# `HLS_FRAGMENT` is a floor: SRS cuts at the first keyframe at or after it, so whenever the publisher's
# GOP is longer, the GOP decides the segment. Setting the fragment below the shortest GOP in the grid
# once, before this starts, makes every configuration reachable from the bench container alone. That
# removes a compose redeploy per run, and with it the reason this would have needed the laptop.
#
# The caller must have set `HLS_FRAGMENT` at or below the smallest GOP below and confirmed the SRT
# ingest is bound. This script cannot check either without the deploy tooling it deliberately avoids.
#
# Usage, from the repo root on the laptop:
#   scp deploy/scripts/sweep-interleaved.sh manager-host:~/swarm-hls-bench/
#   ssh manager-host 'setsid nohup bash ~/swarm-hls-bench/sweep-interleaved.sh >/dev/null 2>&1 &'
set -u

REPO_DIR="${REPO_DIR:-/home/solarpunk/swarm-hls-bench}"
IMAGE="${IMAGE:-swarm-hls-bench:latest}"
PROFILE="${PROFILE:-latbench}"
PORT_SLOT="${PORT_SLOT:-7}"
ROUNDS="${ROUNDS:-2}"
MINUTES="${MINUTES:-3}"

# Deliberately outside REPO_DIR. That tree is an rsync target with `--delete`, so anything written
# there is removed the next time the laptop syncs, which is exactly when someone would be checking on
# a sweep still running.
OUT_DIR="${OUT_DIR:-/home/solarpunk/sweep-runs}"
LOG="${OUT_DIR}/sweep.log"
# One line per finished run, so progress can be read without parsing the log.
STATE="${OUT_DIR}/sweep-state.tsv"
mkdir -p "${OUT_DIR}"

# name:size:kbps:gop
#
# The first row is the reference and is measured in every round like any other, which is what makes it
# a reference: each row can be read against the one taken beside it rather than against a number from
# another sitting. It is also the configuration with six prior runs behind it, so a round that puts it
# somewhere unfamiliar is saying something about the round.
CONFIGS=(
  "ref-720-2.0:1280x720:2500:2.0"
  "720-0.5:1280x720:2500:0.5"
  "720-1.0:1280x720:2500:1.0"
  "1080-0.5:1920x1080:6000:0.5"
  "1080-1.0:1920x1080:6000:1.0"
  "1080-2.0:1920x1080:6000:2.0"
)

say() {
  echo "[$(date -u +%H:%M:%S)] $*" >> "${LOG}"
}

run_one() {
  local name="$1" size="$2" kbps="$3" gop="$4" round="$5"
  local started
  started="$(date -u +%s)"

  say "round ${round}: ${name} (${size} ${kbps}kbps gop ${gop}) starting"

  docker run --rm --network host \
    -u "$(id -u):$(id -g)" \
    --group-add "$(getent group docker | cut -d: -f3)" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${REPO_DIR}:/repo" \
    -e HOME=/tmp \
    -w /repo \
    -e E2E_SSH_TARGET=local \
    -e E2E_PUBLIC_HOST=127.0.0.1 \
    -e "E2E_PROFILE=${PROFILE}" \
    -e "E2E_PORT_SLOT=${PORT_SLOT}" \
    -e "BENCH_RUN_MINUTES=${MINUTES}" \
    -e "BENCH_SIZE=${size}" \
    -e "BENCH_BITRATE_KBPS=${kbps}" \
    -e "BENCH_GOP_SECONDS=${gop}" \
    -e BENCH_FPS=30 \
    "${IMAGE}" pnpm bench:longrun >> "${LOG}" 2>&1
  local status=$?

  # A failed run loses that run and nothing else. Every run is a real broadcast paid for with real
  # postage, so aborting the sweep would throw away everything already measured.
  printf '%s\t%s\t%s\t%s\t%s\t%ss\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${round}" "${name}" "${size}" "${kbps}" "${gop}" \
    "$([ ${status} -eq 0 ] && echo ok || echo "FAILED(${status})")" >> "${STATE}"
  say "round ${round}: ${name} finished in $(( $(date -u +%s) - started ))s, status ${status}"
}

: > "${LOG}"
: > "${STATE}"
say "sweep starting: ${#CONFIGS[@]} configs x ${ROUNDS} rounds x ${MINUTES} min, interleaved"

for round in $(seq 1 "${ROUNDS}"); do
  # Reversed on even rounds. With a fixed order the first configuration is always measured at the top
  # of a round, so any drift within a round would land on it systematically.
  ordered=()
  if [ $((round % 2)) -eq 0 ]; then
    for ((i = ${#CONFIGS[@]} - 1; i >= 0; i--)); do ordered+=("${CONFIGS[$i]}"); done
  else
    ordered=("${CONFIGS[@]}")
  fi

  for row in "${ordered[@]}"; do
    IFS=: read -r name size kbps gop <<< "${row}"
    run_one "${name}" "${size}" "${kbps}" "${gop}" "${round}"
  done
done

say "sweep done: $(grep -c ok "${STATE}") ok, $(grep -c FAILED "${STATE}") failed"
