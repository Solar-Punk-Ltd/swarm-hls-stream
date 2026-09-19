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

# What the exit status at the bottom is made of.
#
# ⛔ Nothing kept these until 2026-09-16, and the last command in the file was an `echo`, so this
# command exited 0 whether every service answered or none of them did. `deploy.sh` ends by telling
# the operator to run it and `deploy/README.md` documents it as the way to check a stack, so the
# reader is as likely to be a scheduled job or a wrapper as a person, and a status is all either of
# those gets. The five red crosses on the terminal were correct the whole time.
SERVICES_CHECKED=0
SERVICES_FAILED=0

check_service() {
  local name="$1"
  local url="$2"

  SERVICES_CHECKED=$((SERVICES_CHECKED + 1))

  local response
  if response=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null); then
    if [ "$response" = "200" ]; then
      log_ok "$name ($url)"
      return 0
    fi
    log_warn "$name ($url): HTTP $response"
  else
    log_error "$name ($url): unreachable"
  fi

  SERVICES_FAILED=$((SERVICES_FAILED + 1))
  return 1
}

check_service_reachable() {
  local name="$1"
  local url="$2"

  SERVICES_CHECKED=$((SERVICES_CHECKED + 1))

  if curl -s -o /dev/null --max-time 5 "$url" 2>/dev/null; then
    log_ok "$name ($url)"
    return 0
  fi

  log_error "$name ($url): unreachable"
  SERVICES_FAILED=$((SERVICES_FAILED + 1))
  return 1
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

# An empty run is its own answer and it is not a good one. This file has no `set -e`, so a
# `config.json` that is present but is not valid JSON does not stop anything: `get_target`'s jq
# fails, every target comes back empty, `get_targets` prints nothing, this loop never runs, and a
# stack nobody looked at used to be indistinguishable from a healthy one.
if [ "$SERVICES_CHECKED" -eq 0 ]; then
  log_error "Nothing was checked, so this says nothing about the stack."
  echo "  Either every service is disabled in $CONFIG_FILE, or that file could not be read."
  echo "  Check it with: jq . $CONFIG_FILE"
  exit 1
fi

if [ "$SERVICES_FAILED" -gt 0 ]; then
  log_error "$SERVICES_FAILED of $SERVICES_CHECKED services are unhealthy."
  exit 1
fi

log_ok "All $SERVICES_CHECKED services are healthy."
