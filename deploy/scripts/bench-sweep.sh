#!/usr/bin/env bash
#
# Sweep the latency knobs, several runs per setting, and leave one report per run in `docs/bench/`.
#
# ## Why several runs per setting
#
# A single run is not a baseline and the instrument says so itself. The first run on the deployment
# host measured a within-run scatter of 7125ms per minute across samples ranging 3.91s to 5.55s, and
# two runs at identical settings on 2026-08-02 and 2026-08-03 disagreed by 2.29s. Comparing one run
# per setting would rank the noise.
#
# ## Why both knobs move together
#
# SRS can only cut a segment on a keyframe, so the segment a viewer waits for is the first keyframe
# at or after `HLS_FRAGMENT`, not `HLS_FRAGMENT` itself. Measured on the host: a 2s GOP against a 1.5
# fragment gives exactly 2.00s. Lowering the fragment alone therefore changes nothing, and a sweep of
# the publisher knob alone can only ever move the segment upward. The grid pairs them.
#
# ## Cost
#
# One run is about 0.00057 BZZ of chequebook and does not measurably move stamp utilization, measured
# by differencing `/chequebook/balance` across two runs. Wall clock is the real cost, roughly three
# and a half minutes a run.
#
# Usage:
#   deploy/scripts/bench-sweep.sh [--runs 5] [--profile latbench] [--portSlot 7]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

RUNS=5
PROFILE="latbench"
PORT_SLOT="7"

while [ $# -gt 0 ]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --portSlot) PORT_SLOT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ENGINE_ENV="${REPO_ROOT}/engines/srs/.env.${PROFILE}"
[ -f "${ENGINE_ENV}" ] || { echo "no engine env file at ${ENGINE_ENV}" >&2; exit 1; }

# fragment:gop:window. The window is fifteen fragments throughout, which is what the shipped default
# of 22.5 against 1.5 already was, so the playlist holds the same number of segments at every row and
# is not a second variable moving underneath the first.
SETTINGS=(
  "0.5:0.5:7.5"
  "1.0:1.0:15"
  "1.5:2.0:22.5"
  "3.0:2.0:45"
)

# Rewrites only its own lines, so the engine's webhook token is never read, printed or moved.
set_knobs() {
  local fragment="$1" window="$2" latency="$3" tmp
  tmp="$(mktemp)"
  grep -v -E '^(HLS_FRAGMENT|HLS_WINDOW|SRT_LATENCY)=' "${ENGINE_ENV}" > "${tmp}" || true
  # A file whose last line has no terminator would otherwise absorb the first knob onto it, which
  # silently corrupts whatever that line held.
  [ -s "${tmp}" ] && [ "$(tail -c1 "${tmp}" | wc -l)" -eq 0 ] && printf '\n' >> "${tmp}"
  printf 'HLS_FRAGMENT=%s\nHLS_WINDOW=%s\nSRT_LATENCY=%s\n' "${fragment}" "${window}" "${latency}" >> "${tmp}"
  mv "${tmp}" "${ENGINE_ENV}"
}

SWEEP_LOG="${REPO_ROOT}/docs/bench/sweep-$(date -u +%Y%m%dT%H%M%SZ).log"
mkdir -p "${REPO_ROOT}/docs/bench"
echo "bench-sweep: ${#SETTINGS[@]} setting(s), ${RUNS} run(s) each, logging to ${SWEEP_LOG}"

setup_flag=""
for setting in "${SETTINGS[@]}"; do
  IFS=: read -r fragment gop window <<< "${setting}"

  echo "=== fragment=${fragment} gop=${gop} window=${window} ===" | tee -a "${SWEEP_LOG}"
  set_knobs "${fragment}" "${window}" "${SRT_LATENCY:-200}"

  # Only `srs` is deployed, so the uploader, the bee nodes and the client are never recreated and no
  # other profile on the host is touched.
  "${REPO_ROOT}/deploy/scripts/deploy.sh" --profile="${PROFILE}" --portSlot="${PORT_SLOT}" srs \
    >> "${SWEEP_LOG}" 2>&1

  for run in $(seq 1 "${RUNS}"); do
    echo "--- fragment=${fragment} gop=${gop} run ${run}/${RUNS} ---" | tee -a "${SWEEP_LOG}"
    # A failed run loses that run and nothing else. Each one is a real broadcast, so aborting the
    # sweep would throw away every setting already measured.
    if ! "${REPO_ROOT}/deploy/scripts/bench-on-host.sh" \
      --profile "${PROFILE}" --portSlot "${PORT_SLOT}" ${setup_flag} \
      -- "BENCH_GOP_SECONDS=${gop}" >> "${SWEEP_LOG}" 2>&1; then
      echo "    run ${run} FAILED, continuing" | tee -a "${SWEEP_LOG}"
    fi
    # Everything is synced, built and installed after the first run of the sweep.
    setup_flag="--no-setup"
  done
done

echo "bench-sweep: done. Reports in docs/bench/, log at ${SWEEP_LOG}"
