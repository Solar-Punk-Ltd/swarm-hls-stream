#!/usr/bin/env bash
#
# Build the BEE_PUBLISHERS line for a per-rung deployment, by asking each rung's Bee node which
# postage batch it holds.
#
# ## Why this is a script and not a paste
#
# BEE_PUBLISHERS is four entries of `rung@url<batch>`, and a batch id is 64 hex characters. Typing
# that by hand has one likely outcome and it is the wrong one: dotenv truncates a value at the first
# `#`, a paste loses a character, a batch gets replaced and the line still names the old one. Every
# one of those arrives as an upload failure mid-broadcast or as a rung quietly spending a batch sized
# for a different bitrate.
#
# It is also live state. Which batch a node holds changes when one fills, expires or is replaced, so a
# value copied into a file is stale from the moment a batch is bought. Asking the node is the only
# reading that is true when it is taken.
#
# ## What it refuses
#
# The same two conditions `PostageGate` refuses at startup, with the same numbers, deliberately: a
# batch under the TTL floor or over the utilization ceiling. Refusing here means an operator learns it
# while editing config rather than from a service that will not come up. It also refuses a node with
# no usable batch at all, and a ladder whose rungs this script has no node for.
#
# ⛔ It never prints a whole batch id. The line it writes carries them, because that is what the line
# is for, but everything on stdout is truncated to eight characters: a scrollback outlives the command
# and a full id is indistinguishable from a wallet private key to anything reading either.
#
# Usage:
#   deploy/scripts/bee-publishers.sh --profile=latbench --portSlot=7            # print the line
#   deploy/scripts/bee-publishers.sh --profile=latbench --portSlot=7 --write    # put it in .env.latbench
#   deploy/scripts/bee-publishers.sh --profile=latbench --portSlot=7 --stamps-from=<dir>
#
# --stamps-from reads `<dir>/<port>.json` instead of dialing anything, which is how the script's own
# selection and refusal paths get verified without a deployment.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$SCRIPT_DIR/_lib.sh"

WRITE=0
STAMPS_FROM=""
# The same floor and ceiling PostageGate applies at startup (STAMP_MIN_TTL_HOURS,
# STAMP_MAX_UTILIZATION). Kept in step on purpose so the config this writes is config the service
# will accept, and a batch that fails here fails there for the same stated reason.
MIN_TTL_HOURS="${STAMP_MIN_TTL_HOURS:-24}"
MAX_UTILIZATION="${STAMP_MAX_UTILIZATION:-0.9}"

parse_profile_args "$@"
set -- "${REST_ARGS[@]}"
while [ $# -gt 0 ]; do
  case "$1" in
    --write) WRITE=1; shift ;;
    --stamps-from=*) STAMPS_FROM="${1#*=}"; shift ;;
    --stamps-from) STAMPS_FROM="$2"; shift 2 ;;
    -h|--help) sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

require_env
load_env
apply_port_slot

# ⛔ The one hardcoded map in this script, and it has to be: the deploy has exactly these services.
# A ladder with a rung not named here has no node to publish through, and the check below refuses
# rather than writing a line that covers three rungs of four. Adding a rung means adding a
# `bee-uploader-<rung>` service in docker-compose.yml, its ports in _lib.sh, and a line here.
#
# Ascending by height, which is the order `AbrLadder.rungs()` hands the pool and therefore the order
# the lowest rung ends up as the coordinator. 360p rides the shared bee-uploader because the catalog
# and every ladder master go through the coordinator, and that node is the one a viewer needs to open
# the stage at all.
RUNG_PORT_VARS=(
  "360p:BEE_UPLOADER_API_PORT"
  "480p:BEE_RUNG_480P_API_PORT"
  "720p:BEE_RUNG_720P_API_PORT"
  "1080p:BEE_RUNG_1080P_API_PORT"
)

# The ladder the uploader and the SRS entrypoint both fall back to when ABR_LADDER is empty. Mirrors
# DEFAULT_LADDER_SPEC in packages/stream-uploader/src/libs/AbrLadder.ts. Blank is not "no rungs".
LADDER_SPEC="${ABR_LADDER:-1080p:1920:1080:5000 720p:1280:720:2800 480p:854:480:1200 360p:640:360:700}"

if [ "${ABR_ENABLED:-false}" != "true" ]; then
  echo "bee-publishers: REFUSING, ABR_ENABLED is '${ABR_ENABLED:-unset}' for profile ${PROFILE}."
  echo "  Per-rung publishers have no ladder to map onto, and the uploader refuses to start with both."
  exit 1
fi

# Every rung the engine transcodes must have a node here, and every node here must be a rung the
# engine transcodes. Both directions, because BeePublisherPool refuses both and finding out from a
# service that will not start is a worse way to learn it.
LADDER_RUNGS="$(printf '%s\n' "$LADDER_SPEC" | tr ' ' '\n' | sed 's/:.*//' | grep -v '^$' | sort)"
SCRIPT_RUNGS="$(printf '%s\n' "${RUNG_PORT_VARS[@]}" | sed 's/:.*//' | sort)"
if [ "$LADDER_RUNGS" != "$SCRIPT_RUNGS" ]; then
  echo "bee-publishers: REFUSING, the ladder and this script's node map do not agree."
  echo "  ABR_LADDER rungs: $(printf '%s' "$LADDER_RUNGS" | tr '\n' ' ')"
  echo "  nodes known here: $(printf '%s' "$SCRIPT_RUNGS" | tr '\n' ' ')"
  echo "  A line covering some of the ladder is refused by the uploader anyway, and writing one would"
  echo "  read as a typo rather than as a missing bee node. See RUNG_PORT_VARS in this script."
  exit 1
fi

TARGET="$(get_target "$SVC_UPLOADER")"
if ! is_enabled "$TARGET"; then
  echo "bee-publishers: REFUSING, ${SVC_UPLOADER} is disabled in $CONFIG_FILE." >&2
  exit 1
fi

# Read one node's /stamps. Either from the host it runs on, or from a captured file when rehearsing.
read_stamps() {
  local port="$1"
  if [ -n "$STAMPS_FROM" ]; then
    cat "$STAMPS_FROM/${port}.json" 2>/dev/null
    return 0
  fi
  if [ "$TARGET" = "localhost" ]; then
    curl -s --max-time 10 "http://127.0.0.1:${port}/stamps" 2>/dev/null
    return 0
  fi
  ssh "$TARGET" "curl -s --max-time 10 'http://127.0.0.1:${port}/stamps'" 2>/dev/null
}

# The uploader is network_mode: host on every deployment that splits its bees this way (see
# deploy/docker-compose.host.yml), so 127.0.0.1 from inside the container is the host's loopback and
# reaches each node directly. It is also what makes the e2e preflight able to resolve a port off the
# routing the uploader reports.
NODE_URL_PREFIX="http://127.0.0.1:"

ENTRIES=""
FAILED=0
for pair in "${RUNG_PORT_VARS[@]}"; do
  rung="${pair%%:*}"
  port_var="${pair##*:}"
  port="${!port_var:-}"

  if [ -z "$port" ]; then
    echo "bee-publishers: REFUSING, ${port_var} is unset, so rung ${rung} has no node to dial."
    echo "  Pass --portSlot, or set ${port_var} in .env.${PROFILE}."
    exit 1
  fi

  stamps="$(read_stamps "$port")"
  if [ -z "$stamps" ]; then
    echo "bee-publishers: REFUSING, the ${rung} node on :${port} did not answer /stamps."
    echo "  A node that cannot say what it holds is not a node with a usable batch."
    if [ -z "$STAMPS_FROM" ]; then
      echo "  Check it is up: ssh ${TARGET} 'docker ps --filter name=bee-uploader'"
    fi
    exit 1
  fi

  # Parsed here rather than in the loop's shell, so every node is read the same way and a batch that
  # is merely present is not mistaken for one that can carry a broadcast.
  selection="$(printf '%s' "$stamps" | RUNG="$rung" PORT="$port" MIN_TTL_HOURS="$MIN_TTL_HOURS" \
    MAX_UTILIZATION="$MAX_UTILIZATION" python3 -c '
import json, os, sys

rung = os.environ["RUNG"]
port = os.environ["PORT"]
min_ttl_s = float(os.environ["MIN_TTL_HOURS"]) * 3600.0
max_util = float(os.environ["MAX_UTILIZATION"])

try:
    stamps = json.load(sys.stdin).get("stamps") or []
except (ValueError, AttributeError) as error:
    print(f"REFUSE\tthe {rung} node on :{port} answered /stamps with something unreadable ({error})")
    sys.exit(0)

def why_not(batch):
    """Every reason a batch cannot carry a broadcast, so a refusal lists them all at once."""
    reasons = []
    if not batch.get("exists", False):
        reasons.append("exists=false")
    if not batch.get("usable", False):
        reasons.append("usable=false")
    ttl = batch.get("batchTTL")
    ratio = batch.get("utilizationRatio")
    # ⛔ Absence is a refusal, never a default. A batch with no readable TTL is not a batch with
    # plenty of time, and reading it as one would put an unusable batch in the config.
    if not isinstance(ttl, (int, float)):
        reasons.append("no readable batchTTL")
    elif ttl < min_ttl_s:
        reasons.append(f"{ttl / 3600.0:.1f}h left, floor is {min_ttl_s / 3600.0:.1f}h")
    if not isinstance(ratio, (int, float)):
        reasons.append("no readable utilizationRatio")
    elif ratio > max_util:
        reasons.append(f"{ratio * 100.0:.1f}% used, ceiling is {max_util * 100.0:.1f}%")
    return reasons

usable = []
rejected = []
for batch in stamps:
    reasons = why_not(batch)
    short = str(batch.get("batchID", ""))[:8] or "????????"
    if reasons:
        # Joined before the f-string, not inside it: nesting the same quote character in an f-string
        # is a syntax error before Python 3.12, and a single quote anywhere in here would close the
        # shell string this whole program is passed as.
        joined = ", ".join(reasons)
        rejected.append(f"{short} ({joined})")
    else:
        usable.append(batch)

if not usable:
    listed = "; ".join(rejected) if rejected else "no batches at all"
    print(f"REFUSE\tthe {rung} node on :{port} holds no batch that can carry a broadcast: {listed}")
    sys.exit(0)

# Most TTL headroom, which is the same tie-break discoverStamp in the e2e harness uses. Said out
# loud below when there was a choice, because which batch a rung spends is an operator decision and
# this only makes it when there is exactly one answer.
usable.sort(key=lambda b: b["batchTTL"], reverse=True)
chosen = usable[0]
batch_id = str(chosen.get("batchID", ""))
if len(batch_id) != 64 or any(c not in "0123456789abcdefABCDEF" for c in batch_id):
    print(f"REFUSE\tthe {rung} node on :{port} reported a batch id that is not 64 hex characters "
          f"({len(batch_id)} chars). The uploader refuses one of those at startup, so it is refused here.")
    sys.exit(0)

among = f" (chose the longest-lived of {len(usable)})" if len(usable) > 1 else ""
print("OK\t{id}\t{short} {pct:.1f}% used, {ttl:.1f}h left, depth {depth}{among}".format(
    id=batch_id,
    short=batch_id[:8],
    pct=chosen["utilizationRatio"] * 100.0,
    ttl=chosen["batchTTL"] / 3600.0,
    depth=chosen.get("depth", "?"),
    among=among,
))
')"

  verdict="${selection%%$'\t'*}"
  if [ "$verdict" != "OK" ]; then
    echo "bee-publishers: ${selection#*$'\t'}"
    FAILED=1
    continue
  fi

  rest="${selection#*$'\t'}"
  batch_id="${rest%%$'\t'*}"
  human="${rest#*$'\t'}"
  echo "  ${rung} :${port} — ${human}"
  ENTRIES="${ENTRIES}${ENTRIES:+ }${rung}@${NODE_URL_PREFIX}${port}<${batch_id}>"
done

if [ "$FAILED" = "1" ]; then
  echo ""
  echo "bee-publishers: REFUSING TO WRITE. At least one rung has no batch that can carry a broadcast."
  echo "  Buy one on that node, from its own wallet, at the depth the others use:"
  echo "    ssh ${TARGET} \"curl -s -XPOST 'http://127.0.0.1:<port>/stamps/<amount>/<depth>'\""
  echo "  A batch that is merely full can be diluted instead, which buys depth by halving TTL:"
  echo "    ssh ${TARGET} \"curl -s -XPATCH 'http://127.0.0.1:<port>/stamps/dilute/<batch>/<depth+1>'\""
  exit 1
fi

if [ "$WRITE" != "1" ]; then
  echo ""
  echo "bee-publishers: the line for .env.${PROFILE}, not written (pass --write):"
  echo ""
  # Printed with the ids truncated. --write is the only way the real line leaves this script, so a
  # terminal, a scrollback and a transcript never hold four whole batch ids.
  printf '  BEE_PUBLISHERS=%s\n' "$(printf '%s' "$ENTRIES" | sed -E 's/<([0-9a-fA-F]{8})[0-9a-fA-F]{56}>/<\1…>/g')"
  echo ""
  echo "  (batch ids truncated for display, --write puts the real ones in the file)"
  exit 0
fi

BACKUP="${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$BACKUP"
# Rewritten rather than appended, because two BEE_PUBLISHERS lines in one env file is a value chosen
# by whichever dotenv happens to win and not by the operator.
python3 - "$ENV_FILE" "$ENTRIES" <<'PY'
import sys

path, entries = sys.argv[1], sys.argv[2]
with open(path) as handle:
    lines = handle.read().splitlines()

value = f"BEE_PUBLISHERS={entries}"

# Replaced where it already sits rather than moved to the end, so a regenerated line stays under the
# comment that explains it. Any second copy is dropped: two BEE_PUBLISHERS lines in one env file is a
# value chosen by whichever dotenv happens to win instead of by the operator.
kept, replaced = [], False
for line in lines:
    if not line.startswith("BEE_PUBLISHERS="):
        kept.append(line)
    elif not replaced:
        kept.append(value)
        replaced = True

if not replaced:
    kept.append("")
    kept.append("# One Bee node per rung. Written by deploy/scripts/bee-publishers.sh, which reads each")
    kept.append("# node's own /stamps. Regenerate it rather than editing it: a batch id is live state.")
    kept.append(value)

with open(path, "w") as handle:
    handle.write("\n".join(kept) + "\n")
PY

echo ""
echo "bee-publishers: wrote BEE_PUBLISHERS to ${ENV_FILE} (previous file at ${BACKUP##*/})."
echo "  It reaches the container on the next deploy of the uploader, which is what adopts it:"
echo "    deploy/scripts/deploy.sh --profile=${PROFILE} --portSlot=${PORT_SLOT} stream-uploader"
echo "  Then confirm the uploader is running it, rather than assuming:"
echo "    ssh ${TARGET} \"curl -s http://127.0.0.1:\${API_PORT:-3000}/health\" | python3 -m json.tool | grep -A 20 publishers"
