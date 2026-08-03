#!/bin/bash
# Shared constants and helpers for deploy scripts.
# Source this file — do not execute directly.

# --- Service names ---
readonly SVC_SRS="srs"
readonly SVC_OME="ome"
readonly SVC_UPLOADER="stream-uploader"
readonly SVC_BEE_UPLOADER="bee-uploader"
readonly SVC_BEE_GATEWAY="bee-gateway"
readonly SVC_CLIENT="client"
readonly ALL_SERVICES=("$SVC_BEE_UPLOADER" "$SVC_BEE_GATEWAY" "$SVC_UPLOADER" "$SVC_SRS" "$SVC_OME" "$SVC_CLIENT")

readonly DEFAULT_DISABLED_SERVICES=("$SVC_OME")

# --- Targets ---
readonly TARGET_LOCAL="localhost"
readonly TARGET_NATIVE="native"
readonly TARGET_DISABLED="disabled"

# --- Paths ---
# Assigned before `readonly` rather than with it: `readonly X=$(...)` takes the exit status of the
# `readonly`, not of the command substitution, so a failing `cd` would go unnoticed. (SC2155)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$DEPLOY_DIR")"
readonly SCRIPT_DIR DEPLOY_DIR ROOT_DIR
readonly CONFIG_FILE="$DEPLOY_DIR/config.json"
readonly ENV_SAMPLE="$ROOT_DIR/.env.sample"

# --- Profile (deployment instance) ---
# Set by parse_profile_args; defaults to "default".
# - PROFILE         logical name, used as docker compose project name
# - ENV_FILE        $ROOT_DIR/.env for default; $ROOT_DIR/.env.<profile> otherwise.
#                   The non-default file is REQUIRED — parse_profile_args errors if it is
#                   missing so a typo in --profile= doesn't silently deploy the wrong stack.
# - REMOTE_BASE     ~/swarm-hls-stream for default, ~/swarm-hls-stream-<profile> otherwise
# - PORT_SLOT       integer slot id (0-999). 0 = no slot, env values win.
#                   For slot N>=1, every host-mapped port becomes default + N*10,
#                   yielding non-overlapping bands of 10 ports per slot in the
#                   10000-19999 range. See apply_port_slot.
PROFILE="default"
ENV_FILE="$ROOT_DIR/.env"
REMOTE_BASE="~/swarm-hls-stream"
PORT_SLOT=0

# Per-deployment parameter overrides. Set by parse_profile_args from CLI flags
# (--host / --feed-owner / --feed-topic / --private-key / --stamp-id). When non-empty,
# they take precedence over the matching keys in .env.<profile> during deploy
# (see generate_env_overrides in deploy.sh).
HOST_OVERRIDE="" # target (an ssh alias, user@host, or "localhost").
FEED_OWNER_OVERRIDE=""
FEED_TOPIC_OVERRIDE=""
PRIVATE_KEY_OVERRIDE=""
STAMP_ID_OVERRIDE=""

# Populated by parse_profile_args with the argv minus the --profile / --portSlot flags.
REST_ARGS=()

# Host ports, as `NAME:stock:base`.
#
# The two numbers are different questions and used to be one. `stock` is what a plain deploy falls
# back to when the variable is unset, and it matches the `${NAME:-NNNN}` fallback in the compose file
# that publishes it. `base` is the origin of the `base + slot*10` arithmetic, where each service
# holds a unique last digit (0-8) so slots cannot collide.
#
# Collapsing them hid a real divergence for seven of the nine, because `apply_port_slot` leaves an
# already-set variable alone at slot 0 and those seven carry a value in `.env.sample`. SRS_RTMP_PORT
# and SRS_HTTP_PORT carry none, in `.env.sample` or `engines/srs/.env.sample`, so a stock deploy took
# 10002 and 10003 from the arithmetic origin while `engines/srs/docker-compose.yml` documents 1935
# and 8080. Since d6394a3 passed these into SRS's own config, that is what SRS bound: consistent end
# to end, and not what the ports are documented as, so an operator opening 1935 for a broadcaster
# opened a port nothing listened on. Filed as OPS-27.
readonly PORT_VARS=(
  "API_PORT:3000:10000"
  "SRS_SRT_PORT:10080:10001"
  "SRS_RTMP_PORT:1935:10002"
  "SRS_HTTP_PORT:8080:10003"
  "CLIENT_PORT:5173:10004"
  "BEE_UPLOADER_API_PORT:1633:10005"
  "BEE_UPLOADER_P2P_PORT:1634:10006"
  "BEE_GATEWAY_API_PORT:1733:10007"
  "BEE_GATEWAY_P2P_PORT:1734:10008"
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
      --feed-owner=*)
        FEED_OWNER_OVERRIDE="${1#*=}"
        shift
        ;;
      --feed-owner)
        if [ $# -lt 2 ]; then
          echo -e "${RED}ERROR: --feed-owner requires a value${NC}" >&2
          exit 1
        fi
        FEED_OWNER_OVERRIDE="$2"
        shift 2
        ;;
      --feed-topic=*)
        FEED_TOPIC_OVERRIDE="${1#*=}"
        shift
        ;;
      --feed-topic)
        if [ $# -lt 2 ]; then
          echo -e "${RED}ERROR: --feed-topic requires a value${NC}" >&2
          exit 1
        fi
        FEED_TOPIC_OVERRIDE="$2"
        shift 2
        ;;
      --private-key=*)
        PRIVATE_KEY_OVERRIDE="${1#*=}"
        shift
        ;;
      --private-key)
        if [ $# -lt 2 ]; then
          echo -e "${RED}ERROR: --private-key requires a value${NC}" >&2
          exit 1
        fi
        PRIVATE_KEY_OVERRIDE="$2"
        shift 2
        ;;
      --stamp-id=*)
        STAMP_ID_OVERRIDE="${1#*=}"
        shift
        ;;
      --stamp-id)
        if [ $# -lt 2 ]; then
          echo -e "${RED}ERROR: --stamp-id requires a value${NC}" >&2
          exit 1
        fi
        STAMP_ID_OVERRIDE="$2"
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

  # A named profile always points at its OWN env file, present or not. The old fallback to the
  # default `.env` did not merely lose this profile's settings, it silently adopted the default
  # deployment's ports, STAMP and STREAM_KEY, so `--profile=streamr1` brought up a second stack
  # fighting the first one for the same port range. See OPS-4.
  #
  # Missing is a warning here and a refusal in `require_env`, which only `deploy.sh` calls, because
  # the two cases are genuinely different. Deploying without the profile's settings is the harm.
  # Stopping, cleaning and health-checking need no env at all: those containers are identified by
  # the compose project name, and refusing here stranded a running stack whose env file had been
  # deleted, or that was being torn down from a fresh clone of the deploy host.
  if [ "$PROFILE" != "default" ]; then
    ENV_FILE="$ROOT_DIR/.env.$PROFILE"
    REMOTE_BASE="~/swarm-hls-stream-$PROFILE"
    if [ ! -f "$ENV_FILE" ]; then
      log_warn "Profile '$PROFILE' has no $ENV_FILE, so nothing from it is loaded."
      log_warn "Create it with: cp $ROOT_DIR/.env.sample $ENV_FILE"
    fi
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
  local entry name stock base current shifted rest
  PORT_OVERRIDES_TEXT=""
  for entry in "${PORT_VARS[@]}"; do
    name="${entry%%:*}"
    rest="${entry#*:}"
    stock="${rest%%:*}"
    base="${rest##*:}"
    current="${!name:-}"

    if [ "$PORT_SLOT" = "0" ]; then
      if [ -n "$current" ]; then
        continue
      fi
      shifted="$stock"
    else
      shifted=$((base + PORT_SLOT * 10))
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

# Emit KEY=VALUE\n lines for every per-deployment parameter override that was
# supplied on the command line. Empty overrides are skipped so the .env value
# wins. Mapping (CLI flag → docker .env key):
#   --feed-owner   → VITE_APP_OWNER       (0x prefix stripped — viewer build expects raw hex)
#   --feed-topic   → STREAM_LIST_TOPIC, VITE_APP_RAW_TOPIC
#   --private-key  → STREAM_KEY
#   --stamp-id     → STAMP                (0x prefix stripped — bee expects raw hex)
parameter_overrides_text() {
  local out=""
  if [ -n "$FEED_OWNER_OVERRIDE" ]; then
    out+="VITE_APP_OWNER=${FEED_OWNER_OVERRIDE#0x}\n"
  fi
  if [ -n "$FEED_TOPIC_OVERRIDE" ]; then
    out+="STREAM_LIST_TOPIC=${FEED_TOPIC_OVERRIDE}\n"
    out+="VITE_APP_RAW_TOPIC=${FEED_TOPIC_OVERRIDE}\n"
  fi
  if [ -n "$PRIVATE_KEY_OVERRIDE" ]; then
    out+="STREAM_KEY=${PRIVATE_KEY_OVERRIDE}\n"
  fi
  if [ -n "$STAMP_ID_OVERRIDE" ]; then
    out+="STAMP=${STAMP_ID_OVERRIDE#0x}\n"
  fi
  printf '%s' "$out"
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

# The `--env-file` flag for compose, omitted when the file is absent.
#
# Compose refuses to start at all when pointed at a missing env file, and a teardown does not need
# one: the containers belong to the compose project, which `-p` names. Without this, requiring a
# profile's env file would have made a profile whose file was deleted impossible to stop or clean.
env_file_flag() {
  if [ -f "$ENV_FILE" ]; then
    echo "--env-file $ENV_FILE"
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
  local value svc
  # Use `type` to distinguish false (boolean) from missing (null) from string
  value=$(jq -r ".services[\"$service\"] | if . == false then \"false\" elif . == null then \"missing\" else tostring end" "$CONFIG_FILE")
  if [ "$value" = "missing" ]; then
    value="localhost"
    for svc in "${DEFAULT_DISABLED_SERVICES[@]}"; do
      [ "$svc" = "$service" ] && value="false" && break
    done
  fi
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

# --- Service filter ---

# Services named on the command line. Empty means the operator asked about the whole target, which
# is not the same as asking about nothing: every consumer treats empty as "all", so a filter that
# failed to populate widens the command rather than narrowing it.
FILTER_SERVICES=()

# Append one argv entry to FILTER_SERVICES, or report an unknown service name and return 1 so the
# caller can print its own usage before exiting. Compose reads an unknown `--profile` as "select no
# services" and exits 0, so a typo that reached it would report success while the service the
# operator named kept running. See OPS-3.
add_service_filter() {
  local arg="$1" svc
  for svc in "${ALL_SERVICES[@]}"; do
    if [ "$arg" = "$svc" ]; then
      FILTER_SERVICES+=("$arg")
      return 0
    fi
  done
  log_error "Unknown service: $arg"
  return 1
}

is_in_filter() {
  local svc="$1" f
  if [ ${#FILTER_SERVICES[@]} -eq 0 ]; then
    return 0
  fi
  for f in "${FILTER_SERVICES[@]}"; do
    [ "$f" = "$svc" ] && return 0
  done
  return 1
}

get_filtered_services_for_target() {
  local target="$1" svc
  for svc in $(get_services_for_target "$target"); do
    if is_in_filter "$svc"; then
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

# Load KEY=VALUE lines from a file into the current shell. Each value is
# treated as a DEFAULT — anything already exported by the caller wins.
load_env_file() {
  local _env_file="$1"
  if [ -f "$_env_file" ]; then
    set -a
    local _env_line _env_key _env_value
    while IFS= read -r _env_line || [ -n "$_env_line" ]; do
      case "$_env_line" in
        ''|\#*) continue ;;
      esac
      _env_key="${_env_line%%=*}"
      if ! [[ "$_env_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        continue
      fi
      # `declare -p` rather than `${!key+x}`, because an EMPTY ARRAY reads as unset to the second
      # one. Every array this library declares up front is empty at this point, so a `.env` line
      # naming one used to claim its first element: `FILTER_SERVICES=client` in a `.env` made
      # `stop.sh` with no arguments stop only `client` and still print "All services stopped", and
      # in `clean.sh`, which loads the env before parsing argv, the same element reached the
      # unquoted remote heredoc and ran as a command on the deployment host.
      #
      # This also covers the readonly constants, which `export` would have failed on rather than
      # skipped. The locals above are `_env_`-prefixed so a `.env` key cannot collide with them and
      # be skipped for the wrong reason.
      if declare -p "$_env_key" &>/dev/null; then
        continue
      fi
      # Take the value literally (no eval — secrets may contain $, !, #, ...).
      # Quoted values run to the closing quote; unquoted values end at an
      # inline comment (whitespace + #, dotenv-style) with whitespace trimmed.
      _env_value="${_env_line#*=}"
      case "$_env_value" in
        \"*) _env_value="${_env_value#\"}"; _env_value="${_env_value%%\"*}" ;;
        \'*) _env_value="${_env_value#\'}"; _env_value="${_env_value%%\'*}" ;;
        *)
          _env_value="${_env_value%%[[:space:]]\#*}"
          _env_value="${_env_value%"${_env_value##*[![:space:]]}"}"
          ;;
      esac
      export "$_env_key=$_env_value"
    done < "$_env_file"
    set +a
  fi
}

load_env() {
  load_env_file "$ENV_FILE"
}

# --- Shell quoting ---

# Wrap a value so another shell reads it as a single literal word, for the strings that have to
# survive a trip through one: an `ssh` command line, or a file the far side will `source`.
#
# POSIX single-quoting (close the quote, escape, reopen) rather than bash's `printf %q`, because the
# shell on the other side is whatever login shell the deployment account has.
#
# The replacement is built in a variable on purpose, and the two shorter spellings are both wrong on
# bash 3.2, which is what `#!/bin/bash` resolves to on macOS. Measured on 3.2.57 against 5.x:
#
#   ${1//\'/\'\\\'\'}       needs a second round of backslash removal that 3.2 does not do. Emits an
#                           unbalanced word, so the receiving shell dies on `unexpected EOF`.
#   ${1//\'/"'\\''"}        looks like the fix, and fails silently instead of loudly: no syntax
#                           error, and 80 of 180 sampled inputs parse back to the wrong bytes.
#
# The first is the one that is dangerous rather than merely wrong. A value ending in a backslash eats
# the wrapper's own closing quote, which rebalances the word and leaves a substitution before it
# outside every quote, so the receiving shell runs it. Found by brute force on 3.2, none on 5.x.
#
# The form below round-trips every one of those inputs byte for byte on both versions.
shell_quote() {
  local escaped_quote="'\\''"
  printf "'%s'" "${1//\'/$escaped_quote}"
}

# --- Publish keys ---

# The publish key for one stream id, derived from the master secret. See SEC-28.
#
# Must agree byte for byte with `derivePublishKey` in packages/stream-uploader/src/utils/publishKey.ts,
# because the service recomputes it and compares. Pinned to one golden vector, asserted here in
# deploy/test/publishKey.test.js and there in publishKey.test.ts, so either side drifting fails a test.
#
# **The secret goes in through the environment and never through argv**, which is the whole reason
# this is `node` and not the shorter `openssl dgst -hmac "$secret"`. openssl offers no way to take an
# HMAC key from anywhere but its command line, and a command line is world-readable: any unprivileged
# local user, or a container sharing the host PID namespace, reads it out of /proc/<pid>/cmdline, and
# execve auditing captures it deterministically. One master secret is every stream's key forever,
# since there is no per-stream revocation, so a momentary argv exposure is a permanent compromise.
#
# Using node also removes two disagreements the openssl form had with the service. The exit status is
# the interpreter's rather than the last stage of a four-command pipeline, so a failure is a failure
# instead of an empty key reported as success. And the length check counts the same units the service
# counts: bash's `${#var}` is bytes under LC_ALL=C and characters under a UTF-8 locale, neither of
# which is the UTF-16 code units `String.length` uses, so a non-ASCII secret could pass here and
# throw at service startup.
#
# node is a fair requirement: this runs where the operator's env file is, `deploy.sh` does not ship
# `config.json` to a remote target so it cannot run there anyway, and every other task in this repo
# already needs pnpm.
derive_publish_key() {
  local stream_id="$1"

  PUBLISH_KEY_SECRET="${PUBLISH_KEY_SECRET:-}" node -e '
    const { createHmac } = require("node:crypto");
    const secret = process.env.PUBLISH_KEY_SECRET || "";
    if (secret.length < 32) {
      console.error("PUBLISH_KEY_SECRET must be at least 32 characters, which is what the service enforces at startup");
      process.exit(1);
    }
    process.stdout.write(createHmac("sha256", secret).update(process.argv[1], "utf8").digest("hex").slice(0, 32));
  ' "$stream_id"
}

# --- Bee data dirs ---

readonly DEFAULT_BEE_UPLOADER_DATA_DIR="./data/bee-uploader"
readonly DEFAULT_BEE_GATEWAY_DATA_DIR="./data/bee-gateway"

# Refuse a bee data dir that the operator's `.env` cannot be trusted to have meant.
#
# This character check is the layer that carries the safety, not `shell_quote`, and it is worth being
# exact about that: the value reaches an `ssh` command line, `shell_quote` wraps it, and the quoting
# was itself wrong on bash 3.2 until this branch fixed it. Two layers only look like two when both
# work, so this one is written to hold on its own.
#
# It is not sufficient by itself either. The path is handed to `mkdir -p` and `chmod -R 777` on the
# deployment host, and no character set separates a directory this deployment owns from one it does
# not: `../..`, `.`, `/etc` and a home directory are all ordinary-looking paths. `..` is refused here
# because it is cheap to name, and the rest is refused by `nodes/init-node.sh`, on the host that
# holds the directory and can actually tell. See SEC-21.
#
# The set is narrower than what a docker bind mount source accepts, so this does refuse values that
# used to work: a local deploy took `data/two words` and no longer does. That is a deliberate trade
# and not a free one.
#
# Unset is fine. The defaults above are literals in this repository, not operator input.
require_safe_data_dir() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ]; then
    return 0
  fi

  # A leading `-` is excluded separately from the rest of the set, because a path is an argument
  # before it is a path: `mkdir -p -weird` reads it as options and dies with `illegal option -- w`,
  # naming neither the variable nor the value. `--` is not the fix, since BSD `chmod` does not accept
  # it and the same line runs on the operator's macOS machine. `./-weird` is still allowed.
  if ! [[ "$value" =~ ^[A-Za-z0-9._/][A-Za-z0-9._/-]*$ ]]; then
    log_error "$name is not a usable data directory: $value"
    echo "  Allowed characters: letters, digits, and . _ - / and not a leading -"
    exit 1
  fi

  case "/$value/" in
    */../*)
      log_error "$name walks out of the deployment directory: $value"
      echo "  The path is created and chmodded on the deployment host, so '..' is refused."
      exit 1
      ;;
  esac
}

# The data dir as a path on the machine that will hold it. A relative value is relative to `deploy/`,
# which is where docker compose resolves the same value's bind mount from, so the directory this
# creates and the one the container mounts are the same one. An absolute value is taken as given.
local_data_dir() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$DEPLOY_DIR" "$1" ;;
  esac
}

# --- Engine env (per-profile) ---
# Engine-specific options live in engines/<engine>/.env. Like the root env,
# a named profile gets its own copy: engines/<engine>/.env.<profile>.

readonly ENGINE_SERVICES=("$SVC_SRS" "$SVC_OME")

engine_env_file() {
  local engine="$1"
  if [ "$PROFILE" = "default" ]; then
    echo "$ROOT_DIR/engines/$engine/.env"
  else
    echo "$ROOT_DIR/engines/$engine/.env.$PROFILE"
  fi
}

# Create the current profile's engine env when missing — copied from the base
# engines/<engine>/.env (falling back to .env.sample). Engine ports are NOT
# shifted by --portSlot, so the new copy needs a manual review.
ensure_engine_env() {
  local engine="$1"
  local file base sample
  file=$(engine_env_file "$engine")
  [ -f "$file" ] && return 0
  base="$ROOT_DIR/engines/$engine/.env"
  sample="$ROOT_DIR/engines/$engine/.env.sample"
  if [ "$PROFILE" != "default" ] && [ -f "$base" ]; then
    cp "$base" "$file"
  elif [ -f "$sample" ]; then
    cp "$sample" "$file"
  else
    return 0
  fi
  log_warn "Created ${file#"$ROOT_DIR"/} for profile '$PROFILE' — review its ports/secrets (engine ports are not shifted by --portSlot)."
}

# Load the env file of every enabled engine as defaults. Runs after load_env so
# the root env wins on duplicate keys — the same order the natively-run uploader
# uses (dotenv loads <root>/.env first, then engines/<engine>/.env).
load_engine_envs() {
  local engine
  for engine in "${ENGINE_SERVICES[@]}"; do
    if is_enabled "$(get_target "$engine")"; then
      load_env_file "$(engine_env_file "$engine")"
    fi
  done
}

# Emit resolved KEY=VALUE\n lines for every key in the enabled engines' env
# files. Values are read from the current shell — i.e. after the
# load_env / load_engine_envs / apply_port_slot precedence has been applied —
# and land in the .env.deploy.<profile> override file so per-profile engine
# settings reliably reach compose interpolation (same reason PORT_OVERRIDES_TEXT
# exists), locally and on remote targets.
engine_env_overrides_text() {
  local engine file line key value out=""
  for engine in "${ENGINE_SERVICES[@]}"; do
    is_enabled "$(get_target "$engine")" || continue
    file=$(engine_env_file "$engine")
    [ -f "$file" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        ''|\#*) continue ;;
      esac
      key="${line%%=*}"
      if ! [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        continue
      fi
      # Single-quote the value — the override file is both `source`d and parsed by compose, and
      # secrets may contain $, !, #, ... Through `shell_quote` rather than repeating the escape,
      # because the copy that used to live here was the same expression that is wrong on bash 3.2:
      # an engine env value containing an apostrophe wrote an unbalanced line, and the `source` of
      # it at the two sites below then failed with `unexpected EOF` under `set -e`, aborting the
      # deploy on a syntax error naming a temp file.
      value=$(shell_quote "${!key:-}")
      out+="${key}=${value}\n"
    done < "$file"
  done
  printf '%s' "$out"
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
