#!/bin/bash
#
# Whether the services a deploy has just started are actually up, as a refusal rather than a note.
#
# ⛔⛔⛔ `docker compose up -d` returns as soon as a container has been created and started, and a
# container whose process throws on its first line has been started. With `restart: unless-stopped`
# docker then loops it, and the deploy that asked for it has already printed its success line. Every
# startup refusal this repository has on purpose lands in that gap: the five `required()` reads in
# `utils/config.ts`, the chequebook floor, and `PostageGate`. The compose healthcheck does not close
# it either, deliberately: it reports without acting, and nothing declares a dependency on it.
#
# Usage: assert-started.sh <compose project> <service> [service...]
#
# Standalone on purpose, with no `_lib.sh` behind it. The remote deploy runs it through the same ssh
# heredoc that runs compose there, in a shell that has docker and none of this repository sourced.
set -eo pipefail

# How long a container gets to fall over before its deploy calls it started. An uploader that throws
# at config import exits within about a second, so this is generous rather than tight, and it is the
# whole cost this check adds to a deploy that is fine.
SETTLE_SECONDS="${DEPLOY_SETTLE_SECONDS:-5}"
LOG_LINES="${DEPLOY_FAILURE_LOG_LINES:-40}"

PROJECT_LABEL='com.docker.compose.project'
SERVICE_LABEL='com.docker.compose.service'

if [ "$#" -lt 2 ]; then
  echo "usage: assert-started.sh <compose project> <service> [service...]" >&2
  exit 2
fi

project="$1"
shift

# Container ids of one service of one compose project, narrowed to a docker state.
containers_in_state() {
  docker ps --all \
    --filter "label=${PROJECT_LABEL}=${project}" \
    --filter "label=${SERVICE_LABEL}=$1" \
    --filter "status=$2" \
    --quiet
}

sleep "$SETTLE_SECONDS"

# Collected rather than refused on the first one. A deploy brings up several services and a bad env
# file takes down every service that reads it, so refusing at the first name sends an operator round
# the same loop once per service.
broken_services=()
broken_reasons=()

for service in "$@"; do
  if ! restarting="$(containers_in_state "$service" restarting)"; then
    echo "could not ask docker about ${service}, so whether this deploy came up is unknown" >&2
    exit 1
  fi
  if ! running="$(containers_in_state "$service" running)"; then
    echo "could not ask docker about ${service}, so whether this deploy came up is unknown" >&2
    exit 1
  fi

  # Restarting first, because a crash loop passes through running on its way round and a container
  # caught mid-attempt would otherwise read as healthy.
  if [ -n "$restarting" ]; then
    broken_services+=("$service")
    broken_reasons+=("started and fell over, and docker is restarting it")
  elif [ -z "$running" ]; then
    broken_services+=("$service")
    broken_reasons+=("has no running container")
  fi
done

if [ "${#broken_services[@]}" -eq 0 ]; then
  exit 0
fi

echo "" >&2
echo "DEPLOY REFUSED: ${#broken_services[@]} of $# service(s) are not up under compose project '${project}'." >&2

index=0
while [ "$index" -lt "${#broken_services[@]}" ]; do
  service="${broken_services[$index]}"
  echo "" >&2
  echo "  ${service}: ${broken_reasons[$index]}" >&2

  if ids="$(docker ps --all \
    --filter "label=${PROJECT_LABEL}=${project}" \
    --filter "label=${SERVICE_LABEL}=${service}" \
    --quiet)"; then
    # The first id only. A service has one container per deployment here, and taking the head without
    # a pipe keeps this readable under `pipefail`.
    id="${ids%%$'\n'*}"
    if [ -n "$id" ]; then
      echo "  its last ${LOG_LINES} lines, which is where the reason is:" >&2
      # Both streams. A service that refuses to start says why on one of them and there is no telling
      # which, and this whole check exists because an unread stream cost three runs to find.
      logs="$(docker logs --tail "$LOG_LINES" "$id" 2>&1 || true)"
      echo "$logs" >&2
    fi
  fi

  index=$((index + 1))
done

echo "" >&2
echo "Nothing was rolled back: the previous containers were replaced before this ran. Fix the cause and deploy again." >&2
exit 1
