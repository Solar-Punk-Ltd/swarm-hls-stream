#!/usr/bin/env bash
#
# Write the spend ledger: the ceiling the owner authorised, and one chequebook baseline per node that
# can spend.
#
# ## Why this is a script and not a paste
#
# ⛔ The ceiling is the owner's number and this script cannot invent one. `--authorise` is required
# and has no default, because a default ceiling is an authorisation nobody gave.
#
# Everything else in the file is a reading, and readings are what go wrong by hand. A baseline is a
# balance in PLUR, seventeen digits of it, and there is now one per node: four publishers and a
# gateway on a split stage. They also move every minute a node is up, so a number copied into the
# file is stale from the moment it is read, and a stale baseline does not read as stale. It reads as
# spend that did or did not happen.
#
# The node set comes from the uploader's own `/health` routing rather than from this script's idea of
# the deployment, for the reason the gate itself does: a node added to the stage must not be one the
# ceiling is blind to. That is exactly what happened on 2026-08-31, when the publisher became one Bee
# node per ABR rung and three new nodes spent unwatched while holding 5.00 BZZ each.
#
# ⛔ It never moves money. No buy, no top-up, no deposit, no dilute. It reads balances and writes a
# file.
#
# Usage:
#   deploy/scripts/spend-ledger.sh --profile=latbench --portSlot=7 --authorise=12.5
#   deploy/scripts/spend-ledger.sh --profile=latbench --portSlot=7 --authorise=12.5 --dry-run
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$SCRIPT_DIR/_lib.sh"

AUTHORISE_BZZ=""
DRY_RUN=0

parse_profile_args "$@"
# ⛔ `${arr[@]+"${arr[@]}"}` and not `"${REST_ARGS[@]}"`: macOS ships bash 3.2, where an EMPTY array
# expanded under `set -u` is an unbound variable rather than an empty list. See bee-publishers.sh,
# which shipped with exactly that bug because every path tested passed a third flag.
set -- ${REST_ARGS[@]+"${REST_ARGS[@]}"}
while [ $# -gt 0 ]; do
  case "$1" in
    --authorise=*) AUTHORISE_BZZ="${1#*=}"; shift ;;
    --authorise) AUTHORISE_BZZ="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "${AUTHORISE_BZZ}" ]; then
  echo "spend-ledger: REFUSING, no --authorise=<BZZ>."
  echo "  The ceiling is the owner's to set and there is no default for it. A ledger written from a"
  echo "  default is an authorisation nobody gave."
  exit 2
fi

CEILING_PLUR="$(AUTHORISE="${AUTHORISE_BZZ}" python3 -c '
import os, re, sys
from decimal import Decimal, InvalidOperation

raw = os.environ["AUTHORISE"].strip()
if not re.fullmatch(r"[0-9]+(\.[0-9]{1,16})?", raw):
    print("")
    sys.exit(0)
try:
    bzz = Decimal(raw)
except InvalidOperation:
    print("")
    sys.exit(0)
# Decimal rather than float: 1 BZZ is 1e16 PLUR, so a value like 12.5 read through a float loses its
# last digits and the ceiling written is not the ceiling authorised.
plur = (bzz * Decimal(10) ** 16).to_integral_value()
print(int(plur) if plur > 0 else "")
')"

if [ -z "${CEILING_PLUR}" ]; then
  echo "spend-ledger: REFUSING, --authorise=${AUTHORISE_BZZ} is not a positive amount of BZZ."
  echo "  Whole or decimal, up to 16 places, no unit suffix. For example --authorise=12.5"
  exit 2
fi

require_env
load_env
apply_port_slot

TARGET="$(get_target "$SVC_UPLOADER")"
LEDGER="${SPEND_LEDGER:-${SCRIPT_DIR}/../../.spend-ledger.env}"

# ⛔⛔⛔ A FAILED TRANSPORT AND AN UNANSWERED SERVICE ARE NOT THE SAME REFUSAL, and they arrive as the
# same empty string. On 2026-08-31 a wedged 1Password SSH agent made this script report that the
# uploader was not deployed, which was false: the uploader was healthy and the ssh could not sign. A
# whole measurement arm has already been lost to that confusion, six reds that all read as product
# faults. ssh exits 255 for connection and authentication failures and passes the remote command's
# status through otherwise, so the two are separable and are separated here.
read_url() {
  local port="$1" path="$2"
  if [ "$TARGET" = "localhost" ]; then
    curl -s --max-time 10 "http://127.0.0.1:${port}${path}" 2>/dev/null
    return $?
  fi
  ssh -o ConnectTimeout=10 "$TARGET" "curl -s --max-time 10 'http://127.0.0.1:${port}${path}'" 2>/dev/null
  return $?
}

SSH_TRANSPORT_FAILED=255

# Refuse the transport, naming it, rather than letting the caller blame whatever it was reading.
refuse_unreachable() {
  echo "spend-ledger: REFUSING, could not reach ${TARGET} over ssh."
  echo "  That is the transport and not the deployment, so nothing here says anything about the stack."
  echo "  On this machine it is usually the 1Password SSH agent listing keys and refusing to sign,"
  echo "  which needs 1Password fully quit and reopened rather than merely unlocked. Check with:"
  echo "    ssh-add -l && ssh ${TARGET} true"
  echo "  Nothing was read and nothing was written."
  exit 1
}

HEALTH="$(read_url "${API_PORT}" /health)"
if [ "$?" = "${SSH_TRANSPORT_FAILED}" ] && [ "$TARGET" != "localhost" ]; then
  refuse_unreachable
fi
if [ -z "${HEALTH}" ]; then
  echo "spend-ledger: REFUSING, the uploader on :${API_PORT} did not answer /health."
  echo "  The node set is read off its routing, and a deployment that cannot say which node carries"
  echo "  which rung is not one whose spend can be baselined. Deploy it first:"
  echo "    deploy/scripts/deploy.sh --profile=${PROFILE} --portSlot=${PORT_SLOT} stream-uploader"
  exit 1
fi

# The ports to baseline, as "port name" lines, deduplicated: two rungs can share one Bee node, and
# baselining it twice would double-count its spend.
NODES="$(printf '%s' "${HEALTH}" | python3 -c '
import json, sys

try:
    routes = json.load(sys.stdin).get("publishers")
except (ValueError, AttributeError) as error:
    print(f"REFUSE\tthe uploader answered /health with something unreadable ({error})")
    sys.exit(0)

if not routes:
    print("REFUSE\tthe uploader reported no publisher routing on /health. An older build does not "
          "carry it, and a deployment that cannot name its nodes cannot have their spend baselined")
    sys.exit(0)

seen = {}
order = []
for route in routes:
    url = str(route.get("url", ""))
    port = url.rsplit(":", 1)[-1].split("/")[0]
    if not port.isdigit():
        rung = route.get("rung")
        print(f"REFUSE\tthe {rung} route names {url!r}, which has no port this host can dial")
        sys.exit(0)
    if port in seen:
        seen[port].append(str(route.get("rung")))
        continue
    seen[port] = [str(route.get("rung"))]
    order.append(port)

for port in order:
    print("OK\t%s\t%s publisher" % (port, "/".join(seen[port])))
')"

if printf '%s' "${NODES}" | grep -q '^REFUSE'; then
  echo "spend-ledger: $(printf '%s' "${NODES}" | sed -n 's/^REFUSE\t//p')."
  exit 1
fi

PORTS=""
NAMES=""
while IFS="$(printf '\t')" read -r verdict port name; do
  [ "${verdict}" = "OK" ] || continue
  PORTS="${PORTS}${PORTS:+ }${port}"
  NAMES="${NAMES}${NAMES:+|}${port}=${name}"
done << ROUTES
${NODES}
ROUTES

# The gateway spends too, on retrieval, and it is not in the publisher routing.
case " ${PORTS} " in
  *" ${BEE_GATEWAY_API_PORT} "*) ;;
  *)
    PORTS="${PORTS}${PORTS:+ }${BEE_GATEWAY_API_PORT}"
    NAMES="${NAMES}|${BEE_GATEWAY_API_PORT}=gateway"
    ;;
esac

BALANCES=""
for port in ${PORTS}; do
  body="$(read_url "${port}" /chequebook/balance)"
  # shellcheck disable=SC2181
  if [ "$?" = "${SSH_TRANSPORT_FAILED}" ] && [ "$TARGET" != "localhost" ]; then
    refuse_unreachable
  fi
  plur="$(printf '%s' "${body}" | python3 -c '
import json, re, sys

try:
    value = json.load(sys.stdin).get("availableBalance")
except (ValueError, AttributeError):
    value = None
# ⛔ Absence is a refusal, never a zero. A node mid-restart answers its own JSON error envelope, which
# parses cleanly and carries no balance, and a baseline of zero would read every later balance as a
# rise and end the ledger it was just written into.
print(value if isinstance(value, str) and re.fullmatch(r"[0-9]+", value) else "")
')"
  if [ -z "${plur}" ]; then
    echo "spend-ledger: REFUSING, the node on :${port} did not answer with an availableBalance."
    echo "  A baseline it cannot read is not a baseline of zero, so nothing has been written."
    exit 1
  fi
  BALANCES="${BALANCES}${BALANCES:+ }${port}:${plur}"
done

AUTHORISED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "spend-ledger: ${PROFILE}, ceiling $(printf '%s' "${AUTHORISE_BZZ}") BZZ, baselines read just now"
for entry in ${BALANCES}; do
  port="${entry%%:*}"
  plur="${entry##*:}"
  name="$(printf '%s' "${NAMES}" | tr '|' '\n' | sed -n "s/^${port}=//p")"
  printf '  %-18s :%s  %s.%04d BZZ\n' "${name}" "${port}" \
    "$((plur / 10000000000000000))" "$(((plur % 10000000000000000) / 1000000000000))"
done

if [ "${DRY_RUN}" = "1" ]; then
  echo ""
  echo "spend-ledger: --dry-run, ${LEDGER} not written."
  exit 0
fi

if [ -r "${LEDGER}" ]; then
  BACKUP="${LEDGER}.bak-$(date +%Y%m%d-%H%M%S)"
  cp "${LEDGER}" "${BACKUP}"
fi

# Rewritten whole rather than edited. A ledger is one authorisation: a file carrying a new ceiling
# beside an old baseline measures a night against a decision that was never made.
{
  echo "# The owner's spend authorisation. Written by deploy/scripts/spend-ledger.sh."
  echo "# Regenerate it rather than editing it: a baseline is a balance, and balances move."
  echo "authorised_at=${AUTHORISED_AT}"
  echo "ceiling_plur=${CEILING_PLUR}"
  for entry in ${BALANCES}; do
    port="${entry%%:*}"
    plur="${entry##*:}"
    echo "# $(printf '%s' "${NAMES}" | tr '|' '\n' | sed -n "s/^${port}=//p")"
    echo "node_${port}_start_plur=${plur}"
  done
} > "${LEDGER}"

echo ""
echo "spend-ledger: wrote ${LEDGER}${BACKUP:+ (previous file at ${BACKUP##*/})}."
echo "  Both gates read it: the e2e preflight and deploy/scripts/spend-ceiling.sh."
