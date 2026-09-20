#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# shellcheck source=_lib.sh
source "$script_dir/_lib.sh"

require_jq
require_config

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  exec /bin/bash "$script_dir/deploy-standalone.sh" "$1"
fi

original_args=("$@")
parse_profile_args "$@"
set -- ${REST_ARGS[@]+"${REST_ARGS[@]}"}
require_env
load_env

for arg in "$@"; do
  add_service_filter "$arg" || {
    log_error "Unknown service: $arg"
    exit 1
  }
done

lease_targets=()
lease_kinds=()
lease_owners=()

release_mode() {
  local target="$1" command="$2" owner="${3:-}"
  if is_local "$target"; then
    /bin/bash "$script_dir/release-mode.sh" "$command" "$owner"
  else
    ssh "$target" bash -s -- "$command" "$owner" < "$script_dir/release-mode.sh"
  fi
}

finish_lease() {
  local index="$1"
  case "${lease_kinds[$index]}" in
    bootstrap) release_mode "${lease_targets[$index]}" finish-bootstrap "${lease_owners[$index]}" >/dev/null ;;
    guard) release_mode "${lease_targets[$index]}" finish-guard "${lease_owners[$index]}" >/dev/null ;;
  esac
}

finish_all_leases() {
  local index
  for ((index = 0; index < ${#lease_targets[@]}; index++)); do
    finish_lease "$index"
  done
}

for target in $(get_targets); do
  services=($(get_filtered_services_for_target "$target"))
  [ ${#services[@]} -gt 0 ] || continue

  if ! mode="$(release_mode "$target" begin)"; then
    finish_all_leases
    exit 1
  fi
  case "$mode" in
    managed)
      finish_all_leases
      log_error "This installation requires the installed streaming-release-guard uploader or viewer command."
      log_error "Raw deploy.sh cannot move a managed installation."
      exit 1
      ;;
    bootstrap:*|guard:*)
      lease_targets+=("$target")
      lease_kinds+=("${mode%%:*}")
      lease_owners+=("${mode#*:}")
      ;;
    *)
      finish_all_leases
      log_error "Release mode returned an invalid deployment decision."
      exit 1
      ;;
  esac
done

if [ "${SRS_LIFECYCLE_VERSION:-}" = "1" ]; then
  finish_all_leases
  log_error "Managed lifecycle activation requires the external release guard."
  log_error "Use the installed streaming-release-guard uploader command through the deployment manager."
  exit 1
fi

if /bin/bash "$script_dir/deploy-standalone.sh" ${original_args[@]+"${original_args[@]}"}; then
  finish_all_leases
else
  status=$?
  log_error "Standalone deployment did not finish. Its release lease remains for operator recovery."
  exit "$status"
fi
