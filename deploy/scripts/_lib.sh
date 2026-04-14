#!/bin/bash
# Shared constants and helpers for deploy scripts.
# Source this file — do not execute directly.

# --- Service names ---
readonly SVC_SRS="srs"
readonly SVC_UPLOADER="stream-uploader"
readonly SVC_BEE_UPLOADER="bee-uploader"
readonly SVC_BEE_GATEWAY="bee-gateway"
readonly ALL_SERVICES=("$SVC_BEE_UPLOADER" "$SVC_BEE_GATEWAY" "$SVC_UPLOADER" "$SVC_SRS")

# --- Targets ---
readonly TARGET_LOCAL="localhost"
readonly TARGET_NATIVE="native"
readonly TARGET_DISABLED="disabled"

# --- Paths ---
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
readonly ROOT_DIR="$(dirname "$DEPLOY_DIR")"
readonly CONFIG_FILE="$DEPLOY_DIR/config.json"
readonly ENV_FILE="$ROOT_DIR/.env"
readonly ENV_SAMPLE="$ROOT_DIR/.env.sample"
readonly REMOTE_BASE="~/swarm-hls-stream"

# --- Default ports ---
readonly DEFAULT_API_PORT=3000
readonly DEFAULT_BEE_UPLOADER_PORT=1633
readonly DEFAULT_BEE_GATEWAY_PORT=1733

# --- Colors ---
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly CYAN='\033[0;36m'
readonly NC='\033[0m'

# --- Dependency checks ---

require_jq() {
  if ! command -v jq &>/dev/null; then
    echo -e "${RED}ERROR: jq is required. Install: https://jqlang.github.io/jq/download/${NC}"
    exit 1
  fi
}

require_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}ERROR: $CONFIG_FILE not found.${NC}"
    echo "Copy config.sample.json to config.json and edit it:"
    echo "  cp $DEPLOY_DIR/config.sample.json $CONFIG_FILE"
    exit 1
  fi
}

require_env() {
  if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}ERROR: $ENV_FILE not found. Run setup.sh first.${NC}"
    exit 1
  fi
}

# --- Config helpers ---

# Get the target for a service from config.json.
# Returns "localhost", "user@host", or "false" (disabled).
get_target() {
  local service="$1"
  local value
  # Use `type` to distinguish false (boolean) from missing (null) from string
  value=$(jq -r ".services[\"$service\"] | if . == false then \"false\" elif . == null then \"localhost\" else tostring end" "$CONFIG_FILE")
  echo "$value"
}

is_enabled() {
  local target="$1"
  [ "$target" != "$TARGET_DISABLED" ] && [ "$target" != "null" ] && [ "$target" != "false" ]
}

is_local() {
  local target="$1"
  [ "$target" = "$TARGET_LOCAL" ]
}

# "native" means the service runs on the host machine outside Docker (e.g. `pnpm dev`).
# The deploy script skips it; SRS reaches it via host.docker.internal.
is_native() {
  local target="$1"
  [ "$target" = "$TARGET_NATIVE" ]
}

is_remote() {
  local target="$1"
  is_enabled "$target" && ! is_local "$target" && ! is_native "$target"
}

# Extract the real hostname/IP from a target.
# Handles "user@host", plain IPs, and SSH Host aliases.
host_from_target() {
  local target="$1"
  local host

  if [[ "$target" == *@* ]]; then
    host="${target#*@}"
  else
    host="$target"
  fi

  # If host looks like an IP or FQDN, use it directly.
  # Otherwise it's an SSH alias — resolve via ssh -G.
  if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || [[ "$host" == *.* ]]; then
    echo "$host"
  else
    local resolved
    resolved=$(ssh -G "$host" 2>/dev/null | awk '/^hostname / { print $2 }')
    echo "${resolved:-$host}"
  fi
}

# --- Service grouping ---

# Get unique enabled Docker targets from config (excludes "native" — those run outside compose).
get_targets() {
  local seen=()
  for svc in "${ALL_SERVICES[@]}"; do
    local target
    target=$(get_target "$svc")
    if is_enabled "$target" && ! is_native "$target"; then
      # Check if already seen
      local found=false
      for s in "${seen[@]}"; do
        [ "$s" = "$target" ] && found=true && break
      done
      if [ "$found" = "false" ]; then
        seen+=("$target")
        echo "$target"
      fi
    fi
  done
}

# Get services assigned to a specific target.
get_services_for_target() {
  local target="$1"
  for svc in "${ALL_SERVICES[@]}"; do
    local svc_target
    svc_target=$(get_target "$svc")
    if [ "$svc_target" = "$target" ]; then
      echo "$svc"
    fi
  done
}

# Build --profile flags for a list of services.
build_profile_flags() {
  local flags=""
  for svc in "$@"; do
    flags="$flags --profile $svc"
  done
  echo "$flags"
}

# Build compose file flags (-f). Adds overrides when COMPOSE_NETWORK=host or NAT addrs are set.
build_compose_files() {
  local base="$1"
  local flags="-f $base/docker-compose.yml"
  if [ "${COMPOSE_NETWORK:-}" = "host" ]; then
    flags="$flags -f $base/docker-compose.host.yml"
  fi
  if [ -n "${BEE_UPLOADER_NAT_ADDR:-}" ] || [ -n "${BEE_GATEWAY_NAT_ADDR:-}" ]; then
    flags="$flags -f $base/docker-compose.nat.yml"
  fi
  echo "$flags"
}

# --- Env helpers ---

# Load .env values into current shell.
load_env() {
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
}

# --- Validation ---

validate_config() {
  local srs_target uploader_target
  srs_target=$(get_target "$SVC_SRS")
  uploader_target=$(get_target "$SVC_UPLOADER")

  # SRS and stream-uploader must be co-located (shared media volume).
  # Exception: uploader="native" is allowed only when srs="localhost".
  if is_enabled "$srs_target" && is_enabled "$uploader_target"; then
    if is_native "$uploader_target"; then
      if ! is_local "$srs_target"; then
        echo -e "${RED}ERROR: stream-uploader=\"native\" requires srs=\"localhost\".${NC}"
        echo "Native mode only works when SRS runs on the same machine."
        exit 1
      fi
    elif [ "$srs_target" != "$uploader_target" ]; then
      echo -e "${RED}ERROR: srs and stream-uploader must be on the same target.${NC}"
      echo "They share the media volume for HLS segments."
      exit 1
    fi
  fi
}

# --- Output helpers ---

log_info() {
  echo -e "${CYAN}---${NC} $1"
}

log_ok() {
  echo -e "${GREEN}✓${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}!${NC} $1"
}

log_error() {
  echo -e "${RED}✗${NC} $1"
}

print_services() {
  echo ""
  echo "Deployment topology:"
  for svc in "${ALL_SERVICES[@]}"; do
    local target
    target=$(get_target "$svc")
    if is_native "$target"; then
      echo -e "  ${CYAN}◆${NC} $svc → native (host process)"
    elif is_enabled "$target"; then
      echo -e "  ${GREEN}●${NC} $svc → $target"
    else
      echo -e "  ${YELLOW}○${NC} $svc → disabled"
    fi
  done
  echo ""
}
