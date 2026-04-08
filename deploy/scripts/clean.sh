#!/bin/bash
set -e

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

require_jq
require_config
load_env

# --- Usage ---

usage() {
  echo "Usage: clean.sh [options] [service...]"
  echo ""
  echo "Options:"
  echo "  --volumes    Also remove Docker volumes (data will be lost!)"
  echo "  --all        Remove everything including remote files"
  echo ""
  echo "Examples:"
  echo "  clean.sh                           Stop and remove all containers"
  echo "  clean.sh bee-uploader              Stop and remove only bee-uploader"
  echo "  clean.sh --volumes                 Remove containers + volumes"
  echo "  clean.sh --all                     Remove containers + volumes + remote files"
  echo "  clean.sh --volumes bee-uploader    Remove bee-uploader container + its volumes"
  echo ""
  echo "Services: ${ALL_SERVICES[*]}"
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

# --- Parse args ---

REMOVE_VOLUMES=false
REMOVE_ALL=false
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

  echo ""
  log_info "Cleaning on $target: ${services[*]}"

  # Force remove containers
  if is_local "$target"; then
    for svc in "${services[@]}"; do
      if docker rm -f "$svc" 2>/dev/null; then
        log_ok "Removed container: $svc"
      fi
    done

    if [ "$REMOVE_VOLUMES" = "true" ]; then
      local compose_files
      compose_files=$(build_compose_files "$DEPLOY_DIR")
      local profiles
      profiles=$(build_profile_flags "${services[@]}")
      cd "$DEPLOY_DIR"
      # shellcheck disable=SC2086
      docker compose $compose_files --env-file "$ENV_FILE" $profiles down -v 2>/dev/null || true
      log_ok "Removed volumes"
    fi
  else
    # Remote
    local services_list="${services[*]}"
    ssh "$target" bash -s <<REMOTE_SCRIPT
      for svc in ${services_list}; do
        if docker rm -f \$svc 2>/dev/null; then
          echo "  Removed container: \$svc"
        fi
      done
REMOTE_SCRIPT

    if [ "$REMOVE_VOLUMES" = "true" ]; then
      local remote_compose_files
      remote_compose_files=$(build_compose_files "$REMOTE_BASE/deploy")
      local profiles
      profiles=$(build_profile_flags "${services[@]}")
      ssh "$target" bash -s <<REMOTE_SCRIPT
        set -e
        cd $REMOTE_BASE/deploy
        docker compose $remote_compose_files --env-file $REMOTE_BASE/.env $profiles down -v 2>/dev/null || true
        echo "  Removed volumes"
REMOTE_SCRIPT
    fi

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

echo ""
read -r -p "Continue? [y/N] " answer
if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

for target in $(get_targets); do
  services=($(get_filtered_services_for_target "$target"))
  [ ${#services[@]} -eq 0 ] && continue
  clean_target "$target" "${services[@]}"
done

echo ""
echo "=== Clean complete ==="
