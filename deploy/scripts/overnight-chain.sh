#!/usr/bin/env bash
#
# Run a night of sittings one after another, unattended, on the deployment host.
#
# ## What makes this different from the overnight runs before it
#
# Every previous unattended night here ran only work that **could not spend**: the arms were unfunded,
# so `/chequebook/balance` answered `chain disabled` and the node itself was the proof. That rule was
# mine, written when nobody had authorised an overnight spend, and it is not the rule any more. This
# chain publishes and it costs money.
#
# So "cannot spend" is replaced by "cannot overspend", which needs gates rather than a promise:
#
#   - every sitting is priced and refused by `can_afford` before it starts, and again per arm
#   - every sitting is refused by `stamp-guard.sh` if the batch cannot carry it
#   - both bee nodes are sampled THROUGH a long arm, and a crossed floor writes the stop file
#   - the stop file is shared by every sitting here, so one crossing ends the night rather than one
#     sitting: the nodes do not refill in between
#   - a sitting that overruns its deadline is stopped, so one hung run cannot eat the whole window
#
# ## Why a deadline per sitting and not just for the chain
#
# The longest thing this project has ever run is ten minutes. A four-hour arm is a regime nothing has
# been watched in, and the failure worth protecting against is not "it costs too much", it is "it
# hangs at minute twenty and the next sitting never starts". A deadline turns that into a lost
# sitting instead of a lost night.
#
# ## ⛔ The teardown rule
#
# This never removes a publisher itself. `viewer-arms.sh` records the publishers that existed before
# it started and excludes them from every teardown, because on 2026-08-12 a teardown keyed on a name
# pattern killed a live paid broadcast belonging to another sitting. A deadline stop here sends TERM
# first and waits, so the sitting's own trap runs and removes its own publishers, and only escalates
# to KILL if that does not finish.
#
# Usage, on the deployment host:
#   setsid nohup bash deploy/scripts/overnight-chain.sh plan.tsv >/dev/null 2>&1 &
#
# Plan file, one sitting per line, TAB separated:
#   <name>  <deadline_minutes>  <driver>  <KEY=VAL|KEY=VAL|...>
#
# ⛔ Settings are separated by `|` and not by spaces, because a value can contain them: the most
# important setting any sitting here passes is `ARMS=obs-default:2.0 shipped:0.5`, which is one value
# holding two arms. Split on whitespace and `env` reads the second arm as the name of a command to
# run, and the sitting dies at startup having published nothing.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAN="${1:?usage: overnight-chain.sh <plan.tsv>}"

CHAIN_DIR="${CHAIN_DIR:-/home/solarpunk/overnight/$(date -u +%Y%m%d-%H%M%S)}"
LOG="${CHAIN_DIR}/chain.log"
STATE="${CHAIN_DIR}/chain-state.tsv"
# One file for the whole night. A floor crossed in sitting two is still crossed in sitting three.
STOP_FILE="${STOP_FILE:-${CHAIN_DIR}/STOP}"

# The box carries roughly forty other bee nodes and eight unrelated stacks, and "existing resources
# must not be touched" covers starving them as much as stopping them. Checked before each sitting
# rather than during, because a sitting that stops halfway leaves rows nothing can be read against.
LOAD_CEILING="${LOAD_CEILING:-32}"
LOAD_WAIT_S="${LOAD_WAIT_S:-300}"
LOAD_WAIT_MAX_S="${LOAD_WAIT_MAX_S:-1800}"

# How long a sitting gets to shut itself down cleanly after a deadline stop, before it is killed.
# Its own EXIT trap is what removes its publishers, so this has to be long enough for docker rm.
GRACE_S="${GRACE_S:-60}"
POLL_S="${POLL_S:-15}"

# A sitting leads its own process group where the host provides it, so a deadline stop reaches the
# whole tree rather than the driver alone, leaving a browser container holding the Xvfb display.
# ⚠️ macOS has no `setsid`, and the tests run there. Without it the stop falls back to the single
# pid, which `stop_sitting` already handles, and the driver's own trap still removes its publishers.
SETSID="$(command -v setsid 2>/dev/null || true)"

mkdir -p "${CHAIN_DIR}"

say() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >> "${LOG}"; }

# Overridable so the ceiling can be driven against a real file rather than mocked away. The host this
# runs on has /proc; the laptop the tests run on does not.
LOADAVG_FILE="${LOADAVG_FILE:-/proc/loadavg}"

host_load() {
  cut -d' ' -f1 "${LOADAVG_FILE}" 2>/dev/null | cut -d. -f1
}

# Returns 0 once the box is quiet enough, or 1 if it never becomes quiet within the budget.
wait_for_quiet_host() {
  local waited=0 load
  while :; do
    load="$(host_load)"
    [ -z "${load}" ] && load=0
    if [ "${load}" -le "${LOAD_CEILING}" ] 2>/dev/null; then
      say "  host load ${load} is at or under the ceiling of ${LOAD_CEILING}"
      return 0
    fi
    if [ "${waited}" -ge "${LOAD_WAIT_MAX_S}" ]; then
      say "  host load ${load} stayed over ${LOAD_CEILING} for ${waited}s, so this sitting is skipped"
      return 1
    fi
    say "  host load ${load} is over the ceiling of ${LOAD_CEILING}, waiting ${LOAD_WAIT_S}s for the neighbours"
    sleep "${LOAD_WAIT_S}"
    waited=$((waited + LOAD_WAIT_S))
  done
}

# TERM, then wait out the grace period, then KILL. The sitting's own trap is what removes its
# publishers, and a KILL would skip it and leave a broadcast running for the rest of the night.
stop_sitting() {
  local pid="$1" waited=0
  kill -TERM "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
  while kill -0 "${pid}" 2>/dev/null && [ "${waited}" -lt "${GRACE_S}" ]; do
    sleep 5
    waited=$((waited + 5))
  done
  if kill -0 "${pid}" 2>/dev/null; then
    say "  it did not stop within ${GRACE_S}s of TERM, so it is being killed"
    kill -KILL "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
  fi
}

run_sitting() {
  local name="$1" deadline_min="$2" driver="$3" settings="$4"
  local out="${CHAIN_DIR}/${name}"
  local started deadline pid status=0 outcome

  if [ -f "${STOP_FILE}" ]; then
    say "SKIPPING ${name}: a floor was crossed earlier tonight"
    sed 's/^/  /' "${STOP_FILE}" >> "${LOG}"
    printf '%s\t%s\tSKIPPED-FLOOR\n' "$(date -u +%FT%TZ)" "${name}" >> "${STATE}"
    return 1
  fi

  say "${name}: starting, deadline ${deadline_min} min, driver ${driver}"
  say "  ${settings}"
  if ! wait_for_quiet_host; then
    printf '%s\t%s\tSKIPPED-LOAD\n' "$(date -u +%FT%TZ)" "${name}" >> "${STATE}"
    return 0
  fi

  mkdir -p "${out}"
  started="$(date -u +%s)"
  deadline=$((started + deadline_min * 60))

  local assignments=() pair saved_ifs="${IFS}"
  IFS='|'
  for pair in ${settings}; do
    [ -n "${pair}" ] && assignments+=("${pair}")
  done
  IFS="${saved_ifs}"

  # shellcheck disable=SC2086
  ${SETSID} env OUT_DIR="${out}" STOP_FILE="${STOP_FILE}" ${assignments+"${assignments[@]}"} \
    bash "${HERE}/${driver}" >> "${out}/driver.out" 2>&1 &
  pid=$!

  while kill -0 "${pid}" 2>/dev/null; do
    if [ "$(date -u +%s)" -ge "${deadline}" ]; then
      say "  ${name} passed its ${deadline_min} min deadline, stopping it"
      stop_sitting "${pid}"
      outcome="DEADLINE"
      break
    fi
    sleep "${POLL_S}"
  done
  wait "${pid}" 2>/dev/null || status=$?

  outcome="${outcome:-$([ "${status}" -eq 0 ] && echo ok || echo "REFUSED-OR-FAILED(${status})")}"
  printf '%s\t%s\t%s\t%dmin\n' "$(date -u +%FT%TZ)" "${name}" "${outcome}" \
    "$((($(date -u +%s) - started) / 60))" >> "${STATE}"
  say "${name}: ${outcome} after $((($(date -u +%s) - started) / 60)) min"
  return 0
}

[ -r "${PLAN}" ] || { say "REFUSING: cannot read the plan at ${PLAN}"; exit 2; }

say "overnight chain starting from ${PLAN}"
say "  stop file ${STOP_FILE}, load ceiling ${LOAD_CEILING}"

while IFS=$'\t' read -r name deadline_min driver settings; do
  case "${name}" in ''|'#'*) continue ;; esac
  run_sitting "${name}" "${deadline_min}" "${driver}" "${settings}" || break
done < "${PLAN}"

say "overnight chain done: $(wc -l < "${STATE}" 2>/dev/null || echo 0) sittings recorded"
