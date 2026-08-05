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
# ## Why nothing here redeploys, and the condition that makes that safe
#
# SRS prefers to cut on a keyframe at or after `HLS_FRAGMENT`, but force-closes a segment at
# `HLS_FRAGMENT * HLS_AOF_RATIO` whether a keyframe arrived or not. So the publisher's GOP decides the
# segment only while **`HLS_FRAGMENT <= GOP <= HLS_FRAGMENT * HLS_AOF_RATIO`**, and inside that range
# every configuration below is reachable from the bench container alone, with no compose redeploy and
# therefore no laptop.
#
# Getting that wrong is not hypothetical. On 2026-08-05 a fragment of 0.25 against SRS's default ratio
# of 2.1 force-cut every segment at 0.53s regardless of a GOP swept from 0.5s to 2.0s, and twelve runs
# reported an axis that had never moved. The caller must set the fragment at or below the smallest GOP
# here, the ratio high enough to cover the largest, and confirm the SRT ingest is bound.
#
# ## The guard, which is why that cannot happen twice quietly
#
# Every run is checked against its own request before it counts: measured segment span against the
# requested GOP, packets per segment against what the frame rate implies, and the share of segments
# that could not be read. A run whose axis did not move is recorded as AXIS-FAIL rather than as a row.
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

  # Checked against what it asked for, not merely that it exited zero. A run that swept nothing still
  # exits zero and still writes a report full of plausible numbers.
  local verdict
  if [ ${status} -ne 0 ]; then
    verdict="RUN-FAILED(${status})"
  else
    local newest
    newest="$(ls -t "${REPO_DIR}"/docs/bench/longrun-*.json 2>/dev/null | head -1)"
    if [ -z "${newest}" ]; then
      verdict="NO-REPORT"
    else
      verdict="$(python3 "${REPO_DIR}/e2e/src/probes/check-axis.py" "${newest}" "${gop}" 30 2>&1)"
    fi
  fi
  say "  ${verdict}"

  # A failed run loses that run and nothing else. Every run is a real broadcast paid for with real
  # postage, so aborting the sweep would throw away everything already measured.
  printf '%s\t%s\t%s\t%s\t%s\t%ss\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${round}" "${name}" "${size}" "${kbps}" "${gop}" "${verdict}" >> "${STATE}"
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

say "sweep done: $(grep -c "axis ok" "${STATE}") axis-ok, $(grep -cE "AXIS FAIL|RUN-FAILED|NO-REPORT" "${STATE}") bad, $(grep -c "UNREADABLE-HIGH" "${STATE}") with high unreadable share"
