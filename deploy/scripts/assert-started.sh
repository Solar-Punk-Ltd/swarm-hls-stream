#!/bin/bash
#
# Whether the services a deploy has just started are actually up, as a refusal rather than a note.
#
# ⛔⛔⛔ `docker compose up -d` returns as soon as a container has been created and started, and a
# container whose process throws on its first line has been started. With `restart: unless-stopped`
# docker then loops it, and the deploy that asked for it has already printed its success line. Every
# startup refusal this repository has on purpose lands in that gap: the five `required()` reads in
# `utils/config.ts`, and the chequebook floor and `PostageGate` on a deployment that sets
# UPLOADER_START_GATES=refuse, which since 2026-09-17 is what asks those two to stop a start at all.
# A node that does not answer is no longer one of them, since decision D16 of the same day: the
# uploader listens first and waits for its node, so it stays up and says `waiting_for_node` on
# /health instead of exiting into a restart loop. The compose healthcheck does not close the gap
# either, deliberately: it reports without acting, and nothing declares a dependency on it.
#
# ⛔⛔ A fixed sleep is blind to that gap in both directions, so this watches instead.
#
# In time: the uploader runs `ChequebookGate.assertFunded` and then `PostageGate.assertUsable`, one
# HTTP read per bee node and one per batch, in turn, each bounded by START_GATE_TIMEOUT_MS at
# 20000ms, and only then does `StreamCatalog.init` look a feed up on a node that may be cold. Those
# now run behind the listener, so the container stays up through all of it and answers /health,
# unhealthy while it waits. Under UPLOADER_START_GATES=refuse a gate that cannot clear its node is a
# refusal again, arriving a minute or more into the boot. Either way a five second look has already
# called the container started.
#
# And in one instant: the state alone cannot tell a loop from a healthy start, whichever order it is
# asked in. Early in a loop docker's restart backoff is a tenth of a second against a container that
# runs for seconds, so nearly every look lands on `running`. Once the backoff has grown the reverse
# holds, measured on docker 29.8.0 by sampling a loop ten times over ten seconds: eight reads of
# `restarting` and two of `running`. One look at a state is a coin toss either way, and the restart
# count is the evidence that does not depend on catching the right moment.
#
# What counts is a count that MOVES. The number itself is a lifetime total and a container can carry
# one into a deploy that did nothing wrong, so the baseline is read at the first look and only a rise
# above it refuses. See the watch below.
#
# Usage: assert-started.sh <compose project> <service> [service...]
#
# Standalone on purpose, with no `_lib.sh` behind it. The remote deploy runs it through the same ssh
# heredoc that runs compose there, in a shell that has docker and none of this repository sourced.
set -eo pipefail

# How long a service that declares a healthcheck gets to report healthy before the deploy accepts it
# anyway. 30 because that is the uploader's own `start_period` in `deploy/docker-compose.yml`, and
# that number already carries the answer to this exact question: its comment says it was sized so
# `StreamCatalog.init` can finish a feed lookup against a cold bee node. Naming a second number here
# would be a second answer to one question, free to drift from the first.
READY_TIMEOUT_SECONDS="${DEPLOY_READY_TIMEOUT_SECONDS:-30}"

# How often the watch looks. Two local daemon calls per service per look, against a window measured
# in tens of seconds, so this is cheap enough to be frequent and coarse enough to be quiet.
WATCH_INTERVAL_SECONDS="${DEPLOY_WATCH_INTERVAL_SECONDS:-2}"

# How long a service with NO healthcheck gets to fall over before a running container with no
# restarts behind it counts as started. The old whole-check timeout, kept and still the whole
# question for a service with no startup gates in front of it: an uploader that throws at config
# import exits within about a second, and the bee nodes and the engines either hold or exit just as
# fast. A service that does declare a healthcheck has something better to wait for, above.
SETTLE_SECONDS="${DEPLOY_SETTLE_SECONDS:-5}"

LOG_LINES="${DEPLOY_FAILURE_LOG_LINES:-40}"

PROJECT_LABEL='com.docker.compose.project'
SERVICE_LABEL='com.docker.compose.service'

# Restart count, docker's own state, and the healthcheck's verdict, one line per container. The
# `{{if}}` is what keeps this one command for every service: an image with no healthcheck has no
# `.State.Health` at all, and asking for it unguarded fails the whole inspect rather than answering.
INSPECT_FORMAT='{{.RestartCount}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'

if [ "$#" -lt 2 ]; then
  echo "usage: assert-started.sh <compose project> <service> [service...]" >&2
  exit 2
fi

project="$1"
shift
services=("$@")
service_count="${#services[@]}"

# Container ids of one service of one compose project, in whatever state they are in.
containers_of() {
  docker ps --all \
    --filter "label=${PROJECT_LABEL}=${project}" \
    --filter "label=${SERVICE_LABEL}=$1" \
    --quiet
}

# Whole looks, rounded up, for a window and an interval given in seconds. awk rather than shell
# arithmetic because the interval is allowed to be fractional and bash has no floats, and rounded up
# rather than down so a window is never shorter than it was asked to be.
looks_in() {
  awk -v window="$1" -v step="$2" 'BEGIN {
    if (step <= 0 || window <= 0) { print 0; exit }
    exact = window / step
    whole = int(exact)
    if (exact > whole) { whole = whole + 1 }
    print whole
  }'
}

# What one service's containers add up to, left in the `observed_` variables for the caller. Globals
# rather than a printed record, because five values come back and one of them is a sentence.
#
# The restart count is reported and not judged here. Whether it means anything is the caller's
# question, because only the caller knows what the count already was when this deploy arrived.
#
# Aggregated over every container the service has rather than read off the first, and the difference
# is a false refusal: a recreate can leave an old container behind carrying the same two labels, and
# reading whichever docker listed first would refuse a deploy for the state of the container it just
# replaced.
observe_service() {
  local ids id line restarts state health

  if ! ids="$(containers_of "$1")"; then
    return 1
  fi

  observed_running=''
  observed_state='no container'
  observed_health='none'
  observed_restarts=0
  observed_reason=''

  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if ! line="$(docker inspect --format "$INSPECT_FORMAT" "$id")"; then
      return 1
    fi
    read -r restarts state health <<<"$line"
    # A count that is not a number is a format this docker does not speak, and comparing it with -gt
    # would abort the script with a syntax error instead of reporting anything about the deploy.
    case "$restarts" in
      '' | *[!0-9]*) restarts=0 ;;
    esac

    if [ "$observed_state" = 'no container' ]; then
      observed_state="$state"
      observed_restarts="$restarts"
    fi

    case "$state" in
      running)
        if [ -z "$observed_running" ]; then
          observed_running="$id"
          observed_health="$health"
          observed_state="$state"
          observed_restarts="$restarts"
        fi
        ;;
      restarting)
        observed_reason='started and fell over, and docker is restarting it'
        ;;
    esac
  done <<<"$ids"

  # Only once nothing of the service is running, so the leftover container of a recreate cannot
  # refuse a deploy whose new container came up beside it.
  if [ -z "$observed_reason" ] && [ -z "$observed_running" ]; then
    case "$observed_state" in
      exited | dead) observed_reason="has exited, and docker has not brought it back" ;;
    esac
  fi
}

watch_looks="$(looks_in "$READY_TIMEOUT_SECONDS" "$WATCH_INTERVAL_SECONDS")"
settle_looks="$(looks_in "$SETTLE_SECONDS" "$WATCH_INTERVAL_SECONDS")"

# Collected rather than refused on the first one. A deploy brings up several services and a bad env
# file takes down every service that reads it, so refusing at the first name sends an operator round
# the same loop once per service.
broken_services=()
broken_reasons=()

confirmed=()
last_state=()
last_health=()
baseline_restarts=()
index=0
while [ "$index" -lt "$service_count" ]; do
  confirmed[index]=''
  last_state[index]='no container'
  last_health[index]='none'
  baseline_restarts[index]=0
  index=$((index + 1))
done

look=0
while :; do
  waiting=0
  index=0
  while [ "$index" -lt "$service_count" ]; do
    service="${services[$index]}"

    if ! observe_service "$service"; then
      echo "could not ask docker about ${service}, so whether this deploy came up is unknown" >&2
      exit 1
    fi
    last_state[index]="$observed_state"
    last_health[index]="$observed_health"

    # What docker's counter already said before this deploy watched anything. Only a RISE above it is
    # this deploy's business, because the count is a lifetime total rather than a record of today.
    # Measured on docker 29.8.0: a container that exited once and recovered reads `1 running` and is
    # perfectly well, and `compose up -d` on a service whose image and config have not moved leaves
    # that same container in place, count and all. Refusing on any non-zero count therefore refuses a
    # re-deploy of a healthy unchanged stack for a crash it recovered from days ago.
    #
    # Nothing is lost by starting from what was there. A container already looping when the deploy
    # arrived is either `restarting` right now, which refuses below whatever the count says, or it
    # raises the count again within one interval and refuses then.
    if [ "$look" -eq 0 ]; then
      baseline_restarts[index]="$observed_restarts"
    fi

    if [ "$observed_restarts" -gt "${baseline_restarts[$index]}" ]; then
      if [ -n "$observed_running" ]; then
        broken_services+=("$service")
        broken_reasons+=("is running, but docker restarted it while this deploy watched, taking its restart count from ${baseline_restarts[$index]} to ${observed_restarts}, so it is falling over and being looped")
      else
        broken_services+=("$service")
        broken_reasons+=("fell over while this deploy watched, taking its restart count from ${baseline_restarts[$index]} to ${observed_restarts}, and it is now ${observed_state}")
      fi
    elif [ -n "$observed_reason" ]; then
      broken_services+=("$service")
      broken_reasons+=("$observed_reason")
    elif [ -z "${confirmed[$index]}" ]; then
      if [ "$observed_health" = 'healthy' ]; then
        # The strongest answer available, and the only one that says the startup gates in front of
        # the API finished rather than that they had not failed yet.
        confirmed[index]='healthy'
      elif [ "$look" -ge "$settle_looks" ]; then
        if [ -z "$observed_running" ]; then
          broken_services+=("$service")
          broken_reasons+=('has no running container')
        elif [ "$observed_health" = 'none' ]; then
          confirmed[index]='running'
        fi
      fi
      [ -n "${confirmed[$index]}" ] || waiting=1
    fi

    index=$((index + 1))
  done

  [ "${#broken_services[@]}" -eq 0 ] || break
  [ "$waiting" -eq 1 ] || break
  [ "$look" -lt "$watch_looks" ] || break

  sleep "$WATCH_INTERVAL_SECONDS"
  look=$((look + 1))
done

# A service still unanswered when the window ran out. Accepted rather than refused, and the
# difference is deliberate: the uploader answers /health with a 503 whenever it is degraded, which
# one dropped segment on a recovered stream is enough to cause, so `unhealthy` is a report about
# media that was already lost and not a statement that the service failed to start. What a deploy
# may refuse on is a container that fell over, and this one has not. Said out loud, though, because
# a service that never answered its own healthcheck is not a service anybody should rely on unread.
if [ "${#broken_services[@]}" -eq 0 ]; then
  index=0
  while [ "$index" -lt "$service_count" ]; do
    if [ -z "${confirmed[$index]}" ]; then
      if [ "${last_state[$index]}" = 'running' ]; then
        echo "" >&2
        echo "${services[$index]} never reported healthy within ${READY_TIMEOUT_SECONDS}s: its healthcheck says '${last_health[$index]}'." >&2
        echo "  Its container is running and did not restart while this deploy watched, so this deploy is not refused on it. Check it before you rely on it." >&2
      else
        broken_services+=("${services[$index]}")
        broken_reasons+=('has no running container')
      fi
    fi
    index=$((index + 1))
  done
fi

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
