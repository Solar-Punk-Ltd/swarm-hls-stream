#!/bin/bash
# Shared constants and helpers for deploy scripts.
# Source this file — do not execute directly.

# --- Service names ---
readonly SVC_SRS="srs"
readonly SVC_UPLOADER="stream-uploader"
readonly SVC_BEE_UPLOADER="bee-uploader"
readonly SVC_BEE_GATEWAY="bee-gateway"
readonly SVC_CLIENT="client"
readonly ALL_SERVICES=("$SVC_BEE_UPLOADER" "$SVC_BEE_GATEWAY" "$SVC_UPLOADER" "$SVC_SRS" "$SVC_CLIENT")

# --- Targets ---
readonly TARGET_LOCAL="localhost"
readonly TARGET_NATIVE="native"
readonly TARGET_DISABLED="disabled"

# --- Paths ---
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
readonly ROOT_DIR="$(dirname "$DEPLOY_DIR")"
readonly CONFIG_FILE="$DEPLOY_DIR/config.json"
readonly ENV_SAMPLE="$ROOT_DIR/.env.sample"

# --- Profile (deployment instance) ---
# Set by parse_profile_args; defaults to "default".
# - PROFILE         logical name, used as docker compose project name
# - ENV_FILE        $ROOT_DIR/.env for default; $ROOT_DIR/.env.<profile> otherwise.
#                   The non-default file is REQUIRED — require_env errors if it is missing
#                   so a typo in --profile= doesn't silently deploy the wrong stack.
# - REMOTE_BASE     ~/swarm-hls-stream for default, ~/swarm-hls-stream-<profile> otherwise
# - PORT_SLOT       integer slot id (0-999). 0 = no slot, env values win.
#                   For slot N>=1, every host-mapped port becomes default + N*10,
#                   yielding non-overlapping bands of 10 ports per slot in the
#                   10000-19999 range. See apply_port_slot.
PROFILE="default"
ENV_FILE="$ROOT_DIR/.env"
REMOTE_BASE="~/swarm-hls-stream"
PORT_SLOT=0

# When set via --host, every enabled service in config.json is redirected to this
# target (an ssh alias, user@host, or "localhost"). Disabled services (false) stay
# disabled. Useful for one-shot deploys to an arbitrary host without editing config.json.
HOST_OVERRIDE=""

# Populated by parse_profile_args with the argv minus the --profile / --portSlot flags.
REST_ARGS=()

# Base ports (slot 0). Each service occupies a unique last digit (0-8) so
# apply_port_slot can compute `base + slot*10` without collisions across services.
# Defaults match docker-compose.yml `:-NNNN` fallbacks and .env.sample.
readonly PORT_VARS=(
  "API_PORT:10000"
  "SRS_SRT_PORT:10001"
  "SRS_RTMP_PORT:10002"
  "SRS_HTTP_PORT:10003"
  "CLIENT_PORT:10004"
  "BEE_UPLOADER_API_PORT:10005"
  "BEE_UPLOADER_P2P_PORT:10006"
  "BEE_GATEWAY_API_PORT:10007"
  "BEE_GATEWAY_P2P_PORT:10008"
)

# Parse profile + portSlot flags from argv.
# Accepted: --profile=<n>, --profile <n>, --portSlot=<N>, --portSlot <N>
# Caller pattern:
#   parse_profile_args "$@"
#   set -- "${REST_ARGS[@]}"
# Side effects: sets PROFILE, ENV_FILE, REMOTE_BASE, PORT_SLOT, REST_ARGS globals.
parse_profile_args() {
  REST_ARGS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile=*)
        PROFILE="${1#*=}"
        shift
        ;;
      --profile)
        if [ $# -lt 2 ]; then
          echo -e "${RED}ERROR: --profile requires a value${NC}" >&2
          exit 1
        fi
        PROFILE="$2"
        shift 2
        ;;
      --portSlot=*)
        PORT_SLOT="${1#*=}"
        shift
        ;;
      --portSlot)
        if [ $# -lt 2 ]; then
          echo -e "${RED}ERROR: --portSlot requires a value${NC}" >&2
          exit 1
        fi
        PORT_SLOT="$2"
        shift 2
        ;;
      --host=*)
        HOST_OVERRIDE="${1#*=}"
        shift
        ;;
      --host)
        if [ $# -lt 2 ]; then
          echo -e "${RED}ERROR: --host requires a value${NC}" >&2
          exit 1
        fi
        HOST_OVERRIDE="$2"
        shift 2
        ;;
      *)
        REST_ARGS+=("$1")
        shift
        ;;
    esac
  done

  if ! [[ "$PROFILE" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]]; then
    echo -e "${RED}ERROR: invalid profile name: $PROFILE${NC}" >&2
    echo "Profile must match ^[a-z0-9][a-z0-9-]{0,30}$" >&2
    exit 1
  fi

  # PORT_SLOT shifts each default by slot*10 (so slot 1 → 10010-10018,
  # slot 999 → 19990-19998). Restrict to 0-999 to stay within TCP range.
  if ! [[ "$PORT_SLOT" =~ ^[0-9]{1,3}$ ]]; then
    echo -e "${RED}ERROR: --portSlot must be an integer 0-999 (got: $PORT_SLOT)${NC}" >&2
    exit 1
  fi

  if [ "$PROFILE" != "default" ]; then
    ENV_FILE="$ROOT_DIR/.env.$PROFILE"
    REMOTE_BASE="~/swarm-hls-stream-$PROFILE"
  fi
}

# Holds KEY=VALUE\n lines for ports that apply_port_slot has resolved (either slot-shifted
# defaults, or just defaults). Written into the docker-compose override env file so the
# values are guaranteed to reach compose's interpolation regardless of `--env-file` quirks.
PORT_OVERRIDES_TEXT=""

# Resolve every PORT_VAR and write the chosen value into PORT_OVERRIDES_TEXT
# (which deploy.sh injects into .env.deploy as a 2nd --env-file for compose).
#
# Rule:
#   - PORT_SLOT=0 (no --portSlot flag): keep env values; only fill the
#     unset ports with their built-in default.
#   - PORT_SLOT=1-999: AUTHORITATIVE — every port becomes default + slot*10,
#     regardless of any value in .env.<profile>. This avoids surprises where a
#     hand-edited port in the env file silently survives the slot shift.
#
# Also keeps SRS_ADAPTER_PORT in lock-step with the resolved API_PORT.
apply_port_slot() {
  local entry name default current shifted
  PORT_OVERRIDES_TEXT=""
  for entry in "${PORT_VARS[@]}"; do
    name="${entry%%:*}"
    default="${entry##*:}"
    current="${!name:-}"

    if [ "$PORT_SLOT" = "0" ]; then
      if [ -n "$current" ]; then
        continue
      fi
      shifted="$default"
    else
      shifted=$((default + PORT_SLOT * 10))
    fi

    if ! [[ "$shifted" =~ ^[1-9][0-9]*$ ]]; then
      echo -e "${RED}ERROR: computed $name=$shifted is not a valid port${NC}" >&2
      exit 1
    fi
    if [ "$shifted" -gt 65535 ]; then
      echo -e "${RED}ERROR: ${name}=${shifted} exceeds 65535. Lower --portSlot or set ${name} explicitly (omit --portSlot to use env values).${NC}" >&2
      exit 1
    fi
    export "$name=$shifted"
    PORT_OVERRIDES_TEXT+="${name}=${shifted}\n"
  done

  # SRS webhook target — mirrors the resolved API port (env or prefixed default).
  if [ -n "${API_PORT:-}" ]; then
    export SRS_ADAPTER_PORT="$API_PORT"
    PORT_OVERRIDES_TEXT+="SRS_ADAPTER_PORT=${API_PORT}\n"
  fi
}

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
    if [ "$PROFILE" != "default" ]; then
      echo -e "${RED}ERROR: $ENV_FILE not found.${NC}" >&2
      echo "Profile '$PROFILE' requires $ROOT_DIR/.env.$PROFILE" >&2
      echo "Copy and edit:" >&2
      echo "  cp $ROOT_DIR/.env $ROOT_DIR/.env.$PROFILE" >&2
      echo "Then change ports / STAMP / STREAM_KEY / data dirs for this profile." >&2
    else
      echo -e "${RED}ERROR: $ENV_FILE not found. Run setup.sh first.${NC}" >&2
    fi
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
  # --host overrides the config target for every enabled service.
  # Disabled services (false) remain disabled.
  if [ -n "$HOST_OVERRIDE" ] && [ "$value" != "false" ]; then
    echo "$HOST_OVERRIDE"
    return
  fi
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

# Compose project flag (-p <profile>) — namespaces containers/volumes per profile.
compose_project_flag() {
  echo "-p $PROFILE"
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
  local srs_target uploader_target client_target gateway_target
  srs_target=$(get_target "$SVC_SRS")
  uploader_target=$(get_target "$SVC_UPLOADER")
  client_target=$(get_target "$SVC_CLIENT")
  gateway_target=$(get_target "$SVC_BEE_GATEWAY")

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

  # client and bee-gateway must be co-located — the client's nginx proxies /bee/
  # to the bee-gateway service via docker DNS, which only resolves within the same
  # compose project / network.
  if is_enabled "$client_target" && is_enabled "$gateway_target"; then
    if [ "$client_target" != "$gateway_target" ]; then
      echo -e "${RED}ERROR: client and bee-gateway must be on the same target.${NC}"
      echo "The client container proxies /bee/ to bee-gateway over the compose network."
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
  echo "Profile: $PROFILE  (env: $ENV_FILE)"
  if [ -n "$HOST_OVERRIDE" ]; then
    echo "Host override: $HOST_OVERRIDE  (config.json targets ignored for enabled services)"
  fi
  if [ "$PORT_SLOT" != "0" ]; then
    echo "Port slot: $PORT_SLOT (defaults shifted by slot*10; authoritative — env values ignored)"
    echo "  bee-uploader  api=${BEE_UPLOADER_API_PORT:-?}  p2p=${BEE_UPLOADER_P2P_PORT:-?}"
    echo "  bee-gateway   api=${BEE_GATEWAY_API_PORT:-?}  p2p=${BEE_GATEWAY_P2P_PORT:-?}"
    echo "  stream-uplder api=${API_PORT:-?}"
    echo "  srs           srt=${SRS_SRT_PORT:-?}  rtmp=${SRS_RTMP_PORT:-?}  http=${SRS_HTTP_PORT:-?}"
    echo "  client        http=${CLIENT_PORT:-?}"
  fi
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
