#!/bin/bash
set -e

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

require_jq
require_config
load_env

print_services

stop_target() {
  local target="$1"
  shift
  local services=("$@")
  local profiles compose_files
  profiles=$(build_profile_flags "${services[@]}")
  compose_files=$(build_compose_files "$DEPLOY_DIR")

  if is_local "$target"; then
    log_info "Stopping local services: ${services[*]}"
    cd "$DEPLOY_DIR"
    # shellcheck disable=SC2086
    docker compose $compose_files --env-file "$ENV_FILE" $profiles down
  else
    local remote_compose_files
    remote_compose_files=$(build_compose_files "$REMOTE_BASE/deploy")
    log_info "Stopping services on $target: ${services[*]}"
    ssh "$target" bash -s <<REMOTE_SCRIPT
      set -e
      cd $REMOTE_BASE/deploy
      docker compose $remote_compose_files --env-file $REMOTE_BASE/.env $profiles down
REMOTE_SCRIPT
  fi

  log_ok "Stopped on $target"
}

for target in $(get_targets); do
  services=($(get_services_for_target "$target"))
  stop_target "$target" "${services[@]}"
done

echo ""
echo "=== All services stopped ==="
