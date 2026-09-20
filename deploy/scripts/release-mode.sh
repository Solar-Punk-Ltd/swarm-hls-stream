#!/usr/bin/env bash

set -euo pipefail
umask 077

GUARD_BIN="${HOME}/.local/bin/streaming-release-guard"
GUARD_STATE_ROOT="${HOME}/.local/state/streaming-release-guard"
FIXED_GUARD_ROOT="/opt/streaming-release-guard"
FIXED_GUARD_BIN="${FIXED_GUARD_ROOT}/streaming-release-guard"
FIXED_GUARD_BINDING="${FIXED_GUARD_ROOT}/container-binding.json"
BOOTSTRAP_LOCK="${HOME}/.local/state/streaming-release-bootstrap.lock"
BOOTSTRAP_OWNER="${BOOTSTRAP_LOCK}/owner"
BOOTSTRAP_RELEASE_CLAIM="${BOOTSTRAP_LOCK}/release.claim"
UUID_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

path_exists() {
    [ -e "$1" ] || [ -L "$1" ]
}

select_guard_installation() {
    if ! path_exists "$FIXED_GUARD_ROOT" &&
        ! path_exists "$FIXED_GUARD_BIN" &&
        ! path_exists "$FIXED_GUARD_BINDING"; then
        return
    fi
    if [ ! -d "$FIXED_GUARD_ROOT" ] || [ -L "$FIXED_GUARD_ROOT" ] ||
        [ ! -f "$FIXED_GUARD_BINDING" ] || [ -L "$FIXED_GUARD_BINDING" ] ||
        [ ! -f "$FIXED_GUARD_BIN" ] || [ -L "$FIXED_GUARD_BIN" ] || [ ! -x "$FIXED_GUARD_BIN" ]; then
        echo "ERROR: installed release guard binding is partial or invalid" >&2
        exit 1
    fi
    binding_size="$(wc -c < "$FIXED_GUARD_BINDING" | tr -d '[:space:]')"
    if [[ ! "$binding_size" =~ ^[0-9]+$ ]] || [ "$binding_size" -lt 1 ] || [ "$binding_size" -gt 4096 ]; then
        echo "ERROR: installed release guard binding is invalid" >&2
        exit 1
    fi
    if ! command -v node >/dev/null 2>&1; then
        echo "ERROR: installed release guard binding cannot be read" >&2
        exit 1
    fi
    if ! bound_state_root="$(node -e '
const fs = require("node:fs");
const path = require("node:path");
try {
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "schemaVersion" || keys[1] !== "stateRoot") process.exit(1);
  if (value.schemaVersion !== 1 || typeof value.stateRoot !== "string") process.exit(1);
  if (!path.isAbsolute(value.stateRoot) || path.normalize(value.stateRoot) !== value.stateRoot) process.exit(1);
  if (Buffer.byteLength(value.stateRoot) > 4096 || /[\0\r\n]/.test(value.stateRoot)) process.exit(1);
  process.stdout.write(value.stateRoot);
} catch {
  process.exit(1);
}
' "$FIXED_GUARD_BINDING" 2>/dev/null)"; then
        echo "ERROR: installed release guard binding is invalid" >&2
        exit 1
    fi
    if [ ! -d "$bound_state_root" ] || [ -L "$bound_state_root" ]; then
        echo "ERROR: installed release guard binding state is missing or invalid" >&2
        exit 1
    fi
    GUARD_BIN="$FIXED_GUARD_BIN"
    GUARD_STATE_ROOT="$bound_state_root"
}

sync_paths() {
    if [ "$(uname -s)" = Linux ]; then
        for path in "$@"; do sync -f "$path"; done
    else
        sync
    fi
}

new_owner_token() {
    if [ -r /proc/sys/kernel/random/uuid ]; then
        IFS= read -r owner_token < /proc/sys/kernel/random/uuid
    else
        owner_token="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    fi
    if [[ ! "$owner_token" =~ $UUID_PATTERN ]]; then
        echo "ERROR: release bootstrap owner token source is invalid" >&2
        exit 1
    fi
    printf '%s\n' "$owner_token"
}

require_absent_installation() {
    if path_exists "$GUARD_BIN" || path_exists "$GUARD_STATE_ROOT"; then
        echo "ERROR: release guard installation already exists or is partial" >&2
        exit 1
    fi
}

begin_bootstrap() {
    mkdir -p "$(dirname "$BOOTSTRAP_LOCK")"
    chmod 700 "$(dirname "$BOOTSTRAP_LOCK")"
    if ! mkdir -m 700 "$BOOTSTRAP_LOCK"; then
        echo "ERROR: release bootstrap lease is active or requires operator recovery" >&2
        exit 1
    fi
    sync_paths "$(dirname "$BOOTSTRAP_LOCK")"
    require_absent_installation
    owner_token="$(new_owner_token)"
    printf '%s\n' "$owner_token" > "${BOOTSTRAP_OWNER}.tmp"
    chmod 600 "${BOOTSTRAP_OWNER}.tmp"
    sync_paths "${BOOTSTRAP_OWNER}.tmp"
    mv "${BOOTSTRAP_OWNER}.tmp" "$BOOTSTRAP_OWNER"
    sync_paths "$BOOTSTRAP_LOCK"
    printf 'bootstrap:%s\n' "$owner_token"
}

finish_bootstrap() {
    owner_token="${1:-}"
    if [[ ! "$owner_token" =~ $UUID_PATTERN ]]; then
        echo "ERROR: release bootstrap owner token is invalid" >&2
        exit 1
    fi
    if [ ! -d "$BOOTSTRAP_LOCK" ] || [ -L "$BOOTSTRAP_LOCK" ] ||
        [ ! -f "$BOOTSTRAP_OWNER" ] || [ -L "$BOOTSTRAP_OWNER" ]; then
        echo "ERROR: release bootstrap lease is invalid" >&2
        exit 1
    fi
    IFS= read -r actual_owner < "$BOOTSTRAP_OWNER"
    if [ "$actual_owner" != "$owner_token" ]; then
        echo "ERROR: release bootstrap owner token does not match" >&2
        exit 1
    fi
    if ! ln "$BOOTSTRAP_OWNER" "$BOOTSTRAP_RELEASE_CLAIM"; then
        echo "ERROR: release bootstrap lease is already being released or requires operator recovery" >&2
        exit 1
    fi
    IFS= read -r claimed_owner < "$BOOTSTRAP_RELEASE_CLAIM"
    if [ "$claimed_owner" != "$owner_token" ] || [ ! "$BOOTSTRAP_OWNER" -ef "$BOOTSTRAP_RELEASE_CLAIM" ]; then
        rm "$BOOTSTRAP_RELEASE_CLAIM"
        echo "ERROR: release bootstrap owner token does not match" >&2
        exit 1
    fi
    rm "$BOOTSTRAP_OWNER"
    sync_paths "$BOOTSTRAP_LOCK"
    rm "$BOOTSTRAP_RELEASE_CLAIM"
    sync_paths "$BOOTSTRAP_LOCK"
    rmdir "$BOOTSTRAP_LOCK"
    sync_paths "$(dirname "$BOOTSTRAP_LOCK")"
    printf '%s\n' 'release bootstrap lease released'
}

begin_release() {
    profile="${1:-default}"
    if [[ ! "$profile" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]]; then
        echo "ERROR: stack release profile is invalid" >&2
        exit 1
    fi
    guard_exists=false
    state_exists=false
    if path_exists "$GUARD_BIN"; then guard_exists=true; fi
    if path_exists "$GUARD_STATE_ROOT"; then state_exists=true; fi

    if [ "$guard_exists" = false ] && [ "$state_exists" = false ]; then
        begin_bootstrap
        return
    fi
    if [ "$guard_exists" = false ] || [ "$state_exists" = false ]; then
        echo "ERROR: release guard installation is partial" >&2
        exit 1
    fi
    if [ ! -x "$GUARD_BIN" ] || [ ! -d "$GUARD_STATE_ROOT" ] || [ -L "$GUARD_STATE_ROOT" ]; then
        echo "ERROR: release guard installation is invalid" >&2
        exit 1
    fi

    result="$("$GUARD_BIN" begin-legacy --state-root "$GUARD_STATE_ROOT")"
    case "$result" in
        managed)
            result="$("$GUARD_BIN" begin-stack-legacy --state-root "$GUARD_STATE_ROOT" --profile "$profile")"
            case "$result" in
                legacy:*)
                    owner_token="${result#legacy:}"
                    if [[ ! "$owner_token" =~ $UUID_PATTERN ]]; then
                        echo "ERROR: release guard returned an invalid stack legacy lease" >&2
                        exit 1
                    fi
                    printf 'stack-guard:%s\n' "$owner_token"
                    ;;
                *)
                    echo "ERROR: release guard returned an invalid stack legacy lease" >&2
                    exit 1
                    ;;
            esac
            ;;
        legacy:*)
            owner_token="${result#legacy:}"
            if [[ ! "$owner_token" =~ $UUID_PATTERN ]]; then
                echo "ERROR: release guard returned an invalid legacy lease" >&2
                exit 1
            fi
            printf 'guard:%s\n' "$owner_token"
            ;;
        *)
            echo "ERROR: release guard returned an invalid deployment mode" >&2
            exit 1
            ;;
    esac
}

select_guard_installation

case "${1:-begin}" in
    begin) begin_release "${2:-}" ;;
    begin-bootstrap-install)
        require_absent_installation
        begin_bootstrap
        ;;
    finish-bootstrap) finish_bootstrap "${2:-}" ;;
    finish-guard)
        "$GUARD_BIN" finish-legacy --state-root "$GUARD_STATE_ROOT" --owner-token "${2:-}"
        ;;
    finish-stack-guard)
        "$GUARD_BIN" finish-stack-legacy --state-root "$GUARD_STATE_ROOT" --owner-token "${2:-}"
        ;;
    *)
        echo "ERROR: release mode command is invalid" >&2
        exit 2
        ;;
esac
