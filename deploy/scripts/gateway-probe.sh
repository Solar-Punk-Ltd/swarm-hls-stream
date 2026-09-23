#!/usr/bin/env bash
#
# Reading a bee gateway's own instruments, and changing the env file it was started from.
#
# Sourced, never executed. The caller supplies:
#   CONTAINER          the gateway container name, for gateway_cpu_seconds
#   METRICS            path to gateway-retrieval-metrics.sh, for metrics. It takes the API port as
#                      its only argument, where node-metrics.sh wants a subcommand first. The two
#                      scripts that call metrics default it to /home/solarpunk/phase06/metrics.sh
#                      on the host.
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
#
# ⛔ The value travels through the environment rather than through a sed replacement, because one of
# the values written here is a chain endpoint: a URL holds slashes, which close sed's substitution
# early, and can hold an ampersand, which sed reads as the whole match again. `sed -i` also takes an
# argument on BSD and none on GNU, so an in-place edit is one of the two ways this suite's own tests
# cannot run on the machine writing them.
set_env_value() {
  local key="$1" value="$2" rewritten
  rewritten="$(ENV_KEY="${key}" ENV_VALUE="${value}" awk '
    BEGIN { key = ENVIRON["ENV_KEY"]; value = ENVIRON["ENV_VALUE"]; found = 0 }
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (found == 0) print key "=" value }
  ' "${ENV_FILE}")" || return 1
  printf '%s\n' "${rewritten}" >"${ENV_FILE}"
}

# Takes a key out of the env file altogether, which is the only way to put back a key that was not
# there. Present-and-empty is a different state: compose reads it and a `${NAME:-default}` then
# resolves to the empty value rather than to the default.
unset_env_value() {
  local key="$1" rewritten
  rewritten="$(ENV_KEY="${key}" awk '
    BEGIN { key = ENVIRON["ENV_KEY"] }
    index($0, key "=") == 1 { next }
    { print }
  ' "${ENV_FILE}")" || return 1
  printf '%s\n' "${rewritten}" >"${ENV_FILE}"
}
