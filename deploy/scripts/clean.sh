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
  echo "  --volumes         Also remove Docker volumes (data will be lost!)"
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
apply_port_prefix

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

clean_target() {
  local target="$1"
  shift
  local services=("$@")
  local project_flag down_flags
  project_flag=$(compose_project_flag)
  # `down` removes containers + networks for the listed compose profiles.
  # With --volumes also remove the named volumes.
  if [ "$REMOVE_VOLUMES" = "true" ]; then
    down_flags="down -v"
  else
    down_flags="down"
  fi

  echo ""
  log_info "Cleaning on $target: ${services[*]}"

  if is_local "$target"; then
    local compose_files profiles
    compose_files=$(build_compose_files "$DEPLOY_DIR")
    profiles=$(build_profile_flags "${services[@]}")
    cd "$DEPLOY_DIR"
    # shellcheck disable=SC2086
    docker compose $project_flag $compose_files --env-file "$ENV_FILE" $profiles $down_flags --remove-orphans 2>/dev/null || true
    if [ "$REMOVE_VOLUMES" = "true" ]; then log_ok "Removed containers + volumes"; else log_ok "Removed containers"; fi
  else
    local remote_compose_files profiles
    remote_compose_files=$(build_compose_files "$REMOTE_BASE/deploy")
    profiles=$(build_profile_flags "${services[@]}")
    ssh "$target" bash -s <<REMOTE_SCRIPT
      set -e
      cd $REMOTE_BASE/deploy
      docker compose $project_flag $remote_compose_files --env-file $REMOTE_BASE/.env $profiles $down_flags --remove-orphans 2>/dev/null || true
      if [ "$REMOVE_VOLUMES" = "true" ]; then echo "  Removed containers + volumes"; else echo "  Removed containers"; fi
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

for target in $(get_targets); do
  services=($(get_filtered_services_for_target "$target"))
  [ ${#services[@]} -eq 0 ] && continue
  clean_target "$target" "${services[@]}"
done

echo ""
echo "=== Clean complete ==="
