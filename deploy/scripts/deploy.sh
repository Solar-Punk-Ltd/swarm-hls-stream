#!/bin/bash
set -e

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

require_jq
require_config
require_env
load_env

# --- Usage ---

usage() {
  echo "Usage: deploy.sh [service...]"
  echo ""
  echo "  deploy.sh                          Deploy all enabled services"
  echo "  deploy.sh bee-uploader             Deploy only bee-uploader"
  echo "  deploy.sh bee-uploader bee-gateway  Deploy only bee nodes"
  echo "  deploy.sh srs stream-uploader      Deploy only the streaming stack"
  echo ""
  echo "Services: ${ALL_SERVICES[*]}"
  echo "Targets are read from config.json."
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

# --- Parse service filter ---

FILTER_SERVICES=()
if [ $# -gt 0 ]; then
  for arg in "$@"; do
    local_valid=false
    for svc in "${ALL_SERVICES[@]}"; do
      if [ "$arg" = "$svc" ]; then
        local_valid=true
        break
      fi
    done
    if [ "$local_valid" = "false" ]; then
      log_error "Unknown service: $arg"
      usage
      exit 1
    fi
    FILTER_SERVICES+=("$arg")
  done
  log_info "Deploying selected services: ${FILTER_SERVICES[*]}"
fi

# Only validate co-location when deploying all services
if [ ${#FILTER_SERVICES[@]} -eq 0 ]; then
  validate_config
fi

print_services

# --- Service filter helpers ---

# Check if a service is in the filter (or no filter = all pass)
is_in_filter() {
  local svc="$1"
  if [ ${#FILTER_SERVICES[@]} -eq 0 ]; then
    return 0
  fi
  for f in "${FILTER_SERVICES[@]}"; do
    [ "$f" = "$svc" ] && return 0
  done
  return 1
}

# Get filtered services for a target
get_filtered_services_for_target() {
  local target="$1"
  for svc in $(get_services_for_target "$target"); do
    if is_in_filter "$svc"; then
      echo "$svc"
    fi
  done
}

# --- STAMP guard ---

check_stamp() {
  local needs_stamp=false
  for target in $(get_targets); do
    for svc in $(get_filtered_services_for_target "$target"); do
      [ "$svc" = "$SVC_UPLOADER" ] && needs_stamp=true
    done
  done

  if [ "$needs_stamp" = "true" ]; then
    local stamp_val
    stamp_val=$(grep -E '^STAMP=' "$ENV_FILE" | cut -d= -f2-)
    if [ -z "$stamp_val" ]; then
      log_warn "STAMP is empty in .env — stream-uploader needs a valid postage stamp."
      log_warn "Run: pnpm stamp:setup"
      echo ""
      read -r -p "Continue anyway? [y/N] " answer
      if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
        echo "Aborted."
        exit 1
      fi
    fi
  fi
}

check_stamp

# --- Build ---

build_if_needed() {
  if [ ! -d "$ROOT_DIR/packages/stream-uploader/dist" ]; then
    log_info "Building packages"
    cd "$ROOT_DIR"
    pnpm install
    pnpm build
  fi
}

build_force() {
  log_info "Building packages"
  cd "$ROOT_DIR"
  pnpm install
  pnpm build
}

# --- Cross-target URL resolution ---

# When bee-uploader is on a different host than stream-uploader,
# the uploader can't use the docker service name — it needs the real IP.
resolve_bee_url() {
  local bee_target uploader_target
  bee_target=$(get_target "$SVC_BEE_UPLOADER")
  uploader_target=$(get_target "$SVC_UPLOADER")

  if ! is_enabled "$bee_target"; then
    # bee-uploader disabled — use whatever BEE_URL is in .env
    return
  fi

  if [ "$bee_target" = "$uploader_target" ]; then
    local bee_port="${BEE_UPLOADER_API_PORT:-$DEFAULT_BEE_UPLOADER_PORT}"
    if [ "${COMPOSE_NETWORK:-}" = "host" ]; then
      # Host network — no docker DNS, use localhost
      echo "http://localhost:${bee_port}"
    else
      # Bridge network — docker service name works
      echo "http://bee-uploader:${bee_port}"
    fi
    return
  fi

  # Different targets — use the bee host's IP
  local bee_host
  bee_host=$(host_from_target "$bee_target")
  local bee_port="${BEE_UPLOADER_API_PORT:-$DEFAULT_BEE_UPLOADER_PORT}"
  echo "http://${bee_host}:${bee_port}"
}

# When stream-uploader is on a different host than SRS,
# SRS webhooks need the real IP. (Currently blocked by validation,
# but this handles future flexibility.)
resolve_adapter_host() {
  local srs_target uploader_target
  srs_target=$(get_target "$SVC_SRS")
  uploader_target=$(get_target "$SVC_UPLOADER")

  if is_native "$uploader_target"; then
    # stream-uploader runs on the host machine outside Docker.
    # SRS reaches it via the host-gateway alias added in docker-compose.yml.
    echo "host.docker.internal"
    return
  fi

  if [ "$srs_target" = "$uploader_target" ]; then
    if [ "${COMPOSE_NETWORK:-}" = "host" ]; then
      echo "localhost"
    else
      echo "stream-uploader"
    fi
  else
    host_from_target "$uploader_target"
  fi
}

# --- Init bee data dirs ---

init_bee_dirs() {
  local target="$1"
  shift
  local services=("$@")

  for svc in "${services[@]}"; do
    if [ "$svc" = "$SVC_BEE_UPLOADER" ]; then
      local data_dir="${BEE_UPLOADER_DATA_DIR:-./data/bee-uploader}"
      if is_local "$target"; then
        "$ROOT_DIR/nodes/init-node.sh" "$DEPLOY_DIR/$data_dir"
      else
        # Skip if already initialized (password file exists)
        ssh "$target" "if [ -f $REMOTE_BASE/deploy/$data_dir/password ]; then \
          echo 'Node already initialized: $data_dir'; \
        else \
          mkdir -p $REMOTE_BASE/deploy/$data_dir && \
          head -c 32 /dev/urandom | base64 | head -c 32 > $REMOTE_BASE/deploy/$data_dir/password && \
          chmod -R 777 $REMOTE_BASE/deploy/$data_dir && \
          echo 'Node data dir ready: $data_dir'; \
        fi"
      fi
    fi
    if [ "$svc" = "$SVC_BEE_GATEWAY" ]; then
      local data_dir="${BEE_GATEWAY_DATA_DIR:-./data/bee-gateway}"
      if is_local "$target"; then
        "$ROOT_DIR/nodes/init-node.sh" "$DEPLOY_DIR/$data_dir"
      else
        ssh "$target" "if [ -f $REMOTE_BASE/deploy/$data_dir/password ]; then \
          echo 'Node already initialized: $data_dir'; \
        else \
          mkdir -p $REMOTE_BASE/deploy/$data_dir && \
          head -c 32 /dev/urandom | base64 | head -c 32 > $REMOTE_BASE/deploy/$data_dir/password && \
          chmod -R 777 $REMOTE_BASE/deploy/$data_dir && \
          echo 'Node data dir ready: $data_dir'; \
        fi"
      fi
    fi
  done
}

# --- Sync files to remote ---

sync_to_remote() {
  local target="$1"
  shift
  local services=("$@")

  log_info "Syncing files to $target"

  # Ensure remote directory structure exists
  ssh "$target" "mkdir -p $REMOTE_BASE/deploy/scripts $REMOTE_BASE/engines/srs $REMOTE_BASE/packages/stream-uploader $REMOTE_BASE/nodes"

  # Always sync compose, Dockerfile, scripts
  rsync -az --delete \
    "$DEPLOY_DIR/docker-compose.yml" \
    "$DEPLOY_DIR/docker-compose.host.yml" \
    "$DEPLOY_DIR/Dockerfile.uploader" \
    "$target:$REMOTE_BASE/deploy/"

  # Sync root .env
  rsync -az "$ENV_FILE" "$target:$REMOTE_BASE/.env"

  rsync -az "$DEPLOY_DIR/scripts/" "$target:$REMOTE_BASE/deploy/scripts/"

  local need_srs=false
  local need_uploader=false

  for svc in "${services[@]}"; do
    [ "$svc" = "$SVC_SRS" ] && need_srs=true
    [ "$svc" = "$SVC_UPLOADER" ] && need_uploader=true
  done

  if [ "$need_srs" = "true" ]; then
    rsync -az --delete \
      "$ROOT_DIR/engines/srs/srs.conf.template" \
      "$ROOT_DIR/engines/srs/entrypoint.sh" \
      "$target:$REMOTE_BASE/engines/srs/"
  fi

  if [ "$need_uploader" = "true" ]; then
    rsync -az --delete \
      "$ROOT_DIR/packages/stream-uploader/dist/" \
      "$target:$REMOTE_BASE/packages/stream-uploader/dist/"

    rsync -az \
      "$ROOT_DIR/packages/stream-uploader/package.json" \
      "$target:$REMOTE_BASE/packages/stream-uploader/"
  fi

  # Sync node init script
  rsync -az "$ROOT_DIR/nodes/init-node.sh" "$target:$REMOTE_BASE/nodes/"
}

# --- Generate env overrides for a target ---

generate_env_overrides() {
  local target="$1"
  shift
  local services=("$@")
  local overrides=""

  for svc in "${services[@]}"; do
    if [ "$svc" = "$SVC_UPLOADER" ]; then
      local bee_url
      bee_url=$(resolve_bee_url)
      if [ -n "$bee_url" ]; then
        overrides="${overrides}BEE_URL=${bee_url}\n"
      fi
    fi
    if [ "$svc" = "$SVC_SRS" ]; then
      local adapter_host
      adapter_host=$(resolve_adapter_host)
      overrides="${overrides}SRS_ADAPTER_HOST=${adapter_host}\n"
    fi
  done

  echo -e "$overrides"
}

# --- Deploy to a target ---

deploy_target() {
  local target="$1"
  shift
  local services=("$@")
  local profiles compose_files
  profiles=$(build_profile_flags "${services[@]}")
  compose_files=$(build_compose_files "$DEPLOY_DIR")

  echo ""
  log_info "Deploying to $target: ${services[*]}"

  # Generate env overrides
  local overrides
  overrides=$(generate_env_overrides "$target" "${services[@]}")

  if is_local "$target"; then
    # Init bee dirs
    init_bee_dirs "$target" "${services[@]}"

    # Write overrides to temp file
    local override_file="$DEPLOY_DIR/.env.deploy"
    echo -e "$overrides" > "$override_file"

    # Export overrides into current env for compose
    if [ -n "$overrides" ]; then
      set -a
      # shellcheck disable=SC1090
      source "$override_file"
      set +a
    fi

    cd "$DEPLOY_DIR"
    # shellcheck disable=SC2086
    docker compose $compose_files --env-file "$ENV_FILE" $profiles up -d --build

    rm -f "$override_file"
    log_ok "Local deploy complete"
  else
    # Remote deploy
    sync_to_remote "$target" "${services[@]}"
    init_bee_dirs "$target" "${services[@]}"

    # Write overrides into remote .env.deploy
    local remote_compose_files
    remote_compose_files=$(build_compose_files "$REMOTE_BASE/deploy")
    ssh "$target" bash -s <<REMOTE_SCRIPT
      set -e
      cd $REMOTE_BASE/deploy

      # Write env overrides
      cat > .env.deploy <<'ENVEOF'
$(echo -e "$overrides")
ENVEOF

      # Source overrides into env, then run compose with root .env
      set -a
      [ -s .env.deploy ] && source .env.deploy
      set +a

      chmod +x scripts/*.sh
      docker compose $remote_compose_files --env-file $REMOTE_BASE/.env $profiles up -d --build

      rm -f .env.deploy
      echo "Stack started on \$(hostname)"
REMOTE_SCRIPT

    log_ok "Deploy to $target complete"
  fi
}

# --- Main ---

# Pre-scan: check if we need to build
has_remote=false
has_uploader=false
has_any=false

for target in $(get_targets); do
  services=($(get_filtered_services_for_target "$target"))
  [ ${#services[@]} -eq 0 ] && continue
  has_any=true
  is_remote "$target" && has_remote=true
  for svc in "${services[@]}"; do
    [ "$svc" = "$SVC_UPLOADER" ] && has_uploader=true
  done
done

if [ "$has_any" = "false" ]; then
  log_warn "No services to deploy (check config.json and filter)"
  exit 0
fi

# Build once before deploying (only if uploader is being deployed)
if [ "$has_uploader" = "true" ]; then
  if [ "$has_remote" = "true" ]; then
    build_force
  else
    build_if_needed
  fi
fi

# Deploy to each target
for target in $(get_targets); do
  services=($(get_filtered_services_for_target "$target"))
  [ ${#services[@]} -eq 0 ] && continue
  deploy_target "$target" "${services[@]}"
done

echo ""
echo "=== Deploy complete ==="
echo "Run ./deploy/scripts/health.sh to check status"
echo "Run pnpm node:status to check bee nodes"
