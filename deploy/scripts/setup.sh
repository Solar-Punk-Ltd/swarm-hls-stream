#!/bin/bash
set -e

# shellcheck source=_lib.sh
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

echo "=== Swarm HLS Stream — Setup ==="

# 1. Check jq
require_jq

# 2. Create config.json if missing
if [ ! -f "$CONFIG_FILE" ]; then
  cp "$DEPLOY_DIR/config.sample.json" "$CONFIG_FILE"
  echo ""
  log_ok "Created config.json from config.sample.json"
  echo "  Edit it to set deployment targets:"
  echo "  $CONFIG_FILE"
else
  echo ""
  log_ok "config.json already exists"
fi

# 3. Create .env if missing
if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_SAMPLE" "$ENV_FILE"
  echo ""
  log_ok "Created .env from .env.sample"
  echo ""
  echo "  Required:"
  echo "    STREAM_KEY     Private key (hex)"
  echo ""
  echo "  Edit: $ENV_FILE"
else
  echo ""
  log_ok ".env already exists"
fi

# 4. Init bee data dirs for local services
require_config
load_env

bee_uploader_target=$(get_target "$SVC_BEE_UPLOADER")
bee_gateway_target=$(get_target "$SVC_BEE_GATEWAY")

echo ""
log_info "Initializing local bee data directories"

if is_local "$bee_uploader_target"; then
  "$ROOT_DIR/nodes/init-node.sh" "$DEPLOY_DIR/${BEE_UPLOADER_DATA_DIR:-./data/bee-uploader}"
fi

if is_enabled "$bee_gateway_target" && is_local "$bee_gateway_target"; then
  "$ROOT_DIR/nodes/init-node.sh" "$DEPLOY_DIR/${BEE_GATEWAY_DATA_DIR:-./data/bee-gateway}"
fi

# 5. Build packages
echo ""
log_info "Building packages"
cd "$ROOT_DIR"
pnpm install
pnpm build

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit config.json to set deployment targets"
echo "  2. Edit .env with your STREAM_KEY"
echo "  3. Deploy bee node:    ./deploy/scripts/deploy.sh bee-uploader"
echo "  4. Fund the node:      pnpm node:addresses  (send xDAI + BZZ)"
echo "  5. Setup stamp:        pnpm stamp:setup"
echo "  6. Deploy full stack:  ./deploy/scripts/deploy.sh"
