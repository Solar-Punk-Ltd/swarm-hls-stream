#!/bin/bash
set -e

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

require_jq
require_config

# --- Usage ---

usage() {
  echo "Usage: clean.sh [--profile=<name>] [options] [service...]"
  echo ""
  echo "Options:"
  echo "  --profile=<name>  Target a specific profile (default: \"default\")"
  echo "  --volumes         Also remove Docker volumes (data will be lost!). Whole project only."
  echo "  --all             Remove everything including remote files"
  echo "  --yes             Skip the interactive confirmation prompt"
  echo ""
  echo "Examples:"
  echo "  clean.sh                                 Stop and remove all containers"
  echo "  clean.sh bee-uploader                    Stop and remove only bee-uploader"
  echo "  clean.sh --volumes                       Remove containers + volumes"
  echo "  clean.sh --all                           Remove containers + volumes + remote files"
  echo "  clean.sh --profile=streamer1 --volumes   Remove streamer1 instance + its volumes"
  echo ""
  echo "Services: ${ALL_SERVICES[*]}"
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

# Profile flag drives ENV_FILE / REMOTE_BASE / docker compose project name.
parse_profile_args "$@"
set -- "${REST_ARGS[@]}"

load_env
apply_port_slot

# --- Parse args ---

REMOVE_VOLUMES=false
REMOVE_ALL=false
ASSUME_YES=false
FILTER_SERVICES=()

for arg in "$@"; do
  case "$arg" in
    --volumes)
      REMOVE_VOLUMES=true
      ;;
    --all)
      REMOVE_VOLUMES=true
      REMOVE_ALL=true
      ;;
    --yes|-y)
      ASSUME_YES=true
      ;;
    -*)
      log_error "Unknown option: $arg"
      usage
      exit 1
      ;;
    *)
      # Validate service name
      valid=false
      for svc in "${ALL_SERVICES[@]}"; do
        [ "$arg" = "$svc" ] && valid=true && break
      done
      if [ "$valid" = "false" ]; then
        log_error "Unknown service: $arg"
        usage
        exit 1
      fi
      FILTER_SERVICES+=("$arg")
      ;;
  esac
done

# Compose volumes carry the project label and have no per-service equivalent, so there is no way to
# remove one service's data without reaching every other service's as well. Refusing is the only
# honest answer: silently ignoring the flag would leave an operator believing data was removed, and
# honouring it destroys recordings nobody named. See OPS-2.
if [ "$REMOVE_VOLUMES" = "true" ] && [ ${#FILTER_SERVICES[@]} -gt 0 ]; then
  log_error "--volumes cannot be limited to a service (${FILTER_SERVICES[*]})."
  echo "  Compose volumes are labelled per project, not per service, so removing them would take"
  echo "  every other service's data with them. Run without a service to clean the whole project,"
  echo "  or remove that one volume by hand with 'docker volume rm'."
  exit 1
fi

# --- Filter helpers ---

is_in_filter() {
  local svc="$1"
  if [ ${#FILTER_SERVICES[@]} -eq 0 ]; then
    return 0
  fi
  for f in "${FILTER_SERVICES[@]}"; do
    [ "$f" = "$svc" ] && return 0
  done
  return 1
}

get_filtered_services_for_target() {
  local target="$1"
  for svc in $(get_services_for_target "$target"); do
    if is_in_filter "$svc"; then
      echo "$svc"
    fi
  done
}

# --- Clean ---

# Ids of the containers a straggler sweep may force-remove, given the services it is scoped to.
#
# The compose project label sits on every container in the stack, so a sweep filtered on that alone
# removes the whole stack. With services named on the command line the operator asked about those and
# nothing else, and compose's own service label is what narrows it. Called with no services the
# request was the entire project, and the sweep stays deliberately broad, because that is the case it
# exists for: a container whose service definition has since disappeared from config.json is exactly
# what `down` can no longer see. See OPS-2.
sweep_container_ids() {
  local svc
  if [ $# -eq 0 ]; then
    docker ps -aq --filter "label=com.docker.compose.project=$PROFILE" 2>/dev/null || true
    return
  fi
  for svc in "$@"; do
    docker ps -aq --filter "label=com.docker.compose.project=$PROFILE" \
      --filter "label=com.docker.compose.service=$svc" 2>/dev/null || true
  done
}

# The compose subcommand that tears the requested services down.
#
# **`--profile` does not scope `down`.** Measured against Compose v5.3.1 with this repo's own compose
# file: `docker compose -p X --profile bee-uploader down` removed the bee-gateway container too, which
# is every co-located service in the project. So the profile flags that select what to act on are
# silently ignored by the one subcommand that does the removing, and narrowing the straggler sweep
# alone left the stack being destroyed one step earlier. See OPS-2.
#
# With services named, `stop` followed by `rm -f` is used instead, because both take an explicit
# service list and honour it. `down` is reserved for the unfiltered case, where removing the project's
# networks and orphans is the actual request. `--remove-orphans` goes with it for the same reason:
# an orphan belongs to the project, not to any named service.
compose_teardown_flags() {
  if [ ${#FILTER_SERVICES[@]} -gt 0 ]; then
    echo "rm --stop --force ${FILTER_SERVICES[*]}"
    return
  fi
  if [ "$REMOVE_VOLUMES" = "true" ]; then
    echo "down -v --remove-orphans"
    return
  fi
  echo "down --remove-orphans"
}

# The services a sweep must stay inside, empty when the operator named none and the whole project is
# fair game. Kept as one accessor so the local, remote and post-loop sweeps cannot drift apart.
sweep_scope() {
  if [ ${#FILTER_SERVICES[@]} -eq 0 ]; then
    return
  fi
  printf '%s\n' "${FILTER_SERVICES[@]}"
}

clean_target() {
  local target="$1"
  shift
  local services=("$@")
  local project_flag down_flags
  project_flag=$(compose_project_flag)
  down_flags=$(compose_teardown_flags)

  echo ""
  log_info "Cleaning on $target: ${services[*]}"

  if is_local "$target"; then
    local compose_files profiles
    compose_files=$(build_compose_files "$DEPLOY_DIR")
    profiles=$(build_profile_flags "${services[@]}")
    cd "$DEPLOY_DIR"
    # Run the teardown with stderr visible so the user actually sees what was removed.
    # `|| true` lets us continue to the safety-net sweep below even when compose has
    # nothing to do (or the env/config drifted since the deploy).
    # shellcheck disable=SC2086
    docker compose $project_flag $compose_files --env-file "$ENV_FILE" $profiles $down_flags || true

    # Safety net: nuke any leftover containers labelled with this compose project,
    # in case config.json or the env file has drifted since the deploy and `down`
    # couldn't find the service definition. Filter by docker's standard label.
    local leftover scope
    scope=($(sweep_scope))
    leftover=$(sweep_container_ids "${scope[@]}")
    if [ -n "$leftover" ]; then
      local scope_note=""
      [ ${#scope[@]} -gt 0 ] && scope_note=" (services: ${scope[*]})"
      log_warn "Force-removing stragglers labelled com.docker.compose.project=$PROFILE$scope_note"
      # shellcheck disable=SC2086
      docker rm -f $leftover
    fi
    if [ "$REMOVE_VOLUMES" = "true" ]; then log_ok "Local clean done (containers + volumes)"; else log_ok "Local clean done (containers)"; fi
  else
    local remote_compose_files profiles
    remote_compose_files=$(build_compose_files "$REMOTE_BASE/deploy")
    profiles=$(build_profile_flags "${services[@]}")
    # Capture compose's exit code on the remote so we can tell whether anything happened.
    ssh "$target" bash -s <<REMOTE_SCRIPT
      set -e
      if [ ! -d $REMOTE_BASE/deploy ]; then
        echo "  (no $REMOTE_BASE/deploy on this host — nothing to clean)"
        exit 0
      fi
      cd $REMOTE_BASE/deploy
      docker compose $project_flag $remote_compose_files --env-file $REMOTE_BASE/.env $profiles $down_flags || true

      # Safety net (same idea as local, and scoped the same way): catch any container labelled with
      # this project, narrowed to the named services so cleaning one does not take the stack.
      SWEEP_SERVICES="$(sweep_scope | tr '\n' ' ')"
      if [ -z "\$SWEEP_SERVICES" ]; then
        LEFTOVER=\$(docker ps -aq --filter "label=com.docker.compose.project=$PROFILE" 2>/dev/null || true)
      else
        LEFTOVER=""
        for SVC in \$SWEEP_SERVICES; do
          LEFTOVER="\$LEFTOVER \$(docker ps -aq --filter "label=com.docker.compose.project=$PROFILE" --filter "label=com.docker.compose.service=\$SVC" 2>/dev/null || true)"
        done
      fi
      if [ -n "\$(echo \$LEFTOVER)" ]; then
        echo "  Force-removing stragglers labelled com.docker.compose.project=$PROFILE \$SWEEP_SERVICES"
        docker rm -f \$LEFTOVER
      fi
REMOTE_SCRIPT

    if [ "$REMOVE_ALL" = "true" ]; then
      log_info "Removing remote files on $target (may require sudo password)"
      ssh -t "$target" "sudo rm -rf $REMOTE_BASE"
      log_ok "Removed $REMOTE_BASE on $target"
    fi
  fi

  log_ok "Clean complete on $target"
}

# --- Main ---

print_services

if [ "$REMOVE_VOLUMES" = "true" ]; then
  log_warn "This will remove Docker volumes — data will be lost!"
fi
if [ "$REMOVE_ALL" = "true" ]; then
  log_warn "This will also remove all remote files!"
fi

if [ "$ASSUME_YES" != "true" ]; then
  echo ""
  read -r -p "Continue? [y/N] " answer
  if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
    echo "Aborted."
    exit 0
  fi
fi

visited_local=false
for target in $(get_targets); do
  services=($(get_filtered_services_for_target "$target"))
  [ ${#services[@]} -eq 0 ] && continue
  is_local "$target" && visited_local=true
  clean_target "$target" "${services[@]}"
done

# Always sweep localhost for stragglers tagged with this compose project, even if
# config.json now points everything at a remote target. Catches the case where a
# profile was deployed locally and config.json was edited afterwards.
if [ "$visited_local" = "false" ]; then
  sweep_scope_list=($(sweep_scope))
  local_leftover=$(sweep_container_ids "${sweep_scope_list[@]}")
  if [ -n "$local_leftover" ]; then
    echo ""
    log_warn "Found local containers labelled com.docker.compose.project=$PROFILE (config.json doesn't include localhost — sweeping anyway)"
    # shellcheck disable=SC2086
    docker rm -f $local_leftover
    # Volumes carry only the project label, with no per-service equivalent to narrow by, so a
    # service-scoped clean must not touch them: it cannot tell the named service's data from the
    # rest of the stack's, and guessing wrong here destroys a broadcast nobody asked about.
    if [ "$REMOVE_VOLUMES" = "true" ] && [ ${#FILTER_SERVICES[@]} -eq 0 ]; then
      # Docker compose-managed volumes carry the same project label.
      local_vols=$(docker volume ls -q --filter "label=com.docker.compose.project=$PROFILE" 2>/dev/null || true)
      if [ -n "$local_vols" ]; then
        # shellcheck disable=SC2086
        docker volume rm $local_vols || true
      fi
    fi
    log_ok "Local sweep done"
  fi
fi

echo ""
echo "=== Clean complete ==="
