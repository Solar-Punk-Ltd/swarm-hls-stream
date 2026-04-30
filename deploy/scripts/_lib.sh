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
readonly ENV_SAMPLE="$ROOT_DIR/.env.sample"

# --- Profile (deployment instance) ---
# Set by parse_profile_args; defaults to "default".
# - PROFILE         logical name, used as docker compose project name
# - ENV_FILE        $ROOT_DIR/.env for default; $ROOT_DIR/.env.<profile> otherwise.
#                   The non-default file is REQUIRED — require_env errors if it is missing
#                   so a typo in --profile= doesn't silently deploy the wrong stack.
# - REMOTE_BASE     ~/swarm-hls-stream for default, ~/swarm-hls-stream-<profile> otherwise
# - PORT_PREFIX     integer offset added to every host-mapped port (0 = no shift).
#                   Lets a profile reuse the base ports from .env without listing each one.
PROFILE="default"
ENV_FILE="$ROOT_DIR/.env"
REMOTE_BASE="~/swarm-hls-stream"
PORT_PREFIX=0

# Populated by parse_profile_args with the argv minus the --profile / --portPrefix flags.
REST_ARGS=()

# Ports that get shifted by PORT_PREFIX when apply_port_prefix runs.
# Defaults match docker-compose.yml `:-NNNN` fallbacks and .env.sample.
readonly PORT_VARS=(
  "BEE_UPLOADER_API_PORT:1633"
  "BEE_UPLOADER_P2P_PORT:1634"
  "BEE_GATEWAY_API_PORT:1733"
  "BEE_GATEWAY_P2P_PORT:1734"
  "API_PORT:3000"
  "SRS_SRT_PORT:10080"
  "SRS_RTMP_PORT:1935"
  "SRS_HTTP_PORT:8080"
)

# Parse profile + portPrefix flags from argv.
# Accepted: --profile=<n>, --profile <n>, --portPrefix=<N>, --portPrefix <N>
# Caller pattern:
#   parse_profile_args "$@"
#   set -- "${REST_ARGS[@]}"
# Side effects: sets PROFILE, ENV_FILE, REMOTE_BASE, PORT_PREFIX, REST_ARGS globals.
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
      --portPrefix=*)
        PORT_PREFIX="${1#*=}"
        shift
        ;;
      --portPrefix)
        if [ $# -lt 2 ]; then
          echo -e "${RED}ERROR: --portPrefix requires a value${NC}" >&2
          exit 1
        fi
        PORT_PREFIX="$2"
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

  # PORT_PREFIX is prepended to default ports as a string ("2" + "1633" = "21633").
  # 0 = no prefix. Restrict to 1-9 — multi-digit prefixes push 5-digit defaults
  # (SRS_SRT_PORT=10080) past 65535.
  if ! [[ "$PORT_PREFIX" =~ ^[0-9]$ ]]; then
    echo -e "${RED}ERROR: --portPrefix must be a single digit 0-9 (got: $PORT_PREFIX)${NC}" >&2
    exit 1
  fi

  if [ "$PROFILE" != "default" ]; then
    ENV_FILE="$ROOT_DIR/.env.$PROFILE"
    REMOTE_BASE="~/swarm-hls-stream-$PROFILE"
  fi
}

# Holds KEY=VALUE\n lines for ports that apply_port_prefix has resolved (either prefixed
# defaults, or just defaults). Written into the docker-compose override env file so the
# values are guaranteed to reach compose's interpolation regardless of `--env-file` quirks.
PORT_OVERRIDES_TEXT=""

# Apply PORT_PREFIX to PORT_VARS that aren't already set in the env file.
# Rule: explicit env values win. Where the env doesn't set a port, the value becomes
# "${PORT_PREFIX}${default}" (string prepend) — e.g. PORT_PREFIX=2 + default 1633 = 21633.
# PORT_PREFIX=0 leaves defaults untouched (compose's `${VAR:-default}` then takes over).
# Runs after load_env so .env.<profile> values are visible as overrides.
# Also keeps SRS_ADAPTER_PORT in lock-step with the resolved API_PORT.
apply_port_prefix() {
  local entry name default current shifted
  PORT_OVERRIDES_TEXT=""
  for entry in "${PORT_VARS[@]}"; do
    name="${entry%%:*}"
    default="${entry##*:}"
    current="${!name:-}"

    # Env file already set this port explicitly — honor it, no prefix.
    if [ -n "$current" ]; then
      continue
    fi

    if [ "$PORT_PREFIX" = "0" ]; then
      shifted="$default"
    else
      shifted="${PORT_PREFIX}${default}"
    fi

    if ! [[ "$shifted" =~ ^[1-9][0-9]*$ ]]; then
      echo -e "${RED}ERROR: computed $name=$shifted is not a valid port${NC}" >&2
      exit 1
    fi
    if [ "$shifted" -gt 65535 ]; then
      echo -e "${RED}ERROR: ${name}=${shifted} exceeds 65535. Set ${name} explicitly in $ENV_FILE or use a smaller --portPrefix.${NC}" >&2
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
  echo "Profile: $PROFILE  (env: $ENV_FILE)"
  if [ "$PORT_PREFIX" != "0" ]; then
    echo "Port prefix: \"$PORT_PREFIX\" (prepended to defaults; explicit env values win)"
    echo "  bee-uploader  api=${BEE_UPLOADER_API_PORT:-?}  p2p=${BEE_UPLOADER_P2P_PORT:-?}"
    echo "  bee-gateway   api=${BEE_GATEWAY_API_PORT:-?}  p2p=${BEE_GATEWAY_P2P_PORT:-?}"
    echo "  stream-uplder api=${API_PORT:-?}"
    echo "  srs           srt=${SRS_SRT_PORT:-?}  rtmp=${SRS_RTMP_PORT:-?}  http=${SRS_HTTP_PORT:-?}"
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
