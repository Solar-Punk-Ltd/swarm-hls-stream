#!/usr/bin/env bash
#
# Reading a bee gateway's own instruments, and changing the env file it was started from.
#
# Sourced, never executed. The caller supplies:
#   CONTAINER          the gateway container name, for gateway_cpu_seconds
#   METRICS            path to node-metrics.sh, for metrics
#   GATEWAY_BEE_PORT   the gateway's API port, for metrics
#   ENV_FILE           the compose env file, for set_env_value
#
# shellcheck shell=bash

# User+system CPU seconds the gateway process has burned since it started, as a float.
# ⛔ A LIFETIME TOTAL, never a rate. Two readings and a subtraction is the only correct use.
gateway_cpu_seconds() {
  local pid ticks
  pid="$(docker inspect --format '{{.State.Pid}}' "${CONTAINER}" 2>/dev/null)"
  if [ -z "${pid}" ] || [ ! -r "/proc/${pid}/stat" ]; then
    printf '0'
    return
  fi
  # The comm field is parenthesised and may contain spaces, so count fields after the last ')'.
  ticks="$(sed 's/.*) //' "/proc/${pid}/stat" | awk '{print $12+$13}')"
  awk -v t="${ticks:-0}" -v h="$(getconf CLK_TCK)" 'BEGIN{printf "%.2f", (h>0)?t/h:0}'
}

metrics() { bash "${METRICS}" "${GATEWAY_BEE_PORT}" 2>/dev/null; }

# ⛔ Absent from the env file is a distinct state from present-and-zero, and a caller that restores
# the wrong one leaves the stack subtly different from how it found it. This writes; remembering
# which of the two states to put back is the caller's job.
set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "${ENV_FILE}"; then
    sed -i "s/^${key}=.*/${key}=${value}/" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >>"${ENV_FILE}"
  fi
}
