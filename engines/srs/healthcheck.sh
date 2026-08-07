#!/usr/bin/env bash
#
# Answer whether this container can actually receive a broadcast, which is a different question from
# whether its process is running. This is OBS-20.
#
# On 2026-08-03 `latbench-srs-1` ran 44 minutes with its SRT listener dead. SRS had failed to bind
# with `errno=98` because another container still held the port under host networking, and it wrote
# nothing about that to its log until it was stopped. Throughout, `docker ps` said `Up`, the
# uploader's `/health` said `ok` with `activeStreams: 0`, and the container healthcheck was satisfied.
# Every one of those reports on a process that exists. None of them reports on a socket that listens.
#
# ## Why the port being bound is not the check
#
# During that outage the port **was** bound, by the process that stole it, so a probe asking only
# "is anything listening on the SRT port" passes for the entire failure. Under `network_mode: host`
# this container shares the host's network namespace and would see that stranger's socket as readily
# as its own. What separates the two states is ownership.
#
# The network namespace is shared; the PID namespace is not. So the inode `/proc/net/udp` reports for
# the listening socket is compared against the socket inodes held by processes **in this container**,
# and a listener nothing here owns fails exactly as loudly as no listener at all.
#
# ## Scope
#
# The SRT ingest only. RTMP and the HTTP API can fail the same way and are not checked, because
# nothing in this deployment publishes over either: the harness, the bench and the product all dial
# SRT. A check covering a path no one uses would report on the wrong socket.
#
# Usage:
#   healthcheck.sh [PORT] [PROC_DIR]
#
# PORT defaults to $SRS_SRT_PORT then to 10080, matching the compose default. PROC_DIR defaults to
# /proc and exists so the tests can drive this against a tree they built, rather than against a
# kernel they cannot make fail on purpose.
set -euo pipefail

PORT="${1:-${SRS_SRT_PORT:-10080}}"
PROC_DIR="${2:-/proc}"

case "${PORT}" in
  '' | *[!0-9]*)
    echo "srs healthcheck: '${PORT}' must be a port number" >&2
    exit 2
    ;;
esac

# The kernel writes local addresses as uppercase hex, four digits for a port. Anchored at both ends
# of the field below, so a port whose spelling contains another's is not mistaken for it.
HEX_PORT="$(printf '%04X' "${PORT}")"

# `$2` is `local_address`, `$10` is the socket inode. Both files are read because SRS binds whichever
# family the host offers, and a v6 listener serving v4 clients is the ordinary case.
listening_inodes="$(
  awk -v port=":${HEX_PORT}" 'NR > 1 && index($2, port) == length($2) - length(port) + 1 { print $10 }' \
    "${PROC_DIR}/net/udp" "${PROC_DIR}/net/udp6" 2>/dev/null || true
)"

if [ -z "${listening_inodes}" ]; then
  echo "srs healthcheck: nothing is listening on UDP ${PORT}, so no broadcaster can reach this engine" >&2
  exit 1
fi

# Every socket held by every process in this container's PID namespace, which under host networking
# is the only thing distinguishing our listener from someone else's.
owned_inodes="$(
  for fd in "${PROC_DIR}"/[0-9]*/fd/*; do
    [ -L "${fd}" ] || continue
    target="$(readlink "${fd}" 2>/dev/null || echo '')"
    # A socket link reads `socket:[12345]`. Matched by stripping the prefix rather than by a glob,
    # because the brackets are pattern syntax in both `case` and `${var#...}` and quoting them there
    # is the kind of detail that silently matches nothing.
    if [ "${target}" != "${target#socket:}" ]; then
      printf '%s\n' "${target}" | tr -dc '0-9'
      printf '\n'
    fi
  done
)"

for inode in ${listening_inodes}; do
  for owned in ${owned_inodes}; do
    if [ "${inode}" = "${owned}" ]; then
      exit 0
    fi
  done
done

echo "srs healthcheck: UDP ${PORT} is bound by a process outside this container, so SRS never got the" \
  "socket and every publish will be refused while nothing in the log says so. See OBS-20." >&2
exit 1
