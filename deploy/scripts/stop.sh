#!/bin/bash
set -e

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

require_jq
require_config

usage() {
  echo "Usage: stop.sh [--profile=<name>] [service...]"
  echo ""
  echo "  stop.sh                       Stop every service on every target"
  echo "  stop.sh srs stream-uploader   Stop only those two"
  echo "  stop.sh --profile=streamer1   Stop the streamer1 instance"
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

for arg in "$@"; do
  add_service_filter "$arg" || {
    usage
    exit 1
  }
done

load_env
load_engine_envs
apply_port_slot

print_services

# `--profile` does not scope `down`: compose removes every co-located service in the project
# regardless, measured against v5.3.1 during the OPS-2 work. So a stop the operator scoped to a
# service uses `stop` with an explicit service list, which is the form compose honours. `down` is
# kept for the unfiltered case, where taking the project's network with it is the actual request.
compose_stop_flags() {
  if [ ${#FILTER_SERVICES[@]} -gt 0 ]; then
    echo "stop ${FILTER_SERVICES[*]}"
    return
  fi
  echo "down"
}

stop_target() {
  local target="$1"
  shift
  local services=("$@")
  local profiles compose_files project_flag stop_flags
  profiles=$(build_profile_flags "${services[@]}")
  compose_files=$(build_compose_files "$DEPLOY_DIR")
  project_flag=$(compose_project_flag)
  stop_flags=$(compose_stop_flags)

  if is_local "$target"; then
    log_info "Stopping local services: ${services[*]}"
    cd "$DEPLOY_DIR"
    # shellcheck disable=SC2086
    docker compose $project_flag $compose_files --env-file "$ENV_FILE" $profiles $stop_flags
  else
    local remote_compose_files
    remote_compose_files=$(build_compose_files "$REMOTE_BASE/deploy")
    log_info "Stopping services on $target: ${services[*]}"
    ssh "$target" bash -s <<REMOTE_SCRIPT
      set -e
      cd $REMOTE_BASE/deploy
      docker compose $project_flag $remote_compose_files --env-file $REMOTE_BASE/.env $profiles $stop_flags
REMOTE_SCRIPT
  fi

  log_ok "Stopped on $target"
}

for target in $(get_targets); do
  services=($(get_filtered_services_for_target "$target"))
  # A target whose services the filter excluded entirely has nothing to stop, and running compose
  # with an empty service list is how a scoped stop becomes a project-wide one.
  [ ${#services[@]} -eq 0 ] && continue
  stop_target "$target" "${services[@]}"
done

echo ""
echo "=== All services stopped ==="
