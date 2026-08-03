#!/usr/bin/env bash
#
# Measure named operating profiles, not single knobs.
#
# `bench-sweep.sh` moves the segment duration and holds the picture fixed, which answers "how low can
# the latency go" and nothing about what the stream looks like when it gets there. This one crosses
# the two: each row is a resolution and bitrate together with the segment length that carries it, so
# the output is a set of configurations somebody could actually choose between.
#
# ## The question the quality rows exist to answer
#
# A segment is uploaded to Swarm before anyone can fetch it, so more bits per second of video is more
# bytes on that hop. If latency tracks bitrate, quality and latency trade against each other and a
# deployment has to pick. If it does not, the `upload` hop is dominated by round trips rather than by
# payload, and quality is close to free. Both are plausible from the code and neither is knowable
# without measuring, which is why 1080p appears at three bitrates and two segment lengths.
#
# ## What this cannot measure
#
# `SRT_LATENCY` is held at whatever the engine env already carries. The bench publishes over loopback
# on the deployment host, where nothing is lost, and a retransmission buffer that never absorbs a
# retransmission cannot be told apart from one that is not there. It is a real knob for a real
# broadcaster on a real network and this instrument is the wrong one for it.
#
# Usage:
#   deploy/scripts/bench-profiles.sh [--runs 5] [--profile latbench] [--portSlot 7] [--only NAME]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

RUNS=5
PROFILE="latbench"
PORT_SLOT="7"
ONLY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --portSlot) PORT_SLOT="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ENGINE_ENV="${REPO_ROOT}/engines/srs/.env.${PROFILE}"
[ -f "${ENGINE_ENV}" ] || { echo "no engine env file at ${ENGINE_ENV}" >&2; exit 1; }

# name:size:kbps:fps:gop:fragment:window
#
# The fragment always equals the GOP. SRS cuts on the first keyframe at or after the fragment, so any
# other pairing measures the GOP and reports it as the fragment. The window is fifteen segments
# throughout, so the playlist holds the same count on every row.
#
# 720p at 2500kbps is absent on purpose: `bench-sweep.sh` already measured it at four segment lengths
# over 105 samples, and re-running it here would spend an hour re-deriving the control.
PROFILES=(
  "sd-fast:854x480:1200:30:0.5:0.5:7.5"
  "hd-half:1920x1080:6000:30:0.5:0.5:7.5"
  "hd-one:1920x1080:6000:30:1.0:1.0:15"
  "hd-two:1920x1080:6000:30:2.0:2.0:30"
  "hd-max:1920x1080:9000:30:1.0:1.0:15"
  # The segment axis at 1080p, which the first pass only sampled at 0.5, 1.0 and 2.0. `hd-quarter`
  # and `live-quarter` go below the shortest segment ever measured: at 30fps a quarter-second GOP is
  # a keyframe every 7.5 frames, so this is as much a question about what that costs in picture
  # quality per bit as about latency, and 240 segments a minute is the hardest the uploader has been
  # asked to work.
  "hd-quarter:1920x1080:6000:30:0.25:0.25:3.75"
  "hd-onehalf:1920x1080:6000:30:1.5:1.5:22.5"
  "hd-three:1920x1080:6000:30:3.0:3.0:45"
  "hd-four:1920x1080:6000:30:4.0:4.0:60"
  "live-quarter:1280x720:2500:30:0.25:0.25:3.75"
  # 480p only ever ran at half a second, so nothing says whether the cheap picture follows the same
  # curve as the expensive one or a flatter one.
  "sd-one:854x480:1200:30:1.0:1.0:15"
  "sd-two:854x480:1200:30:2.0:2.0:30"
)

# Rewrites only its own lines, so the engine's webhook token is never read, printed or moved.
set_knobs() {
  local fragment="$1" window="$2" tmp
  tmp="$(mktemp)"
  grep -v -E '^(HLS_FRAGMENT|HLS_WINDOW)=' "${ENGINE_ENV}" > "${tmp}" || true
  # A file whose last line has no terminator would otherwise absorb the first knob onto it, which
  # silently corrupts whatever that line held. It corrupted the webhook token once already.
  [ -s "${tmp}" ] && [ "$(tail -c1 "${tmp}" | wc -l)" -eq 0 ] && printf '\n' >> "${tmp}"
  printf 'HLS_FRAGMENT=%s\nHLS_WINDOW=%s\n' "${fragment}" "${window}" >> "${tmp}"
  mv "${tmp}" "${ENGINE_ENV}"
}

# The engine is left on the last probe setting if the sweep is killed, and the last probe setting is
# nobody's default. Kept as a copy of the file rather than as two remembered numbers, so a knob added
# later is restored without this script being taught about it.
ORIGINAL_ENV="$(mktemp)"
cp "${ENGINE_ENV}" "${ORIGINAL_ENV}"
restore() {
  cp "${ORIGINAL_ENV}" "${ENGINE_ENV}"
  rm -f "${ORIGINAL_ENV}"
  echo "bench-profiles: engine env restored; redeploying srs on the restored settings"
  "${REPO_ROOT}/deploy/scripts/deploy.sh" --profile="${PROFILE}" --portSlot="${PORT_SLOT}" srs \
    >> "${SWEEP_LOG:-/dev/null}" 2>&1 || echo "bench-profiles: restore deploy FAILED, check the stack" >&2
}
trap restore EXIT

SWEEP_LOG="${REPO_ROOT}/docs/bench/profiles-$(date -u +%Y%m%dT%H%M%SZ).log"
mkdir -p "${REPO_ROOT}/docs/bench"
echo "bench-profiles: ${#PROFILES[@]} profile(s), ${RUNS} run(s) each, logging to ${SWEEP_LOG}"

setup_flag=""
for row in "${PROFILES[@]}"; do
  IFS=: read -r name size kbps fps gop fragment window <<< "${row}"
  # Comma-separated, matched whole, so `--only hd-one` never also selects `hd-onehalf`.
  if [ -n "${ONLY}" ] && [[ ",${ONLY}," != *",${name},"* ]]; then
    continue
  fi

  echo "=== ${name}: ${size} ${kbps}kbps ${fps}fps gop=${gop} fragment=${fragment} window=${window} ===" \
    | tee -a "${SWEEP_LOG}"
  set_knobs "${fragment}" "${window}"

  # Only `srs` is deployed, so the uploader, the bee nodes and the client are never recreated and no
  # other profile on the host is touched.
  "${REPO_ROOT}/deploy/scripts/deploy.sh" --profile="${PROFILE}" --portSlot="${PORT_SLOT}" srs \
    >> "${SWEEP_LOG}" 2>&1

  # A recreated container is reported running before its SRT socket is bound, and the first run after
  # a redeploy publishes into nothing and times out. That cost a run of `hd-half` on 2026-08-03, and
  # it is the same gap as OBS-20 seen from the other side.
  if ! "${REPO_ROOT}/deploy/scripts/wait-for-ingest.sh" \
    --profile="${PROFILE}" --portSlot="${PORT_SLOT}" --timeout=90 >> "${SWEEP_LOG}" 2>&1; then
    echo "    ingest never came up for ${name}, skipping the profile" | tee -a "${SWEEP_LOG}"
    continue
  fi

  for run in $(seq 1 "${RUNS}"); do
    echo "--- ${name} run ${run}/${RUNS} ---" | tee -a "${SWEEP_LOG}"
    # A failed run loses that run and nothing else. Each one is a real broadcast, so aborting would
    # throw away every profile already measured.
    if ! "${REPO_ROOT}/deploy/scripts/bench-on-host.sh" \
      --profile "${PROFILE}" --portSlot "${PORT_SLOT}" ${setup_flag} \
      -- "BENCH_GOP_SECONDS=${gop}" "BENCH_SIZE=${size}" "BENCH_BITRATE_KBPS=${kbps}" "BENCH_FPS=${fps}" \
      >> "${SWEEP_LOG}" 2>&1; then
      echo "    run ${run} FAILED, continuing" | tee -a "${SWEEP_LOG}"
    fi
    # Everything is synced, built and installed after the first run of the sweep.
    setup_flag="--no-setup"
  done
done

echo "bench-profiles: done. Reports in docs/bench/, log at ${SWEEP_LOG}"
