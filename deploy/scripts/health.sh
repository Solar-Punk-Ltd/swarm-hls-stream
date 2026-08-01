#!/bin/bash

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

require_jq
require_config

# Profile flag drives ENV_FILE / REMOTE_BASE / docker compose project name.
parse_profile_args "$@"
set -- "${REST_ARGS[@]}"

for arg in "$@"; do
  add_service_filter "$arg" || {
    echo "Usage: health.sh [--profile=<name>] [service...]"
    echo "Services: ${ALL_SERVICES[*]}"
    exit 1
  }
done

load_env
load_engine_envs
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

check_service_reachable() {
  local name="$1"
  local url="$2"

  if curl -s -o /dev/null --max-time 5 "$url" 2>/dev/null; then
    log_ok "$name ($url)"
    return 0
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
      "$SVC_OME")
        check_service_reachable "$SVC_OME" "http://$host:${OME_HLS_PORT:-8081}"
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
    # SC2046 alongside SC2086: `env_file_flag` emits two words or none, and the splitting is the
    # point. Quoting it would send compose an empty argument when the profile has no env file.
    # shellcheck disable=SC2086,SC2046
    docker compose $project_flag $compose_files $(env_file_flag) $profiles ps --format "    {{.Name}}: {{.Status}}" 2>/dev/null || echo "    (docker compose not available)"
  else
    local remote_compose_files
    remote_compose_files=$(build_compose_files "$REMOTE_BASE/deploy")
    ssh "$target" "cd $REMOTE_BASE/deploy && docker compose $project_flag $remote_compose_files --env-file $REMOTE_BASE/.env $profiles ps --format '    {{.Name}}: {{.Status}}'" 2>/dev/null || echo "    (unreachable)"
  fi
}

print_services

for target in $(get_targets); do
  services=($(get_filtered_services_for_target "$target"))
  [ ${#services[@]} -eq 0 ] && continue
  check_target "$target" "${services[@]}"
done

echo ""
