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
# retrieval is capped by that rather than by the network. That question needs `Performance.getMetrics`
# over CDP against the page target, which `chrome-cpu.mjs` does and nothing here does. No figure from
# this file may be quoted as a saturation figure.
#
# ## What the caller owes it
#
# `say()`, so a refusal lands in the run's own log, and `BROWSER_CONTAINER_NAME`.
declare -F say > /dev/null 2>&1 || {
  echo "browser-cpu.sh: source me after the caller's say(), so a refusal lands in the run's own log" >&2
  exit 1
}
: "${BROWSER_CONTAINER_NAME:?browser-cpu.sh needs BROWSER_CONTAINER_NAME, the container it samples}"

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
