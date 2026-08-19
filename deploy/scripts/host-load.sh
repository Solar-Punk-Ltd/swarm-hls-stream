#!/usr/bin/env bash
#
# Reading the box this sitting shares with forty other bee nodes and several tenants' stacks.
#
# ⛔ Load is the one instrument here that measures something we do not control. A result sitting on a
# busy host is "did not complete" rather than a measurement, which is why the drivers that use these
# order their plans by ascending cost and stop at the first arm that pushes the box too far.
#
# Sourced, never executed. The caller supplies:
#   host_load          a function of its own, because its two callers disagree on how to read it
#   LOAD_SAMPLE_S      seconds between samples, for sample_host_load only
#
# shellcheck shell=bash

# The fourth field of /proc/loadavg is runnable/total, and the runnable half is what says whether
# work is queueing rather than merely present.
host_runnable() { awk '{split($4, r, "/"); print r[1]}' /proc/loadavg; }

# The median of three reads two seconds apart. A single sample of a shared host is a coin toss, and
# the median of three is cheap enough to take before every arm.
baseline_runnable() {
  local a b c
  a="$(host_runnable)"
  sleep 2
  b="$(host_runnable)"
  sleep 2
  c="$(host_runnable)"
  printf '%s\n%s\n%s\n' "${a}" "${b}" "${c}" | sort -n | sed -n 2p
}

# Appends "<load> <runnable>" to $1 until the flag file $2 disappears or the parent shell exits.
# ⛔ The parent check is not belt and braces: without it a sampler outlives a killed driver and keeps
# writing into a directory whose sitting is over.
sample_host_load() {
  local out="$1" flag="$2" parent="$$"
  while [ -e "${flag}" ] && kill -0 "${parent}" 2>/dev/null; do
    printf '%s %s\n' "$(host_load)" "$(host_runnable)" >>"${out}"
    sleep "${LOAD_SAMPLE_S}"
  done
}
