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
# ## Why it checks that it can afford to finish
#
# On 2026-08-05 a sweep spent seven of its twelve runs before anyone noticed the uploader's chequebook
# had reached exactly zero. That is worse than losing the remaining runs. A bee node that cannot pay
# is refused service by its peers, so the runs on either side of the exhaustion are not comparable,
# and the whole point of interleaving is that rows within one sitting can be read against each other.
#
# So funding is checked twice: once before the first run against the whole sweep, and again before
# every run against that one run. Running out is then a clean stop with a named reason rather than a
# quiet slide into measuring starvation.
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

# Both bee nodes are paid, not only the one that writes: the uploader pays peers to take chunks and
# the gateway pays to pull them back. Measured 2026-08-05 by sampling `/chequebook/balance` every 45s
# through a running sweep, against an idle control that did not move at all across 90 seconds, so the
# burn is the sweep's own and not a background drain. PLUR per minute of publishing, 1 BZZ = 10^16.
UPLOADER_BURN_PLUR_PER_MIN="${UPLOADER_BURN_PLUR_PER_MIN:-325000000000000}"
GATEWAY_BURN_PLUR_PER_MIN="${GATEWAY_BURN_PLUR_PER_MIN:-267000000000000}"

# Headroom over the straight-line estimate. The burn was measured on one mix of picture sizes and a
# heavier one costs more per minute, so a sweep that only just fits is a sweep that stops early.
FUNDS_MARGIN_PERCENT="${FUNDS_MARGIN_PERCENT:-140}"

# origin + slot*10, matching apply_port_slot in _lib.sh, where BEE_UPLOADER_API_PORT has origin 10005
# and BEE_GATEWAY_API_PORT has origin 10007.
UPLOADER_BEE_PORT="${UPLOADER_BEE_PORT:-$((10005 + PORT_SLOT * 10))}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-$((10007 + PORT_SLOT * 10))}"

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
#
# 1080p is deliberately absent. On 2026-08-05 three of its four rows failed the axis guard by
# delivering ~26.5fps against a requested 30: the packet count per segment was always exactly right
# for the GOP while the declared duration ran ~13% long, so the encoder was falling behind real time
# rather than dropping frames. A row that was not delivered at the GOP it asked for cannot be read as
# that GOP, and at 6000kbps it costs 2.4x the bitrate of a 720p row to learn nothing.
#
# The quarter second row is back. It was rejected once, and both instrument defects found since then
# push a fast configuration to look worse: the broken feed reader, and a wrap fold that discarded any
# sample beating the publisher's own 1.39s lead. It can only be judged against rows taken beside it,
# which is what this sweep is for.
#
# `SWEEP_CONFIGS` overrides the grid with a space-separated list in the same form. The point is to
# answer one question with the runs it needs rather than the whole screen: a focused pair still gets
# the interleaving, the reversal, the axis guard and the funding check, and a question that needs two
# configurations should not cost four. Keep a reference row in any override, since a row read against
# nothing taken beside it is a number from another sitting.
if [ -n "${SWEEP_CONFIGS:-}" ]; then
  read -r -a CONFIGS <<< "${SWEEP_CONFIGS}"
else
  CONFIGS=(
    "ref-720-2.0:1280x720:2500:2.0"
    "720-0.25:1280x720:2500:0.25"
    "720-0.5:1280x720:2500:0.5"
    "720-1.0:1280x720:2500:1.0"
  )
fi

say() {
  echo "[$(date -u +%H:%M:%S)] $*" >> "${LOG}"
}

# PLUR to BZZ at three decimals, because bash has no floats and a raw 16-digit integer is unreadable
# in a log someone is skimming to find out why their sweep stopped.
bzz() {
  printf '%d.%03d' "$(($1 / 10000000000000000))" "$((($1 % 10000000000000000) / 10000000000000))"
}

# Prints the node's spendable chequebook balance in PLUR, or nothing at all if it cannot be read.
#
# Empty is meaningfully different from zero. A node running with swap disabled has no chequebook and
# answers 405, which is a deployment shape rather than a shortfall, so the caller decides what to do
# about it rather than this reporting a confident 0.
#
# `availableBalance` is total minus cheques already issued, and it is NOT restored when a peer cashes
# one. Only a deposit raises it, so waiting for it to recover never works.
chequebook_available_plur() {
  curl -s --max-time 10 "http://127.0.0.1:${1}/chequebook/balance" 2>/dev/null |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["availableBalance"])' 2>/dev/null
}

# Zero when both nodes can pay for the given minutes of publishing, non-zero otherwise. Reports every
# node rather than stopping at the first shortfall, because the two are funded separately and an
# operator about to go on chain wants both numbers in one message.
funds_cover_minutes() {
  local minutes="$1" label="$2"
  local short=0
  local port rate who need have
  for spec in "${UPLOADER_BEE_PORT}:${UPLOADER_BURN_PLUR_PER_MIN}:uploader" \
    "${GATEWAY_BEE_PORT}:${GATEWAY_BURN_PLUR_PER_MIN}:gateway"; do
    IFS=: read -r port rate who <<< "${spec}"
    # Dividing before applying the margin keeps a long sweep clear of the 64-bit ceiling: at 600
    # minutes the other order reaches 2.7e19 and wraps. The truncation it costs is under 14000 PLUR
    # against a threshold around 1.6e16, so it is twelve orders of magnitude below anything decidable.
    # shellcheck disable=SC2017
    need=$((rate * minutes / 100 * FUNDS_MARGIN_PERCENT))
    have="$(chequebook_available_plur "${port}")"
    if [ -z "${have}" ]; then
      say "  ${label}: ${who} chequebook on ${port} did not answer, so funding is unknown"
      short=1
    elif [ "${have}" -lt "${need}" ]; then
      say "  ${label}: ${who} has $(bzz "${have}") BZZ, needs $(bzz "${need}") for ${minutes} min SHORT"
      short=1
    else
      say "  ${label}: ${who} has $(bzz "${have}") BZZ, needs $(bzz "${need}") for ${minutes} min, ok"
    fi
  done
  return ${short}
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
    local newest="" candidate
    for candidate in "${REPO_DIR}"/docs/bench/longrun-*.json; do
      [ -e "${candidate}" ] || continue
      if [ -z "${newest}" ] || [ "${candidate}" -nt "${newest}" ]; then
        newest="${candidate}"
      fi
    done
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

TOTAL_MINUTES=$((${#CONFIGS[@]} * ROUNDS * MINUTES))
if [ "${SKIP_FUNDS_CHECK:-0}" = "1" ]; then
  say "funding check skipped by SKIP_FUNDS_CHECK, so this sweep may stop partway"
else
  say "checking both chequebooks cover ${TOTAL_MINUTES} min of publishing at a ${FUNDS_MARGIN_PERCENT}% margin"
  if ! funds_cover_minutes "${TOTAL_MINUTES}" "preflight"; then
    say "REFUSING TO START: this sweep cannot pay for itself, and a sweep that stops partway"
    say "  produces rows measured on a node its peers have stopped serving. Deposit into the short"
    say "  node's chequebook, or lower ROUNDS, MINUTES or the config count, then start again."
    exit 1
  fi
fi

# Answering "can I afford this?" should not require starting it, since the answer decides whether an
# operator goes on chain first. Exit code is the answer, and the log holds the per-node figures.
if [ "${PREFLIGHT_ONLY:-0}" = "1" ]; then
  say "PREFLIGHT_ONLY, so stopping here without publishing anything"
  exit 0
fi

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

    # Re-checked per run rather than trusted from the preflight, because the estimate is a straight
    # line through a rate measured once and the real cost varies with what is being published.
    if [ "${SKIP_FUNDS_CHECK:-0}" != "1" ] && ! funds_cover_minutes "${MINUTES}" "before ${name}"; then
      say "STOPPING after $(wc -l < "${STATE}") runs: cannot pay for the next one."
      printf '%s\t%s\t%s\t%s\t%s\t%ss\t%s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${round}" "${name}" "${size}" "${kbps}" "${gop}" \
        "NOT-RUN(funds exhausted)" >> "${STATE}"
      break 2
    fi

    run_one "${name}" "${size}" "${kbps}" "${gop}" "${round}"
  done
done

say "sweep done: $(grep -c "axis ok" "${STATE}") axis-ok, $(grep -cE "AXIS FAIL|READER BEHIND|RUN-FAILED|NO-REPORT" "${STATE}") bad, $(grep -c "UNREADABLE-HIGH" "${STATE}") with high unreadable share"
