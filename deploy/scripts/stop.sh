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
    # The TARGET's services, not the whole filter. Handing every host the full list named a service
    # config.json places elsewhere, and compose stops a service outside the active profiles anyway
    # (measured on v5.3.1), so a stale container on the host that no longer owns it was stopped
    # without anyone asking.
    echo "stop $*"
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
  stop_flags=$(compose_stop_flags "${services[@]}")

  if is_local "$target"; then
    log_info "Stopping local services: ${services[*]}"
    cd "$DEPLOY_DIR"
    # SC2046 alongside SC2086: `env_file_flag` emits two words or none, and the splitting is the
    # point. Quoting it would send compose an empty argument when the profile has no env file.
    # shellcheck disable=SC2086,SC2046
    docker compose $project_flag $compose_files $(env_file_flag) $profiles $stop_flags
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

STOPPED_ANY=false
for target in $(get_targets); do
  services=($(get_filtered_services_for_target "$target"))
  # A target whose services the filter excluded entirely has nothing to stop, and running compose
  # with an empty service list is how a scoped stop becomes a project-wide one.
  [ ${#services[@]} -eq 0 ] && continue
  stop_target "$target" "${services[@]}"
  STOPPED_ANY=true
done

echo ""
# Naming a service that runs nowhere docker can reach it, "native" or disabled in config.json, used
# to print the success banner after touching nothing. deploy.sh already says this; stop.sh did not.
if [ "$STOPPED_ANY" = "false" ]; then
  log_warn "No services to stop (check config.json and the service filter)"
else
  echo "=== All services stopped ==="
fi
