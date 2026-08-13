# shellcheck shell=bash
#
# Sourced, never executed, so it carries a shell directive instead of a shebang.
#
# How a harness says that a publisher it tore down was torn down ON PURPOSE.
#
# ⛔⛔⛔ THIS FILE EXISTS BECAUSE A SUCCESSFUL SITTING ENDED IN AN ALARM.
#
# A harness budgets `ARM_OVERHEAD_S` of slack per arm and stops the broadcast the moment its arms are
# done rather than paying for whatever is left. `publish-clock.sh` is still watching that container,
# so removing it left the watcher with nothing to read an exit status from, and it reported:
#
#   ✗ publish FAILED (exit 127). Nothing usable was broadcast, so do not measure against this.
#
# The #93 sitting of 2026-08-13 printed that after eight good arms, 363,952 push-synced chunks and
# 0.7321 BZZ, with 595s of the broadcast unused. ⭐⭐⭐ An alarm that fires on every successful run is
# one the operator learns to skip, and the next time it is real nobody reads it. That is gate lesson
# AHL, and it is the entire reason this marker exists rather than `publish-clock.sh` simply treating a
# vanished container as fine: a container that goes away WITHOUT one of these is still a loud failure,
# because nothing then knows how much was broadcast.
#
# ## What a caller owes it
#
# ⛔⛔ **Request the stop BEFORE removing the container, in that order.** The watcher polls, so it can
# see the container go; if the marker is written afterwards it can look between the two and report the
# false failure this file exists to remove. Every `stop_publisher` here calls this first.
#
# The path is handed to the publisher as `--stop-file=`, which is also the only way it accepts one.
# ⛔ It is deliberately NOT read from the environment on that side: `overnight-chain.sh` exports a
# `STOP_FILE` naming the chain's own halt signal into everything it runs, and the publisher CLEARS the
# file it is given at startup so that a marker it finds later cannot be a previous sitting's.

: "${OUT_DIR:?publisher-stop.sh needs OUT_DIR, so source it after the harness has set one}"

# ⭐ Distinct from the `STOP_FILE` the floor checks use, and not by accident. That one halts a sitting
# because a reading crossed a limit; this one only says who ended a broadcast. Sharing a name would
# have the publisher delete a halt signal it knows nothing about.
PUBLISHER_STOP_FILE="${PUBLISHER_STOP_FILE:-${OUT_DIR}/PUBLISHER-STOP-REQUESTED}"

# Record that the teardown about to happen is this harness's own doing.
#
# Written with a line in it rather than left empty, because an operator who finds one of these in an
# output directory should be able to read what it is without going to look for this file.
request_publisher_stop() {
  printf 'the harness stopped its own publisher at %s; this is not a publish failure\n' \
    "$(date -u +%FT%TZ)" > "${PUBLISHER_STOP_FILE}" || true
}
