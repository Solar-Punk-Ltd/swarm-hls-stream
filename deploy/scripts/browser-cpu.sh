# shellcheck shell=bash
#
# Sourced, never executed, so it carries a shell directive instead of a shebang.
#
# What the browser cost in CPU while an arm ran.
#
# ## ⛔⛔⛔ THIS IS A COST READING AND NOT A SATURATION READING
#
# `docker stats` reports the container's whole cgroup, which is every process the arm started:
# browser, GPU, one renderer per site, the utilities, and the service worker weeb-3 serves HLS
# through. That is the right total for "what does this viewer cost a machine", and it is the reading
# `chrome-cpu.mjs` argues for over a single PID, because sampling the browser process alone reports a
# small, stable, entirely plausible number that is the cost of nothing a viewer does.
#
# ⛔ It CANNOT say whether weeb-3 is out of CPU. The node is one JS thread by construction, so a
# container at 30% of twelve cores can still be a viewer whose single thread is pegged and whose
# retrieval is capped by that rather than by the network. **No figure from `start_browser_cpu` may be
# quoted as a saturation figure.**
#
# ⭐ That second question is answered by `start_main_thread` below, which is a different reading from a
# different instrument and is reported separately on purpose. `Performance.getMetrics` gives
# `TaskDuration` for the page's main thread, and its slope against wall time is that thread's
# utilization. The two belong side by side and neither substitutes for the other: a viewer can cost
# four cores while its node idles, and it can peg its node while costing one.
#
# ## What the caller owes it
#
# `say()`, so a refusal lands in the run's own log, and `BROWSER_CONTAINER_NAME`.
declare -F say > /dev/null 2>&1 || {
  echo "browser-cpu.sh: source me after the caller's say(), so a refusal lands in the run's own log" >&2
  exit 1
}
: "${BROWSER_CONTAINER_NAME:?browser-cpu.sh needs BROWSER_CONTAINER_NAME, the container it samples}"
# ⚠️ No apostrophes in this message. Bash parses quotes inside a ${var:?word} word even within double
# quotes, so one unmatched quote opens a string that swallows the rest of the file.
: "${LOG:?browser-cpu.sh needs LOG, the file the main-thread sampler reports into}"

# Five seconds, against the node sampler's thirty. An arm is minutes long and CPU moves on the scale
# of a segment fetch, so a thirty second reading would show a handful of points and no shape.
BROWSER_CPU_INTERVAL_S="${BROWSER_CPU_INTERVAL_S:-5}"

BROWSER_CPU_PID=""

# Cores, from the percentage `docker stats` prints. 100% is one core on Linux, so 250.00% is 2.5.
#
# ⛔ A line that does not parse is DROPPED rather than counted as zero. An unreadable sample averaged
# in as idle is the same defect as reporting an unread container as a cheap one.
browser_cpu_cores() {
  awk -F'%' '{ gsub(/[^0-9.]/, "", $1); if ($1 != "") printf "%.4f\n", $1 / 100 }'
}

# Begin sampling, or say clearly that nothing will be sampled.
#
# ⛔⛔⛔ DECLINING IS ANNOUNCED RATHER THAN RETURNED QUIETLY, and that is the whole reason this branch
# is four lines instead of one. Two drivers shipped with a floor check reading a file no process in
# the run wrote, and no sitting log anywhere said so, because the launcher of the only writer had
# quietly declined. A control that is off must be as loud as one that fired. Gate lesson AHU.
start_browser_cpu() {
  local out="$1" label="$2"
  if ! awk -v v="${BROWSER_CPU_INTERVAL_S}" 'BEGIN { exit !(v + 0 > 0) }'; then
    say "  ⛔ NO CPU READING for ${label}: BROWSER_CPU_INTERVAL_S=${BROWSER_CPU_INTERVAL_S}, so nothing samples ${BROWSER_CONTAINER_NAME}"
    return 0
  fi
  : > "${out}"
  (
    while true; do
      docker stats --no-stream --format '{{.CPUPerc}}' "${BROWSER_CONTAINER_NAME}" 2> /dev/null >> "${out}" || true
      sleep "${BROWSER_CPU_INTERVAL_S}"
    done
  ) &
  BROWSER_CPU_PID=$!
  say "  sampling ${BROWSER_CONTAINER_NAME} CPU every ${BROWSER_CPU_INTERVAL_S}s into $(basename "${out}")"
}

stop_browser_cpu() {
  [ -n "${BROWSER_CPU_PID}" ] || return 0
  kill "${BROWSER_CPU_PID}" 2> /dev/null || true
  wait "${BROWSER_CPU_PID}" 2> /dev/null || true
  BROWSER_CPU_PID=""
}

# What the arm cost, or the fact that nobody found out.
#
# ⛔⛔ The COUNT is decided before any statistic is printed. Every figure over an empty series is
# either zero or absent, and "0.00 cores" in a report is indistinguishable from a viewer that cost
# nothing. A container that had not started yet answers exactly like one that was free.
summarize_browser_cpu() {
  local series="$1" label="$2" cores samples
  cores="$(browser_cpu_cores < "${series}" 2> /dev/null || true)"
  samples="$(printf '%s' "${cores}" | grep -c . || true)"
  if [ "${samples}" -eq 0 ]; then
    say "  ⛔ NO CPU READING for ${label}: ${BROWSER_CONTAINER_NAME} answered ${samples} times, so its cost is UNKNOWN and not zero"
    return 0
  fi
  printf '%s\n' "${cores}" | awk -v label="${label}" -v n="${samples}" '
    { total += $1; if ($1 > peak) peak = $1 }
    END { printf "  %s CPU: %d samples, mean %.2f cores, peak %.2f cores\n", label, n, total / n, peak }
  ' | while IFS= read -r line; do say "${line}"; done
}

# The OTHER reading: how much of the viewer's one thread the in-tab node actually used.
#
# ⛔⛔ Unset by default. `VIEWER_CDP_PORT` has to reach the browser container too, because the port is
# opened by Chrome inside it, so a driver that sets this must also pass it into `docker run`. Declining
# is announced for the same reason as above.
#
# ⛔⛔⛔ THE SAMPLER RUNS IN THE BROWSER IMAGE, NOT ON THE HOST, AND THAT IS NOT A STYLE CHOICE.
# `manager-host` has no node at all. The first version of this ran `node main-thread.mjs` on the host
# and would have declined on every arm of every sitting, forever, while its unit tests passed over a
# stub. That is the 2026-08-11 defect exactly: fourteen passing tests and no real arm, because the
# thing under test never existed on the machine that would run it. Proven here instead by starting a
# real browser container and reading its debugging port, which costs nothing.
MAIN_THREAD_CONTAINER="${MAIN_THREAD_CONTAINER:-${BROWSER_CONTAINER_NAME}-mainthread}"
MAIN_THREAD_INTERVAL_S="${MAIN_THREAD_INTERVAL_S:-5}"
MAIN_THREAD_STARTED=""
MAIN_THREAD_OUT=""
# One interval to notice the stop file, plus room for the write. Bounded because a sampler that will
# not exit must not hold the sitting.
MAIN_THREAD_DRAIN_S="${MAIN_THREAD_DRAIN_S:-20}"

start_main_thread() {
  local out="$1" label="$2" want_url="$3" dir base
  if [ -z "${VIEWER_CDP_PORT:-}" ]; then
    say "  ⛔ NO SATURATION READING for ${label}: VIEWER_CDP_PORT is unset, so nothing asks the page how busy its thread was"
    return 0
  fi
  dir="$(cd "$(dirname "${out}")" && pwd)"
  base="$(basename "${out}")"
  : > "${out}"
  docker rm -f "${MAIN_THREAD_CONTAINER}" > /dev/null 2>&1 || true
  # ⛔ Detached and deliberately NOT --rm. A sampler that refuses (no page matches, two do, the port
  # never answers) exits at once, and --rm would delete the container and its reason with it.
  # ⛔⛔ `--entrypoint node` skips the image's own entrypoint, which starts Xvfb. This container needs
  # node and nothing else, and running the entrypoint is not merely wasteful: with `--network host`
  # both containers share one abstract socket namespace, so the second Xvfb cannot bind the display
  # the arm's browser is already using, and it exits before the sampler ever runs. Measured here, not
  # reasoned about, by starting the pair and reading the failure.
  if ! docker run -d --network host --name "${MAIN_THREAD_CONTAINER}" \
    -u "$(id -u):$(id -g)" \
    -v "${BENCH_REPO:-$(pwd)}:/repo" \
    -v "${dir}:/out" \
    -e HOME=/tmp -w /repo \
    --entrypoint node \
    "${BROWSER_IMAGE:?browser-cpu.sh needs BROWSER_IMAGE to run the main-thread sampler}" \
    deploy/scripts/main-thread.mjs \
    "${VIEWER_CDP_PORT}" "${want_url}" "/out/${base}" "${MAIN_THREAD_INTERVAL_S}" "/out/${base}.stop" \
    > /dev/null 2>> "${LOG}"; then
    say "  ⛔ NO SATURATION READING for ${label}: the sampler container would not start"
    return 0
  fi
  MAIN_THREAD_STARTED=1
  MAIN_THREAD_OUT="${out}"
  say "  sampling the page main thread every ${MAIN_THREAD_INTERVAL_S}s into ${base}"
}

# ⛔⛔ ASKED TO STOP, NOT KILLED, and the difference is the whole summary. `docker rm -f` is a SIGKILL,
# which skips the sampler's write-out, so the series would survive and the line that says what it MEANS
# would not. The stop file is the same mechanism the node sampler uses and for the same reason.
#
# ⭐ The container's own output is copied into the run log before it is removed, because that is where
# the target gate says which page it chose and what it left unsampled. Losing it would leave a series
# of numbers with nothing saying which thread they belong to.
stop_main_thread() {
  [ -n "${MAIN_THREAD_STARTED}" ] || return 0
  [ -n "${MAIN_THREAD_OUT}" ] && : > "${MAIN_THREAD_OUT}.stop"
  timeout "${MAIN_THREAD_DRAIN_S}" docker wait "${MAIN_THREAD_CONTAINER}" > /dev/null 2>&1 || true
  docker logs "${MAIN_THREAD_CONTAINER}" >> "${LOG}" 2>&1 || true
  docker rm -f "${MAIN_THREAD_CONTAINER}" > /dev/null 2>&1 || true
  [ -n "${MAIN_THREAD_OUT}" ] && rm -f "${MAIN_THREAD_OUT}.stop"
  MAIN_THREAD_STARTED=""
  MAIN_THREAD_OUT=""
}

# ⛔⛔ The COUNT again, and one extra refusal the cost reading does not need: a summary whose
# `complete` flag is false was taken while something else in the browser could run script, so the
# thread it measured may not be the busy one. That is reported as loudly as a missing reading, because
# a number that is quietly about the wrong thread is worse than no number.
summarize_main_thread() {
  local series="$1" label="$2"
  if [ ! -s "${series}" ]; then
    say "  ⛔ NO SATURATION READING for ${label}: ${series##*/} is empty, so the thread's use is UNKNOWN and not zero"
    return 0
  fi
  MAIN_THREAD_LABEL="${label}" python3 - "${series}" <<'PY' | while IFS= read -r line; do say "${line}"; done
import json, os, sys

label = os.environ["MAIN_THREAD_LABEL"]
summary = None
readings = 0
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    row = json.loads(line)
    if "summary" in row:
        summary = row["summary"]
    else:
        readings += 1

if summary is None:
    print(f"  ⛔ NO SATURATION READING for {label}: {readings} readings but no summary, so the sampler never finished")
elif summary.get("usable", 0) < 2:
    print(f"  ⛔ NO SATURATION READING for {label}: {summary.get('usable', 0)} usable of {readings}, which cannot make a slope")
else:
    mean, peak = summary.get("mean"), summary.get("peak")
    warn = "" if summary.get("complete") else "  ⛔ INCOMPLETE, another target could run script:"
    print(
        f"{warn}  {label} main thread: {summary['usable']} readings over {summary['wallS']:.0f}s, "
        f"mean {mean:.3f} of one thread, peak {peak:.3f}"
    )
PY
}
