#!/bin/bash
#
# Block until the media engine's SRT ingest is actually listening, or give up loudly.
#
# ## Why a separate check, when the container is already reported healthy
#
# Every signal the deployment has answers a question next to this one. `docker ps` says the process is
# running, the compose healthcheck says it answered on its HTTP port, and the uploader's `/health`
# says how many streams are active, which is zero both when nobody is publishing and when nobody can.
# None of them asks whether the ingest socket is bound.
#
# That gap is OBS-20, observed on `latbench` on 2026-08-03: SRS failed to bind its SRT listener with
# `errno=98` because a container from a previous stack still held the UDP port under host networking,
# and it ran 44 minutes reporting healthy and accepting nothing. The bind error was not written to the
# log until the container was stopped, so there was nothing to grep for while it mattered.
#
# `ss` answers the question directly and is the one thing that cannot be satisfied by a process that
# merely started.
#
# ## Why it is a UDP listener and what that costs
#
# SRT is UDP, so a bound socket is `UNCONN` rather than `LISTEN` and there is no handshake to observe
# from here. This proves the port is claimed by something in the host's network namespace, which is
# what the failure above destroys, and it does not prove the engine behind it will accept a publish.
# A deeper probe would have to publish, which spends money and takes a stream id.
#
# Usage:
#   deploy/scripts/wait-for-ingest.sh [--profile=<name>] [--portSlot=<N>] [--timeout=<seconds>]

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

require_jq
require_config

TIMEOUT_S=60
REMAINING_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --timeout=*) TIMEOUT_S="${arg#*=}" ;;
    *) REMAINING_ARGS+=("$arg") ;;
  esac
done

# Profile flag drives ENV_FILE / REMOTE_BASE / docker compose project name.
parse_profile_args ${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}

load_env
load_engine_envs
# The port is read through the same slot arithmetic the deploy used rather than passed in, so this
# cannot end up watching a port no one was asked to bind.
apply_port_slot

PORT="${SRS_SRT_PORT:?SRS_SRT_PORT is unset after apply_port_slot, so there is no ingest port to wait on}"
TARGET="$(get_target srs)"

if ! is_enabled "${TARGET}"; then
  log_error "srs is disabled in config.json, so it has no ingest to wait for"
  exit 1
fi

# `-H` drops the header so an empty result is an empty string, and the filter is applied by `ss`
# rather than by grep, which would also match a port that merely contains these digits.
probe='ss -H -lun "sport = :'"${PORT}"'"'

log_info "waiting up to ${TIMEOUT_S}s for the SRT ingest on UDP ${PORT} (${TARGET})"

deadline=$((SECONDS + TIMEOUT_S))
while [ "${SECONDS}" -lt "${deadline}" ]; do
  if [ "${TARGET}" = "localhost" ]; then
    bound="$(bash -c "${probe}" 2>/dev/null)"
  else
    bound="$(ssh "${TARGET}" "${probe}" 2>/dev/null)"
  fi

  if [ -n "${bound}" ]; then
    log_ok "SRT ingest bound on UDP ${PORT}"
    exit 0
  fi
  sleep 2
done

log_error "no listener on UDP ${PORT} after ${TIMEOUT_S}s. The engine container can be running and"
log_error "reported healthy in this state (OBS-20): check whether another container already holds"
log_error "the port, with 'ss -lunp | grep ${PORT}' on ${TARGET}."
exit 1
