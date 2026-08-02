#!/bin/bash
set -e

DATA_DIR="${1:?Usage: ./init-node.sh <data-dir>}"

# If password file exists, node is already initialized — skip
if [ -f "$DATA_DIR/password" ]; then
  echo "Node already initialized: $DATA_DIR"
  exit 0
fi

# A bee data dir is a directory this deployment owns, and the check above is what recognises one it
# already owns. Anything else that already has contents belongs to someone else, and `chmod -R 777`
# four lines below would open all of it. The character check in `require_safe_data_dir` cannot make
# this call: `.`, `/etc` and the deployment account's home are ordinary-looking paths, so refusing
# `../..` there while accepting the same directory spelled absolutely is the whole of the gap. Only
# the host holding the directory can answer it, which is here. See SEC-21.
if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
  echo "Refusing to use a non-empty directory as a bee data dir: $DATA_DIR" >&2
  echo "Point BEE_UPLOADER_DATA_DIR or BEE_GATEWAY_DATA_DIR at a new or empty directory." >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
head -c 32 /dev/urandom | base64 | head -c 32 > "$DATA_DIR/password"
echo "Created password file: $DATA_DIR/password"

# Bee container runs as uid 999 — ensure it can read/write the data dir
chmod -R 777 "$DATA_DIR"

echo "Node data dir ready: $DATA_DIR"
