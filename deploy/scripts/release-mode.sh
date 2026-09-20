#!/usr/bin/env bash

set -euo pipefail
umask 077

GUARD_BIN="${HOME}/.local/bin/streaming-release-guard"
GUARD_STATE_ROOT="${HOME}/.local/state/streaming-release-guard"
BOOTSTRAP_LOCK="${HOME}/.local/state/streaming-release-bootstrap.lock"
BOOTSTRAP_OWNER="${BOOTSTRAP_LOCK}/owner"
BOOTSTRAP_RELEASE_CLAIM="${BOOTSTRAP_LOCK}/release.claim"
UUID_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

path_exists() {
    [ -e "$1" ] || [ -L "$1" ]
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
        managed) printf '%s\n' managed ;;
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

case "${1:-begin}" in
    begin) begin_release ;;
    begin-bootstrap-install)
        require_absent_installation
        begin_bootstrap
        ;;
    finish-bootstrap) finish_bootstrap "${2:-}" ;;
    finish-guard)
        "$GUARD_BIN" finish-legacy --state-root "$GUARD_STATE_ROOT" --owner-token "${2:-}"
        ;;
    *)
        echo "ERROR: release mode command is invalid" >&2
        exit 2
        ;;
esac
