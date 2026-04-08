#!/bin/bash
set -e

DATA_DIR="${1:?Usage: ./init-node.sh <data-dir>}"

# If password file exists, node is already initialized — skip
if [ -f "$DATA_DIR/password" ]; then
  echo "Node already initialized: $DATA_DIR"
  exit 0
fi

mkdir -p "$DATA_DIR"
head -c 32 /dev/urandom | base64 | head -c 32 > "$DATA_DIR/password"
echo "Created password file: $DATA_DIR/password"

# Bee container runs as uid 999 — ensure it can read/write the data dir
chmod -R 777 "$DATA_DIR"

echo "Node data dir ready: $DATA_DIR"
