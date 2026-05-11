#!/bin/bash

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

require_jq
require_config

# Profile flag drives ENV_FILE / REMOTE_BASE / docker compose project name.
parse_profile_args "$@"
set -- "${REST_ARGS[@]}"

load_env
apply_port_slot

check_service() {
  local name="$1"
  local url="$2"

  local response
  if response=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null); then
    if [ "$response" = "200" ]; then
      log_ok "$name ($url)"
      return 0
    else
      log_warn "$name ($url) — HTTP $response"
      return 1
    fi
  else
    log_error "$name ($url) — unreachable"
    return 1
  fi
}

check_target() {
  local target="$1"
  shift
  local services=("$@")
  local host

  if is_local "$target"; then
    host="localhost"
  else
    host=$(host_from_target "$target")
  fi

  echo ""
  echo "=== $target ==="

  for svc in "${services[@]}"; do
    case "$svc" in
      "$SVC_BEE_UPLOADER")
        check_service "$SVC_BEE_UPLOADER" "http://$host:${BEE_UPLOADER_API_PORT:-$DEFAULT_BEE_UPLOADER_PORT}/health"
        ;;
      "$SVC_BEE_GATEWAY")
        check_service "$SVC_BEE_GATEWAY" "http://$host:${BEE_GATEWAY_API_PORT:-$DEFAULT_BEE_GATEWAY_PORT}/health"
        ;;
      "$SVC_UPLOADER")
        check_service "$SVC_UPLOADER" "http://$host:${API_PORT:-$DEFAULT_API_PORT}/health"
        ;;
      "$SVC_SRS")
        check_service "$SVC_SRS" "http://$host:${SRS_HTTP_PORT:-8080}"
        ;;
      "$SVC_CLIENT")
        check_service "$SVC_CLIENT" "http://$host:${CLIENT_PORT:-5173}/"
        ;;
    esac
  done

  # Show container status
  echo ""
  echo "  Containers:"
  local profiles compose_files project_flag
  profiles=$(build_profile_flags "${services[@]}")
  compose_files=$(build_compose_files "$DEPLOY_DIR")
  project_flag=$(compose_project_flag)
  if is_local "$target"; then
    # shellcheck disable=SC2086
    docker compose $project_flag $compose_files --env-file "$ENV_FILE" $profiles ps --format "    {{.Name}}: {{.Status}}" 2>/dev/null || echo "    (docker compose not available)"
  else
    local remote_compose_files
    remote_compose_files=$(build_compose_files "$REMOTE_BASE/deploy")
    ssh "$target" "cd $REMOTE_BASE/deploy && docker compose $project_flag $remote_compose_files --env-file $REMOTE_BASE/.env $profiles ps --format '    {{.Name}}: {{.Status}}'" 2>/dev/null || echo "    (unreachable)"
  fi
}

print_services

for target in $(get_targets); do
  services=($(get_services_for_target "$target"))
  check_target "$target" "${services[@]}"
done

echo ""
