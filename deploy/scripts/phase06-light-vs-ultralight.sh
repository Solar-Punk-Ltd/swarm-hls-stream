#!/bin/bash
#
# Phase 0.6 — a viewer's gateway, funded against unfunded, measured in a browser.
#
# ## The question
#
# Every viewer-side figure this project holds was measured through a chequebook-funded light gateway.
# That is the best case and not the shipping case: a real viewer runs ultra-light, or a light node
# nobody funded, which is the state a viewer reaches by watching. An ultra-light bee node has no
# chequebook and no way to pay a peer for bandwidth, so it lives on the free allowance alone. If a
# stream holds on one, the viewer path needs no chain, no wallet and no on-chain funding at all.
#
# It was measured once, on 2026-08-04, and the answer does not survive: both arms read through the
# bench's `/feeds/` head lookup, which is 50-57% frozen on its own and which a viewer never calls, and
# the client has since been fixed to walk the feed rather than take one slot per poll. So the standing
# position is that credit exhaustion degrades retrieval and nobody has ever seen what it does to a
# picture. This run is the picture.
#
# ## Why it runs here rather than from a laptop
#
# `browser-on-host.sh` drives this from a workstation over ssh, which is right for one run someone is
# watching and wrong for a sitting that has to outlive the laptop closing. This is the same shape as
# `sweep-interleaved.sh`: started detached on the host, it holds no session open and reports to disk.
#
#   scp phase06-light-vs-ultralight.sh manager-host:/home/solarpunk/phase06/
#   ssh manager-host 'setsid nohup bash /home/solarpunk/phase06/phase06-light-vs-ultralight.sh >/dev/null 2>&1 &'
#
# ## Why it proves itself before it spends the sitting
#
# Nothing here has ever run. Both defects in the gateway sampler were invisible to its own suite,
# because a unit test passes a fixture the size of the thing it asserts, and the rule this project
# paid for is to dry-run an instrument against the deployment before spending a broadcast on it.
#
# So the first thing it does is a five-minute arm of each configuration. If either fails validation
# the sitting stops with a named reason having spent about a seventh of a full arm, the gateway is put
# back the way it was found, and the morning has a cheap failure to read instead of a lost night.
#
# ## Why the flip is checked on the node rather than trusted from compose
#
# The arm is one env value and a container recreate, which is exactly the kind of change that can
# appear to happen. Two things are asserted after every recreate:
#
#   1. The container's command differs from the one found at startup in `--swap-enable` and nothing
#      else, and its mounts and ports are identical. A recreate that quietly lost a port binding or
#      a data directory would otherwise be measured as an arm.
#   2. The node's own `/chequebook/balance` answers in the shape the arm requires. A funded node
#      returns a balance; a node started with swap disabled has no chequebook at all and answers 405.
#      That is the difference between the two arms, read off the node rather than off the intent.
#
# ## Funding, and why the constants here are not the sweep's
#
# `sweep-interleaved.sh` prices a run at 0.0325 BZZ/min for the uploader, measured across a mix that
# included 1080p. This sitting is fixed at 720p 2500kbps, where seventeen runs measured 0.0179 BZZ/min
# and the best-instrumented run measured 0.0134. The higher of the two 720p figures is used with a
# doubled margin, which is honest about this sitting rather than borrowing another one's mix.
#
# The gateway rate is the corrected one: 0.306 BZZ per 30 minutes of 720p, measured continuously,
# against the 0.123 this project budgeted on until 2026-08-07.
#
# Checked before the sitting against the whole of it, and again before every arm against that arm, so
# running out is a clean stop with a named reason rather than a slide into measuring starvation.
set -u

OUT_DIR="${OUT_DIR:-/home/solarpunk/phase06}"
# Deliberately outside both rsync targets. `~/swarm-hls-bench` is synced with `--delete` by
# `bench-on-host.sh` and `~/swarm-hls-stream-latbench` is owned by `deploy.sh`, so anything written in
# either is removed the next time a laptop syncs, which is exactly when someone would be checking on a
# sitting still running.
BENCH_REPO="${BENCH_REPO:-/home/solarpunk/swarm-hls-bench}"
STACK_DIR="${STACK_DIR:-/home/solarpunk/swarm-hls-stream-latbench}"
COMPOSE_DIR="${STACK_DIR}/deploy"
ENV_FILE="${STACK_DIR}/.env"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-latbench}"
GATEWAY_CONTAINER="${GATEWAY_CONTAINER:-latbench-bee-gateway-1}"
BROWSER_IMAGE="${BROWSER_IMAGE:-swarm-hls-browser}"

PROFILE="${PROFILE:-latbench}"
PORT_SLOT="${PORT_SLOT:-7}"
# Origins from `apply_port_slot` in `_lib.sh`, resolved here because this script never sources it.
UPLOADER_BEE_PORT="${UPLOADER_BEE_PORT:-$((10005 + PORT_SLOT * 10))}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-$((10007 + PORT_SLOT * 10))}"
UPLOADER_API_PORT="${UPLOADER_API_PORT:-$((10000 + PORT_SLOT * 10))}"
CLIENT_PORT="${CLIENT_PORT:-$((10004 + PORT_SLOT * 10))}"

SIZE="${SIZE:-1280x720}"
BITRATE_KBPS="${BITRATE_KBPS:-2500}"
GOP_SECONDS="${GOP_SECONDS:-1.0}"

PROVING_WATCH_SECONDS="${PROVING_WATCH_SECONDS:-300}"
FULL_WATCH_SECONDS="${FULL_WATCH_SECONDS:-1800}"
# A restarted bee node has to re-establish peers and performs differently cold. Task #57 controlled
# for exactly this and found the warm run slightly worse, so this does not flatter the funded arm.
PROVING_WARM_SECONDS="${PROVING_WARM_SECONDS:-120}"
FULL_WARM_SECONDS="${FULL_WARM_SECONDS:-180}"
# The publisher outlives the watch on both ends: the stream has to exist before the browser opens and
# must not end under it. A broadcast that stops mid-watch is measured as a viewer losing the stream.
PUBLISH_MARGIN_SECONDS="${PUBLISH_MARGIN_SECONDS:-120}"

# PLUR per minute of publishing, 1 BZZ = 1e16. See the header for where each comes from.
UPLOADER_BURN_PLUR_PER_MIN="${UPLOADER_BURN_PLUR_PER_MIN:-179000000000000}"
GATEWAY_BURN_PLUR_PER_MIN="${GATEWAY_BURN_PLUR_PER_MIN:-102000000000000}"
FUNDS_MARGIN_PERCENT="${FUNDS_MARGIN_PERCENT:-200}"

# `utilization` is the fullest of sixty-five thousand buckets and the batch is immutable, so crossing
# it is not recoverable by topping up. 80% of 256 is where every run already warns.
POSTAGE_WARN_BUCKETS="${POSTAGE_WARN_BUCKETS:-204}"
POSTAGE_DEPTH_BUCKETS="${POSTAGE_DEPTH_BUCKETS:-256}"

mkdir -p "${OUT_DIR}"
LOG="${OUT_DIR}/phase06.log"
STATE="${OUT_DIR}/phase06-state.tsv"
REPORTS="${OUT_DIR}/reports"
mkdir -p "${REPORTS}"

say() {
  echo "[$(date -u +%H:%M:%S)] $*" >> "${LOG}"
}

bzz() {
  printf '%d.%04d' "$(($1 / 10000000000000000))" "$((($1 % 10000000000000000) / 1000000000000))"
}

# Prints the node's spendable chequebook balance in PLUR, or nothing when it cannot be read.
#
# Empty is meaningfully different from zero, and here it is the measurement: a node started with swap
# disabled has no chequebook and answers 405, which is the arm rather than a shortfall.
chequebook_available_plur() {
  curl -s --max-time 10 "http://127.0.0.1:${1}/chequebook/balance" 2>/dev/null |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["availableBalance"])' 2>/dev/null
}

postage_utilization() {
  curl -s --max-time 10 "http://127.0.0.1:${UPLOADER_BEE_PORT}/stamps" 2>/dev/null |
    python3 -c '
import sys,json
d=json.load(sys.stdin)["stamps"]
w=[s for s in d if s["depth"]==24 and s["immutableFlag"]]
print(max((s["utilization"] for s in w), default=""))
' 2>/dev/null
}

# Zero when both nodes can pay for the given minutes, non-zero otherwise. Reports every node rather
# than stopping at the first shortfall, because the two are funded separately and whoever reads this
# in the morning wants both figures in one message.
#
# The gateway is checked in both arms even though the unfunded one cannot spend: an arm that finds the
# gateway short is an arm whose funded half would have been measured on a starved node.
funds_cover_minutes() {
  local minutes="$1" label="$2"
  local short=0 port rate who need have
  for spec in "${UPLOADER_BEE_PORT}:${UPLOADER_BURN_PLUR_PER_MIN}:uploader" \
    "${GATEWAY_BEE_PORT}:${GATEWAY_BURN_PLUR_PER_MIN}:gateway"; do
    IFS=: read -r port rate who <<< "${spec}"
    # Dividing before the margin keeps a long sitting clear of the 64-bit ceiling. The truncation it
    # costs is twelve orders of magnitude below anything decidable.
    # shellcheck disable=SC2017
    need=$((rate * minutes / 100 * FUNDS_MARGIN_PERCENT))
    have="$(chequebook_available_plur "${port}")"
    if [ -z "${have}" ]; then
      if [ "${who}" = "gateway" ] && [ "${CURRENT_ARM_SWAP:-true}" = "false" ]; then
        say "  ${label}: gateway has no chequebook, which is this arm, so it is not a shortfall"
      else
        say "  ${label}: ${who} chequebook on ${port} did not answer, so funding is unknown"
        short=1
      fi
    elif [ "${have}" -lt "${need}" ]; then
      say "  ${label}: ${who} has $(bzz "${have}") BZZ, needs $(bzz "${need}") for ${minutes} min SHORT"
      short=1
    else
      say "  ${label}: ${who} has $(bzz "${have}") BZZ, needs $(bzz "${need}") for ${minutes} min, ok"
    fi
  done
  return ${short}
}

postage_has_room() {
  local label="$1" used
  used="$(postage_utilization)"
  if [ -z "${used}" ]; then
    say "  ${label}: postage utilization could not be read"
    return 1
  fi
  if [ "${used}" -ge "${POSTAGE_WARN_BUCKETS}" ]; then
    say "  ${label}: postage at ${used}/${POSTAGE_DEPTH_BUCKETS}, past the ${POSTAGE_WARN_BUCKETS} warn line"
    return 1
  fi
  say "  ${label}: postage at ${used}/${POSTAGE_DEPTH_BUCKETS}, ok"
  return 0
}

container_spec() {
  docker inspect "${GATEWAY_CONTAINER}" --format \
    'CMD={{json .Config.Cmd}} MOUNTS={{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}PORTS={{json .HostConfig.PortBindings}} NET={{.HostConfig.NetworkMode}}' 2>/dev/null
}

BASELINE_SPEC=""
BASELINE_SWAP=""

# The recreate is asserted against the container found at startup rather than against the compose file
# it was supposed to come from. Reconstructing this stack's environment by hand is how a node comes
# back on a default port or with an empty data directory and still looks like it started, and the
# whole arm would then be a measurement of a node that had never seen the stream.
spec_matches_baseline_except_swap() {
  local now expected
  now="$(container_spec)"
  if [ -z "${now}" ]; then
    say "  the gateway container could not be inspected after the recreate"
    return 1
  fi
  expected="${BASELINE_SPEC//--swap-enable=${BASELINE_SWAP}/--swap-enable=${CURRENT_ARM_SWAP}}"
  if [ "${now}" != "${expected}" ]; then
    say "  the recreated gateway differs from the one found at startup by more than --swap-enable"
    say "    wanted: ${expected}"
    say "    got:    ${now}"
    return 1
  fi
  return 0
}

wait_for_gateway_api() {
  local deadline=$(($(date -u +%s) + 180))
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    if curl -s -o /dev/null --max-time 5 "http://127.0.0.1:${GATEWAY_BEE_PORT}/health"; then
      return 0
    fi
    sleep 3
  done
  say "  the gateway API did not answer within 180s of the recreate"
  return 1
}

# The arm, read off the node. A funded gateway returns a balance and an ultra-light one has no
# chequebook to return, so this is the one check that says the flip reached bee rather than compose.
chequebook_shape_matches_arm() {
  local have
  have="$(chequebook_available_plur "${GATEWAY_BEE_PORT}")"
  if [ "${CURRENT_ARM_SWAP}" = "true" ]; then
    if [ -z "${have}" ]; then
      say "  arm L wants a funded gateway and the node has no chequebook"
      return 1
    fi
    say "  arm L confirmed on the node: $(bzz "${have}") BZZ spendable"
  else
    if [ -n "${have}" ]; then
      say "  arm U wants an ultra-light gateway and the node still answers with $(bzz "${have}") BZZ"
      return 1
    fi
    say "  arm U confirmed on the node: no chequebook"
  fi
  return 0
}

ARM_CHANGED=0

set_arm() {
  CURRENT_ARM_SWAP="$1"
  say "  setting BEE_GATEWAY_SWAP_ENABLE=${CURRENT_ARM_SWAP} and recreating the gateway"
  if ! sed -i "s/^BEE_GATEWAY_SWAP_ENABLE=.*/BEE_GATEWAY_SWAP_ENABLE=${CURRENT_ARM_SWAP}/" "${ENV_FILE}"; then
    say "  could not write ${ENV_FILE}"
    return 1
  fi
  ARM_CHANGED=1
  # `--no-deps` so nothing else in the stack is touched, and the port variables are exported because
  # they are resolved by `apply_port_slot` at deploy time and are not in the env file. Without them
  # compose falls back to the 1733 defaults in the compose file and the node comes up unreachable.
  (
    cd "${COMPOSE_DIR}" || exit 1
    BEE_GATEWAY_API_PORT="${GATEWAY_BEE_PORT}" \
      BEE_GATEWAY_P2P_PORT="$((GATEWAY_BEE_PORT + 1))" \
      docker compose -p "${COMPOSE_PROJECT}" \
      -f docker-compose.yml -f docker-compose.host.yml -f docker-compose.nat.yml \
      --env-file "${ENV_FILE}" \
      --profile bee-gateway \
      up -d --no-deps --force-recreate bee-gateway
  ) >> "${LOG}" 2>&1 || {
    say "  compose failed to recreate the gateway"
    return 1
  }
  wait_for_gateway_api || return 1
  spec_matches_baseline_except_swap || return 1
  chequebook_shape_matches_arm || return 1
  return 0
}

# Always leaves the gateway the way it was found. An interrupted sitting that left the node
# ultra-light would be a deployment quietly running the unfunded arm forever, and every figure taken
# on it afterwards would be wrong in a direction nobody was looking in.
restore_light() {
  stop_publisher
  # A sitting that refused to start never touched the node, and bouncing a healthy gateway to put it
  # back where it already is costs a restart and the peers that come with it.
  if [ "${ARM_CHANGED}" -eq 0 ]; then
    say "the gateway was never changed, so there is nothing to restore"
    return 0
  fi
  say "restoring the gateway to the arm it was found in (swap-enable=${BASELINE_SWAP})"
  if [ -n "${BASELINE_SWAP}" ]; then
    CURRENT_ARM_SWAP="${BASELINE_SWAP}"
    if set_arm "${BASELINE_SWAP}"; then
      say "gateway restored"
    else
      say "⛔ THE GATEWAY COULD NOT BE RESTORED. It may still be running the unfunded arm."
      say "⛔ Put it back with: sed -i 's/^BEE_GATEWAY_SWAP_ENABLE=.*/BEE_GATEWAY_SWAP_ENABLE=${BASELINE_SWAP}/' ${ENV_FILE}"
      say "⛔ then recreate bee-gateway with the compose command this script logs above."
    fi
  fi
}

PUBLISHER_PID=""

# `publish-clock.sh` names its container `swarm-hls-publish-$$`, so there is no fixed name to remove
# and killing the script only kills the poller: the ffmpeg container is deliberately detached so it
# outlives its ssh session. Removing by pattern is what actually stops a broadcast. A publisher left
# running holds the stream id, and the next arm would measure the previous arm's stream.
stop_publisher() {
  if [ -n "${PUBLISHER_PID}" ]; then
    kill "${PUBLISHER_PID}" >/dev/null 2>&1 || true
    PUBLISHER_PID=""
  fi
  docker ps -aq --filter 'name=^swarm-hls-publish-' | xargs -r docker rm -f >/dev/null 2>&1 || true
}

# The uploader keeps a stream active for a moment after its publisher goes, and an arm that started
# inside that window would take the tail of the one before it for its own.
wait_for_idle() {
  local deadline=$(($(date -u +%s) + 120)) active
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    active="$(curl -s --max-time 5 "http://127.0.0.1:${UPLOADER_API_PORT}/health" 2>/dev/null |
      python3 -c 'import sys,json;print(json.load(sys.stdin)["activeStreams"])' 2>/dev/null)"
    [ "${active:-1}" = "0" ] && return 0
    sleep 3
  done
  say "  the uploader still reports a live stream 120s after the publisher was removed"
  return 1
}

# `--host=localhost` is what makes the repo's own publisher usable from the host it publishes to.
# `config.json` names every service `manager-host`, which this machine cannot resolve for itself, and
# the override makes `run_remote` shell out instead of dialling ssh. Going through `publish-clock.sh`
# rather than composing ffmpeg here keeps the publish key derivation, the SRT spelling and the
# detached container in the one place that already gets them right.
start_publisher() {
  local seconds="$1"
  stop_publisher
  (
    cd "${BENCH_REPO}" || exit 1
    deploy/scripts/publish-clock.sh \
      "--profile=${PROFILE}" "--portSlot=${PORT_SLOT}" --host=localhost \
      "--seconds=${seconds}" "--size=${SIZE}" "--bitrate=${BITRATE_KBPS}" "--gop=${GOP_SECONDS}"
  ) >> "${LOG}" 2>&1 &
  PUBLISHER_PID=$!
}

wait_for_active_stream() {
  local deadline=$(($(date -u +%s) + 180)) active
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    active="$(curl -s --max-time 5 "http://127.0.0.1:${UPLOADER_API_PORT}/health" 2>/dev/null |
      python3 -c 'import sys,json;print(json.load(sys.stdin)["activeStreams"])' 2>/dev/null)"
    if [ "${active:-0}" -ge 1 ] 2>/dev/null; then
      return 0
    fi
    sleep 3
  done
  say "  no stream reached the uploader within 180s of the publisher starting"
  return 1
}

newest_report() {
  local newest="" candidate
  for candidate in "${BENCH_REPO}"/docs/bench/browser-watch-*.json; do
    [ -e "${candidate}" ] || continue
    # `browser-watch-<id>.requests.json` sits beside the report and matches the same glob, and being
    # written last it is what "newest" finds. The proving pass picked it, validated a document with no
    # `instrument` in it, and returned an empty verdict that would have failed the gate on a run that
    # had actually gone fine.
    case "${candidate}" in *.requests.json) continue ;; esac
    if [ -z "${newest}" ] || [ "${candidate}" -nt "${newest}" ]; then
      newest="${candidate}"
    fi
  done
  echo "${newest}"
}

# Checked against what it asked for rather than merely that it exited zero. A browser run that
# degraded its own subject still exits zero and still writes a report full of plausible numbers, which
# is the failure this harness was rebuilt to report as VOID rather than as a figure.
validate_report() {
  local path="$1" want_samples="$2"
  python3 - "${path}" "${want_samples}" <<'PY'
import json, sys
path, want = sys.argv[1], int(sys.argv[2])
try:
    d = json.load(open(path))
except Exception as exc:
    print(f"UNREADABLE-REPORT({exc.__class__.__name__})"); sys.exit(0)
# Anything that is not a report says so, rather than raising on the first `.get` and leaving the
# caller with an empty verdict that reads like a run nobody judged.
if not isinstance(d, dict):
    print(f"NOT-A-REPORT({type(d).__name__})"); sys.exit(0)
ins, sm = d.get("instrument", {}), d.get("summary", {})
if not ins.get("sound"):
    print(f"VOID(instrument: {'; '.join(ins.get('failures') or ['unstated'])})"); sys.exit(0)
n = sm.get("samples") or 0
if n < want:
    print(f"THIN({n} samples, wanted {want})"); sys.exit(0)
ratio, stalled = sm.get("overallAdvanceRatio"), sm.get("stalledSamples")
if ratio is None:
    print("NO-ADVANCE-RATIO"); sys.exit(0)
print(
    f"ok advance={ratio:.3f} stalled={stalled} rebuffers={sm.get('rebufferCount')} "
    f"fps={(sm.get('deliveredFps') or 0):.1f} median-latency={(sm.get('latency') or {}).get('medianLatencyS')}"
)
PY
}

run_arm() {
  local label="$1" swap="$2" watch_seconds="$3" warm_seconds="$4" round="$5"
  local started verdict report gw_before gw_after
  started="$(date -u +%s)"
  say "round ${round}: arm ${label} (swap-enable=${swap}, ${watch_seconds}s watch) starting"

  if ! set_arm "${swap}"; then
    record_row "${round}" "${label}" "${swap}" "${watch_seconds}" "ARM-NOT-SET"
    return 1
  fi

  say "  warming the node for ${warm_seconds}s before anything is measured"
  sleep "${warm_seconds}"

  local minutes=$(((watch_seconds + PUBLISH_MARGIN_SECONDS + 59) / 60))
  if ! funds_cover_minutes "${minutes}" "before ${label}"; then
    record_row "${round}" "${label}" "${swap}" "${watch_seconds}" "NOT-RUN(funds)"
    return 1
  fi
  if ! postage_has_room "before ${label}"; then
    record_row "${round}" "${label}" "${swap}" "${watch_seconds}" "NOT-RUN(postage)"
    return 1
  fi

  gw_before="$(chequebook_available_plur "${GATEWAY_BEE_PORT}")"
  start_publisher "$((watch_seconds + PUBLISH_MARGIN_SECONDS))"
  if ! wait_for_active_stream; then
    stop_publisher
    record_row "${round}" "${label}" "${swap}" "${watch_seconds}" "NO-INGEST"
    return 1
  fi

  say "  stream is live, opening the browser for ${watch_seconds}s"
  (
    cd "${BENCH_REPO}" || exit 1
    docker run --rm --network host \
      -u "$(id -u):$(id -g)" \
      --group-add "$(getent group docker | cut -d: -f3)" \
      --shm-size=2g \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "${BENCH_REPO}:/repo" \
      -e HOME=/tmp \
      -w /repo \
      -e E2E_SSH_TARGET=local \
      -e E2E_PUBLIC_HOST=127.0.0.1 \
      -e "E2E_PROFILE=${PROFILE}" \
      -e "E2E_PORT_SLOT=${PORT_SLOT}" \
      -e "BROWSER_CLIENT_URL=http://127.0.0.1:${CLIENT_PORT}" \
      -e "BROWSER_WATCH_SECONDS=${watch_seconds}" \
      -e "BROWSER_GOP_SECONDS=${GOP_SECONDS}" \
      "${BROWSER_IMAGE}" pnpm browser:watch
  ) >> "${LOG}" 2>&1
  local status=$?
  stop_publisher
  wait_for_idle
  gw_after="$(chequebook_available_plur "${GATEWAY_BEE_PORT}")"

  if [ ${status} -ne 0 ]; then
    verdict="RUN-FAILED(${status})"
  else
    report="$(newest_report)"
    if [ -z "${report}" ]; then
      verdict="NO-REPORT"
    else
      # A tenth of the samples a full-rate run would take, which catches a run that opened and
      # collapsed without failing a run that merely lost a few samples to a slow minute.
      verdict="$(validate_report "${report}" "$((watch_seconds / 10))")"
      # A validator that dies prints nothing, and an empty verdict is indistinguishable from a run
      # nobody judged once it is in the state file. Name it instead.
      [ -n "${verdict}" ] || verdict="UNVALIDATED(the validator produced no verdict)"
      cp "${report}" "${REPORTS}/${label}-round${round}-$(basename "${report}")" 2>/dev/null
      cp "${report%.json}.md" "${REPORTS}/${label}-round${round}-$(basename "${report%.json}").md" 2>/dev/null
    fi
  fi

  if [ -n "${gw_before}" ] && [ -n "${gw_after}" ]; then
    verdict="${verdict} gw-spent=$(bzz "$((gw_before - gw_after))")"
  elif [ -z "${gw_before}" ] && [ -z "${gw_after}" ]; then
    verdict="${verdict} gw-spent=none(no chequebook)"
  fi

  say "  ${verdict}"
  record_row "${round}" "${label}" "${swap}" "${watch_seconds}" "${verdict}"
  say "round ${round}: arm ${label} finished in $(( $(date -u +%s) - started ))s"
  case "${verdict}" in ok*) return 0 ;; *) return 1 ;; esac
}

record_row() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$4" "$5" >> "${STATE}"
}

: > "${LOG}"
: > "${STATE}"
say "phase 0.6 starting: light against ultra-light at a viewer, ${SIZE} ${BITRATE_KBPS}k gop ${GOP_SECONDS}"

BASELINE_SPEC="$(container_spec)"
if [ -z "${BASELINE_SPEC}" ]; then
  say "REFUSING TO START: ${GATEWAY_CONTAINER} could not be inspected, so there is nothing to restore to."
  exit 1
fi
case "${BASELINE_SPEC}" in
  *'--swap-enable=true'*) BASELINE_SWAP=true ;;
  *'--swap-enable=false'*) BASELINE_SWAP=false ;;
  *)
    say "REFUSING TO START: the gateway command has no --swap-enable, so this stack is not the one this script was written against."
    exit 1
    ;;
esac
CURRENT_ARM_SWAP="${BASELINE_SWAP}"
say "found the gateway at swap-enable=${BASELINE_SWAP}, and that is what it will be put back to"
trap restore_light EXIT INT TERM

ACTIVE="$(curl -s --max-time 10 "http://127.0.0.1:${UPLOADER_API_PORT}/health" 2>/dev/null |
  python3 -c 'import sys,json;print(json.load(sys.stdin)["activeStreams"])' 2>/dev/null)"
if [ "${ACTIVE:-x}" != "0" ]; then
  say "REFUSING TO START: the uploader reports activeStreams=${ACTIVE:-unreadable}. Something else is"
  say "  broadcasting into this stack, and two publishers on one stream id measure each other."
  exit 1
fi

TOTAL_MINUTES=$(((2 * (PROVING_WATCH_SECONDS + PUBLISH_MARGIN_SECONDS) + 4 * (FULL_WATCH_SECONDS + PUBLISH_MARGIN_SECONDS)) / 60))
say "checking both chequebooks cover ${TOTAL_MINUTES} min at a ${FUNDS_MARGIN_PERCENT}% margin"
if ! funds_cover_minutes "${TOTAL_MINUTES}" "preflight"; then
  say "REFUSING TO START: this sitting cannot pay for itself. Nothing has been changed."
  exit 1
fi
if ! postage_has_room "preflight"; then
  say "REFUSING TO START: the postage batch has no room for this sitting."
  exit 1
fi

if [ "${PREFLIGHT_ONLY:-0}" = "1" ]; then
  say "PREFLIGHT_ONLY, so stopping here without publishing anything"
  exit 0
fi

say "--- proving pass: one short arm of each, to find out whether any of this works ---"
PROVING_OK=1
for arm in "L:true" "U:false"; do
  IFS=: read -r label swap <<< "${arm}"
  run_arm "${label}" "${swap}" "${PROVING_WATCH_SECONDS}" "${PROVING_WARM_SECONDS}" 0 || PROVING_OK=0
done

if [ "${PROVING_OK}" -ne 1 ]; then
  say "⛔ PROVING PASS FAILED. Stopping before the sitting rather than spending it on an instrument"
  say "  that has not shown it can measure either arm. The rows above name which arm failed and how."
  exit 1
fi
say "✅ proving pass carried both arms. Going on to the full sitting."

# L, U, L, U in one sitting. Two sittings of one configuration have differed by 1.05s, which is larger
# than the effect this is looking for, so arms compared across sittings are not compared at all.
for round in 1 2; do
  for arm in "L:true" "U:false"; do
    IFS=: read -r label swap <<< "${arm}"
    run_arm "${label}" "${swap}" "${FULL_WATCH_SECONDS}" "${FULL_WARM_SECONDS}" "${round}"
  done
done

say "--- sitting done ---"
say "$(grep -c "	ok" "${STATE}" 2>/dev/null || echo 0) arms measured, $(grep -cE "VOID|THIN|FAILED|NO-|NOT-RUN|UNREADABLE" "${STATE}" 2>/dev/null || echo 0) not"
say "reports are in ${REPORTS}"
