#!/usr/bin/env bash
#
# The second gateway of #93: an ultra-light bee node, deliberately unfunded, running beside the funded
# one so both can be warm at the same time.
#
# ## The question it exists for
#
# Every viewer-side figure this project holds was measured through a **chequebook-funded** light
# gateway. That is the best case and not the shipping case: a real viewer runs ultra-light, or a light
# node nobody funded, which is the state a viewer reaches simply by watching. The one prior attempt to
# measure the difference read both arms through the bench's `/feeds/` head lookup, which is 50-57%
# frozen on its own and which a viewer never calls, so it does not survive.
#
# ## Why both nodes have to be up at once
#
# The arms alternate under ONE broadcast, switched at runtime through the client's own
# `setGatewayUrl`. Two soaks scored against each other is the between-sitting confound the interleaved
# GOP arms caught on 2026-08-12, where every difference between two hours of the night sits inside the
# result. Alternating needs both nodes warm, so the unfunded one cannot be the funded one reconfigured.
#
# ## Why it is standalone rather than a compose service, and that is a safety property
#
# ⛔⛔ This host runs the live latbench stack plus forty other bee nodes and eight unrelated stacks.
# A compose change can recreate services that were never meant to move, and the funded gateway losing
# its warm peer set mid-sitting would quietly become the cold-join penalty rather than the funded arm.
# Nothing here touches the compose project at all.
#
# ⛔⛔⛔ Teardown is BY EXACT NAME, never by pattern. A teardown keyed on a name pattern removed the
# publisher serving a live paid broadcast on 2026-08-12, and the sitting sampled a dead stream for
# forty minutes afterwards.
#
# Usage, on the deployment host:
#   bash deploy/scripts/unfunded-gateway.sh start
#   bash deploy/scripts/unfunded-gateway.sh wait 40      # peers, not "does it answer"
#   bash deploy/scripts/unfunded-gateway.sh status
#   bash deploy/scripts/unfunded-gateway.sh stop
set -u

# Exact, and used for every lookup and the removal. Nothing here ever filters on a prefix.
CONTAINER="${UNFUNDED_CONTAINER:-swarm-hls-unfunded-gateway}"

# 10087/10088 are free: 10020-10038, 10060-10066 and 10070-10078 are taken on this host, and the
# funded gateway is 10077. Checked again at start, because a shared box does not stay still.
API_PORT="${UNFUNDED_API_PORT:-10087}"
P2P_PORT="${UNFUNDED_P2P_PORT:-10088}"

# Matches the stack's bee, so the two arms differ in funding and in nothing else.
IMAGE="${UNFUNDED_IMAGE:-ethersphere/bee:2.8.2}"

# ⛔⛔ THE STACK'S GATEWAY USES A LOCAL RPC, NOT A PUBLIC ONE. Read off the running container:
# `--blockchain-rpc-endpoint=http://127.0.0.1:9000`. A first version of this script defaulted to
# `https://rpc.gnosischain.com`, which is a different node, a different latency and a public rate
# limit, and it would have been a second difference between the arms on top of the funding.
RPC_ENDPOINT="${RPC_ENDPOINT:-http://127.0.0.1:9000}"

# ⛔⛔⛔ EVERY FLAG THE FUNDED GATEWAY CARRIES, so the two arms differ in `--swap-enable` and NOTHING
# ELSE. Read off `docker inspect latbench-bee-gateway-1` rather than copied from the compose file,
# because the compose file is a template and the running container is what the funded arm actually is.
#
# ⭐ `--cors-allowed-origins` is not optional decoration here: the viewer fetches from a browser, so
# without it every retrieval in the unfunded arm fails at the preflight and the arm reads as a node
# that cannot serve rather than as one that is unfunded.
#
# ⭐ `--cache-capacity` and `--cache-retrieval` decide whether the node keeps what it fetched, which
# is the single largest lever on a second read. Two arms disagreeing on it would not be a funding
# comparison at all.
MATCHED_FLAGS=(
  --cache-capacity=0
  --cache-retrieval=true
  '--cors-allowed-origins=*'
  --verbosity=4
)

# bee refuses to boot without one and prompts on a terminal it does not have, so a detached container
# dies immediately with `configure signer: inappropriate ioctl for device`. Found by running this for
# real: no stub asks bee for a password.
#
# ⚠️ It protects nothing of value. This node has no chequebook and holds no funds by construction,
# which is the entire point of the arm.
PASSWORD_FILE_IN_CONTAINER=/home/bee/.bee/password

# Outside every rsync target, which are synced with --delete.
DATA_DIR="${UNFUNDED_DATA_DIR:-/home/solarpunk/unfunded-gateway/data}"

# The funded gateway advertises `BEE_NAT_ADDR=<public ip>:10078` so peers can dial it back. Without
# one this node is reachable only outbound, which changes how many peers keep it, and peer count is a
# variable this comparison has to hold still. The host part is read off the funded gateway rather than
# hardcoded, so a machine move cannot leave a stale address here.
NAT_HOST="${UNFUNDED_NAT_HOST:-$(docker inspect "${FUNDED_CONTAINER:-latbench-bee-gateway-1}" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
  sed -n 's/^BEE_NAT_ADDR=\([^:]*\):.*/\1/p' | head -1)}"
NAT_ADDR="${NAT_HOST}:${P2P_PORT}"

# ⛔ A cold node answers /health long before it is useful, measured at 2-3x read cost for about two
# minutes. So warming waits on PEERS. A sitting that starts before this returns measures the cold
# penalty and files it as the unfunded arm.
WARM_TIMEOUT_S="${WARM_TIMEOUT_S:-600}"
WARM_POLL_S="${WARM_POLL_S:-5}"

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

exists() {
  docker ps -aq --filter "name=^${CONTAINER}$" 2>/dev/null | grep -q .
}

port_held() {
  ss -ltn 2>/dev/null | grep -qE "[:.]${1}[[:space:]]"
}

peer_count() {
  curl -s --max-time 10 "http://127.0.0.1:${API_PORT}/peers" 2>/dev/null |
    python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("peers",[])))' 2>/dev/null
}

start_node() {
  if exists; then
    say "REFUSING: ${CONTAINER} already exists. Stop it first rather than racing a node that may"
    say "  already be warm and measured. \`unfunded-gateway.sh stop\` removes it."
    return 1
  fi
  for port in "${API_PORT}" "${P2P_PORT}"; do
    if port_held "${port}"; then
      say "REFUSING: port ${port} is already held on this host, and it is not ours to take."
      say "  Forty other bee nodes share this box. Pick another with UNFUNDED_API_PORT/UNFUNDED_P2P_PORT."
      return 1
    fi
  done

  mkdir -p "${DATA_DIR}"
  # ⛔ bee runs as uid 999 inside the image and creates `keys/` and `localstore/` under this mount,
  # while the directory belongs to uid 1000 out here and there is no passwordless sudo to chown
  # across. Without this it dies on `swarm key: mkdir .bee/keys: permission denied`. The funded
  # gateway's own data directory is 777 for exactly this reason, so this matches the arm it is
  # compared against rather than inventing a second difference.
  chmod 777 "${DATA_DIR}"
  if [ ! -s "${DATA_DIR}/password" ]; then
    # `head -c 24 /dev/urandom | base64` rather than a fixed string, so nothing here is a credential
    # anybody could reuse. Never echoed.
    head -c 24 /dev/urandom | base64 > "${DATA_DIR}/password" || {
      say "could not write a password file into ${DATA_DIR}, and bee will not boot without one"
      return 1
    }
    # ⛔ 644, not 600, and that is forced rather than chosen. bee runs as uid 999 inside the image
    # while the mount is written by uid 1000 out here, and this host has no passwordless sudo to
    # chown across that. A 600 file gives `configure signer: open .bee/password: permission denied`,
    # which is the second way this script failed against a real node.
    #
    # ⚠️ It guards nothing by construction: an ultra-light node has no chequebook and holds no funds,
    # which is the entire point of the arm. The funded gateway beside it solves the same problem with
    # 777, so this is strictly the tighter of the two.
    chmod 644 "${DATA_DIR}/password"
    say "  wrote a fresh password file, which this node needs to boot and which protects nothing"
  fi

  # ⭐ `--swap-enable=false` with `--full-node=false` is bee's ultra-light mode: no chequebook at all,
  # so no way to pay a peer for bandwidth, so it lives on the free allowance alone. That is precisely
  # the viewer this project ships to and has never once measured.
  docker run -d \
    --name "${CONTAINER}" \
    --restart no \
    --network host \
    -e "BEE_NAT_ADDR=${NAT_ADDR}" \
    -v "${DATA_DIR}:/home/bee/.bee" \
    "${IMAGE}" \
    start \
    "--api-addr=:${API_PORT}" \
    "--p2p-addr=:${P2P_PORT}" \
    "--blockchain-rpc-endpoint=${RPC_ENDPOINT}" \
    "--password-file=${PASSWORD_FILE_IN_CONTAINER}" \
    --full-node=false \
    --swap-enable=false \
    "${MATCHED_FLAGS[@]}" > /dev/null || {
    say "docker refused to start ${CONTAINER}"
    return 1
  }
  say "${CONTAINER} started on api ${API_PORT}, p2p ${P2P_PORT}, ultra-light and unfunded"
  say "  it is NOT warm yet. Run: unfunded-gateway.sh wait <min_peers>"
  return 0
}

# Waits on peers rather than on the node answering, and says how many it reached either way.
wait_warm() {
  local floor="${1:-40}" deadline seen
  deadline=$(($(date -u +%s) + WARM_TIMEOUT_S))
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    seen="$(peer_count)"
    if [ -n "${seen}" ] && [ "${seen}" -ge "${floor}" ] 2>/dev/null; then
      say "warm: ${seen} peers, at or above the floor of ${floor}"
      return 0
    fi
    sleep "${WARM_POLL_S}"
  done
  say "REFUSING: reached only ${seen:-0} peers against a floor of ${floor} in ${WARM_TIMEOUT_S}s."
  say "  A cold node answers /health long before it is useful, so measuring now would file the"
  say "  cold-join penalty as the unfunded arm. See docs/bench for the 2-3x read cost while cold."
  return 1
}

# ⛔ Reads the chequebook deliberately, because ITS ABSENCE IS THE ARM. An ultra-light node has no
# chequebook and answers non-200, and every funding gate in this repo has to be told that here that is
# the treatment rather than a shortfall.
report_status() {
  # ⛔⛔⛔ Non-zero, because this exit code is what a sitting gates its arms on. A missing node is
  # emphatically not "an unfunded gateway", and answering zero here would be a gate stuck OPEN: the
  # driver would clear a condition that does not exist, then run arms against a port nothing is
  # listening on. That is the same shape as the phase06 filter that matched no batch, and the
  # dangerous way round, since a gate stuck closed at least refuses.
  if ! exists; then
    say "${CONTAINER} is not running, so there is no unfunded arm to measure"
    return 1
  fi
  local peers code
  peers="$(peer_count)"
  say "${CONTAINER} up on ${API_PORT}, ${peers:-unknown} peers"

  # ⛔ Read as a STATUS CODE, not as a curl exit code. `curl -s` exits 0 for any HTTP response it
  # received, including a 405, so the first version of this check called a correctly ultra-light node
  # "not the arm". Found against the real node, which no stub would have shown.
  #
  # ⛔⛔ And there are THREE answers here, not two. A booting node returns 503 "Node is syncing",
  # which says nothing about whether it has a chequebook. Collapsing that into either verdict would
  # either clear a node nobody has checked or reject one that is merely young.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    "http://127.0.0.1:${API_PORT}/chequebook/balance" 2>/dev/null)"
  case "${code}" in
    200)
      say "  ⚠️ it ANSWERED /chequebook/balance, so it has one and this is NOT the unfunded arm"
      return 1
      ;;
    503)
      say "  still syncing (503), so whether it is ultra-light cannot be read yet. Not ready."
      return 1
      ;;
    '' | 000)
      say "  the api did not answer at all, so nothing about this node is known"
      return 1
      ;;
    *)
      say "  no chequebook (HTTP ${code}), which is the arm: it lives on the free allowance alone"
      return 0
      ;;
  esac
}

stop_node() {
  if ! exists; then
    say "nothing to stop"
    return 0
  fi
  docker rm -f "${CONTAINER}" > /dev/null 2>&1 || true
  say "removed ${CONTAINER} by exact name"
  return 0
}

case "${1:-}" in
  start) start_node ;;
  wait) wait_warm "${2:-40}" ;;
  status) report_status ;;
  stop) stop_node ;;
  *)
    echo "usage: unfunded-gateway.sh start | wait <min_peers> | status | stop" >&2
    exit 2
    ;;
esac
