#!/usr/bin/env bash
#
# What sets a gateway-less viewer's main-thread cost: how long the timeline is, or where in it the
# playhead sits. Measured against recordings that already exist on Swarm.
#
# ## ⭐⭐⭐ WHY THIS COSTS NOTHING
#
# The 2026-08-16 gateway-less sitting found the native viewer's thread cost rising 0.435 to 0.746
# with the broadcast's age at join, and `gateway-less-live-2026-08-16.md` then withdrew the mechanism
# it offered, because within an arm the cost does not move at all. What sets the level at join was
# left open, and the obvious next move looked like a longer broadcast.
#
# It is not. The question is about what the player LANDS ON, not about fresh content:
#
#   - the segments are already on Swarm, paid for by sittings that have already run
#   - there is no publisher, no encoder and no upload, so **no postage at all**
#   - weeb-3's own page asks a gateway for nothing, so no node spends anything either
#
# Three recordings share one profile, verified per arm from their own artefacts as 1280x720 with
# 0.5s segments of 0.172 to 0.174 MB, and carry timelines of **62, 100 and 190 minutes**. That is a
# wider range than the 88 minutes the postage left on the batch could have bought, for no BZZ.
#
# ⚠️ Read the timeline off `seekableEnd`, not off the sitting log that produced the recording. The
# log names the broadcast the sitting PLANNED, which is longer than what the publisher actually left
# behind: 125 planned against 100 recorded on one of these.
# See [[cheap-measurement-method]].
#
# ## The two factors, and which one is the clean one
#
# ⭐ **Playhead position inside ONE recording** is the contrast this exists for. Timeline length,
# content, encoder, profile and network are all held fixed and only `WEEB3_NATIVE_START_S` moves. If
# the cost tracks total timeline length it is flat across those arms; if it tracks how much sits
# ahead of the playhead, it is not.
#
# ⚠️ **Across recordings** the timeline length moves but so does the content and the day it was
# published, and content health is known to move with age (`swarm-hls-content-decay`). It is a second
# line of evidence and it is weaker, and a write-up has to say which of the two carried it.
#
# ## ⛔ What this cannot say
#
# A recording is not a live edge. There is no rebase here and no publisher racing the player, so this
# does not reproduce Result 2 and must never be quoted as a live-edge figure. `#108` published both a
# steady and a whole-window realtime ratio for the same reason.
#
# Usage, on the deployment host:
#   ARM_PLAN="len125-at0:be608ecf-…:0 len195-at0:05abe325-…:0" \
#     bash deploy/scripts/recording-timeline-arms.sh
set -u

BENCH_REPO="${BENCH_REPO:-/home/solarpunk/swarm-hls-bench}"
OWNER="${OWNER:-8d8a30ff4cbcf8ad0e0773547686295f8157feb0}"

# `label:topic:start_seconds`, space separated. Labels carry into the state file and the artefact
# names, so they are what a write-up joins on.
ARM_PLAN="${ARM_PLAN:?recording-timeline-arms.sh needs ARM_PLAN=\"label:topic:start_s …\"}"
WATCH_S="${WATCH_S:-240}"
BOOT_S="${BOOT_S:-180}"
ARM_GAP_S="${ARM_GAP_S:-20}"

BROWSER_IMAGE="${BROWSER_IMAGE:-swarm-hls-browser:latest}"
CONTAINER="${CONTAINER:-recording-timeline-browser}"
SAMPLER="${SAMPLER:-recording-timeline-mainthread}"
# ⛔ The page is chosen by URL substring and `main-thread.mjs` refuses an empty one, which is how a
# proof arm on 2026-08-16 collected zero samples while the arm itself succeeded. weeb-3's own page is
# served from their GitHub Pages deployment, so this is what identifies it among the open targets.
THREAD_URL="${THREAD_URL:-lat-murmeldjur}"
VIEWER_CDP_PORT="${VIEWER_CDP_PORT:-9223}"
MAIN_THREAD_INTERVAL_S="${MAIN_THREAD_INTERVAL_S:-5}"

# ⛔⛔ The box carries roughly forty other bee nodes and eight unrelated stacks, and "existing
# resources must not be touched" covers starving them. Checked between arms rather than during, so a
# stop leaves whole arms rather than half of one.
LOAD_CEILING="${LOAD_CEILING:-32}"

OUT_DIR="${OUT_DIR:-/home/solarpunk/recording-timeline/$(date -u +%Y%m%d-%H%M%S)}"
LOG="${OUT_DIR}/recording-timeline.log"
STATE="${OUT_DIR}/recording-timeline-state.tsv"
METRICS_DIR="${OUT_DIR}/node-metrics"
mkdir -p "${METRICS_DIR}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >> "${LOG}"; }

# ⛔⛔⛔ NOT A READBACK. The browser's own request log already gates every arm by host, and that gate
# was honest on a 2026-08-13 smoke where both arms fetched everything from one node. The gateway's own
# counters are the independent instrument, and a gateway-less claim needs both.
snapshot_gateway() {
  bash "${HERE}/node-metrics.sh" snapshot "$1" "$2" >> "${LOG}" 2>&1 || \
    say "  ⚠️ gateway snapshot ${2} did not complete, so this arm has no node-side evidence"
}

host_load() { awk '{print $1}' /proc/loadavg; }

cleanup() {
  docker rm -f "${CONTAINER}" "${SAMPLER}" > /dev/null 2>&1 || true
}
trap cleanup EXIT

say "recording-timeline-arms starting"
say "  owner ${OWNER}, watch ${WATCH_S}s, boot ${BOOT_S}s, thread port ${VIEWER_CDP_PORT}"
say "  ⭐ NO PUBLISHER, NO POSTAGE, NO SPEND: every arm reads content that already exists"
# ⛔ The sweep's own start, written rather than left to be inferred. A reader that took it from the
# file's timestamp read the time of the LAST append, and a margin loose enough to be safe around that
# also swept in a proof arm from fourteen minutes earlier.
printf '# started %s\n' "$(date -u +%FT%TZ)" > "${STATE}"
printf 'finished_at\tarm\tlabel\ttopic\tstart_s\tload_before\tstatus\n' >> "${STATE}"

index=0
for entry in ${ARM_PLAN}; do
  index=$((index + 1))
  label="${entry%%:*}"
  rest="${entry#*:}"
  topic="${rest%%:*}"
  start_s="${rest##*:}"
  slug="$(printf 'arm%02d-%s' "${index}" "${label}")"

  load="$(host_load)"
  if awk -v l="${load}" -v c="${LOAD_CEILING}" 'BEGIN{exit !(l > c)}'; then
    say "STOPPING before arm ${index}: host load ${load} is over the ${LOAD_CEILING} ceiling"
    printf '%s\t%d\t%s\t%s\t%s\t%s\tstopped-load\n' \
      "$(date -u +%FT%TZ)" "${index}" "${label}" "${topic}" "${start_s}" "${load}" >> "${STATE}"
    break
  fi

  say "arm ${index} ${label}: topic ${topic}, playhead at ${start_s}s, load ${load}"
  snapshot_gateway "${METRICS_DIR}/${slug}-before.json" "${slug}-before"

  docker rm -f "${CONTAINER}" "${SAMPLER}" > /dev/null 2>&1 || true
  thread_out="${METRICS_DIR}/${slug}-mainthread.jsonl"
  : > "${thread_out}"
  # ⛔ Deliberately NOT --rm. A sampler that refuses exits at once, and --rm would delete the
  # container and the reason with it.
  # ⛔⛔ `--entrypoint node` skips the image's Xvfb, which cannot bind a display the arm's browser is
  # already using when both share the host network namespace.
  docker run -d --network host --name "${SAMPLER}" \
    -u "$(id -u):$(id -g)" \
    -v "${BENCH_REPO}:/repo" -v "${METRICS_DIR}:/out" \
    -e HOME=/tmp -w /repo --entrypoint node "${BROWSER_IMAGE}" \
    deploy/scripts/main-thread.mjs "${VIEWER_CDP_PORT}" "${THREAD_URL}" \
    "/out/$(basename "${thread_out}")" "${MAIN_THREAD_INTERVAL_S}" \
    "/out/$(basename "${thread_out}").stop" >> "${LOG}" 2>&1 || \
    say "  ⛔ NO SATURATION READING for ${slug}: the sampler container would not start"

  status=ok
  docker run --rm --network host --name "${CONTAINER}" \
    -u "$(id -u):$(id -g)" \
    -v "${BENCH_REPO}:/repo" \
    -e HOME=/tmp -w /repo \
    -e "WEEB3_NATIVE_OWNER=${OWNER}" \
    -e "WEEB3_NATIVE_TOPIC=${topic}" \
    -e "WEEB3_NATIVE_START_S=${start_s}" \
    -e "WEEB3_NATIVE_WATCH_S=${WATCH_S}" \
    -e "WEEB3_NATIVE_BOOT_S=${BOOT_S}" \
    -e "WEEB3_NATIVE_METRICS_BRACKETED_BY=recording-timeline-arms" \
    -e "VIEWER_CDP_PORT=${VIEWER_CDP_PORT}" \
    "${BROWSER_IMAGE}" pnpm browser:weeb3-native >> "${LOG}" 2>&1 || status=failed

  touch "${thread_out}.stop"
  sleep 8
  docker rm -f "${SAMPLER}" > /dev/null 2>&1 || true
  snapshot_gateway "${METRICS_DIR}/${slug}-after.json" "${slug}-after"

  samples="$(grep -c Timestamp "${thread_out}" 2>/dev/null || echo 0)"
  say "  arm ${index} ${label}: ${status}, ${samples} thread samples, load now $(host_load)"
  printf '%s\t%d\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%FT%TZ)" "${index}" "${label}" "${topic}" "${start_s}" "${load}" "${status}" >> "${STATE}"

  sleep "${ARM_GAP_S}"
done

say "recording-timeline-arms done, $(( index )) arms attempted"
say "  read the thread column with deploy/scripts/main-thread-slope.py ${METRICS_DIR}"
