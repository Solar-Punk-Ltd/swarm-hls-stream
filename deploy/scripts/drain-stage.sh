#!/usr/bin/env bash
#
# Point one ABR rung at a deliberately tiny postage batch so the batch runs dry mid-broadcast, and
# put the original back afterwards.
#
# A postage batch is a prepaid allowance for storing chunks. Each of the four rungs publishes through
# its own Bee node with its own batch, so that one batch running out costs one quality and not the
# broadcast. Nothing has ever tested that, because a batch cannot be made to expire inside a test:
# Bee refuses to create one that would live under 24 hours. Filling one is the lever that works, and
# the smallest batch Bee allows fills in about twenty seconds of 1080p. The sitting this arms, and
# everything it asserts, is `docs/e2e-batch-drain-plan.md`.
#
# ## Two owners, one step each
#
# **The owner buys the batch. This script wires it in.** `print-buy` prints the exact command and the
# price, and never runs it, because the agent moves no money, ever. `arm` takes the id the purchase
# returns, checks the batch really is one that will run dry, rewrites that one rung's entry in
# `BEE_PUBLISHERS`, and redeploys the uploader, which is what adopts the line. `restore` puts the
# original back the same way.
#
# ⛔ Rewriting the env file is the only way in. The uploader reads `BEE_PUBLISHERS` once at process
# start, the value reaches the container only from `.env.<profile>`, and `deploy.sh` does not inject
# it. So there is no way to change one rung's batch without editing that file and restarting the
# container, and this script is that edit rather than a hand edit of a line carrying four
# 64-character batch ids.
#
# ⛔ `bee-publishers.sh` cannot do this. It asks each node for its HEALTHIEST batch by design, which
# is the exact opposite of a batch meant to run out.
#
# ## Why there is no spend-ledger gate here
#
# `bench-on-host.sh` refuses to launch from a checkout without `.spend-ledger.env`, the owner's
# written authorisation, because everything it starts publishes and every published segment is paid
# for out of a chequebook. Nothing in this script spends from a chequebook. `print-buy` prints,
# `status` reads, and `arm` and `restore` rewrite one line of an env file and restart a container.
# The one purchase in the whole sitting is the owner running the printed command from their own
# shell, and the broadcast that follows is launched through `bench-on-host.sh`, behind that gate.
#
# Usage:
#   deploy/scripts/drain-stage.sh --profile=latbench --portSlot=7 --rung=1080p print-buy [--days=2]
#   deploy/scripts/drain-stage.sh --profile=latbench --portSlot=7 --rung=1080p arm --batch=<64 hex>
#   deploy/scripts/drain-stage.sh --profile=latbench --portSlot=7 --rung=1080p restore
#   deploy/scripts/drain-stage.sh --profile=latbench --portSlot=7 --rung=1080p status
#
# `print-buy` reads the chain price off the rung's node and prints one purchase command, the cost in
# BZZ, and how much the batch holds before it starts refusing uploads.
#
# `arm` refuses any batch that would not run dry when the sitting expects it to: one the node does not
# hold, one it will not spend, one deeper than 17, one expiring inside the uploader's own startup
# floor, and one that already holds chunks. It keeps a copy of the env file at `.bak-<timestamp>` and
# records the rung's original batch id and the one it armed in `.drain-stage.<profile>.env` beside it.
#
# `restore` reads that record, writes the original batch back, and removes the record. It refuses when
# there is nothing recorded rather than guessing which batch the rung used to publish through. The
# armed id is recorded because the first restore leaves the entry naming the original, so a restore
# run again after a failed redeploy has nowhere else to read the drained batch from.
#
# ⛔⛔ `arm` and `restore` both keep the uploader's container log before they redeploy, at
# `~/drain-<profile>-<rung>-<utc>.uploader.log` on the deployment host, beside the bench checkout, and
# with `-before-arm` on the arm so both process lives are kept. A redeploy replaces the container and
# `docker logs` goes with it. The first drain sitting, 2026-09-04, lost the whole log of the rung it
# had just refused four times, and with it bee's own answers, which was the one thing the sitting was
# for. A dump that fails is reported plainly and the redeploy carries on regardless, because a stage
# left armed is worse than a lost log.
#
# ⛔ No batch id is ever printed whole, only its first eight characters, the rule
# `bee-publishers.sh` sets: a scrollback outlives the command and a full id is indistinguishable
# from a wallet private key to anything reading either.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$SCRIPT_DIR/_lib.sh"

# The smallest depth Bee accepts, and the only one this script arms. A batch has 2^16 buckets and
# needs at least two chunks in each, which is where both numbers come from.
readonly ARM_DEPTH=17
readonly BUCKET_DEPTH=16
readonly CHUNK_BYTES=4096
readonly PLUR_PER_BZZ=10000000000000000

# The floor the uploader's own PostageGate applies at startup (STAMP_MIN_TTL_HOURS), plus an hour,
# because the arm and the sitting are not the same minute. A batch under the floor arms cleanly and
# then stops the container from starting at all.
#
# ⛔⛔⛔ READ FROM THE ENV FILE, never from this shell. The uploader takes its environment from
# `.env.<profile>` and never from the terminal this runs in, so an export here moved the floor in this
# script and nowhere else, and the check stopped being a check of what the container will do. That is
# the same shape as the fragment length that dated the stage wrong on 2026-09-04, when every reading
# of the ladder was taken against a value nothing had deployed.
#
# The shell value is captured here rather than read later, because `load_env` copies the file's value
# into this shell as a default and the two are indistinguishable once it has run. It is unset for the
# same reason: the file has to win, and `load_env_file` skips a key this shell already declares.
readonly DEFAULT_MIN_TTL_HOURS=24
MIN_TTL_HOURS="$DEFAULT_MIN_TTL_HOURS"
MIN_TTL_HOURS_IN_SHELL="${STAMP_MIN_TTL_HOURS:-}"
unset STAMP_MIN_TTL_HOURS
readonly ARM_TTL_MARGIN_HOURS=1

readonly SUBCOMMANDS="print-buy, arm, restore and status"
readonly SSH_TRANSPORT_FAILED=255

SUBCOMMAND=""
RUNG=""
BATCH=""
DAYS="2"
DAYS_GIVEN=0

# Every refusal is one plain sentence on stderr and a non-zero exit. `refuse` is a precondition this
# script will not act against, `fail` is something that went wrong once it had started acting, and
# `usage_error` is a command line it cannot read.
refuse() {
  echo "drain-stage: REFUSING, $1" >&2
  exit 1
}

fail() {
  echo "drain-stage: $1" >&2
  exit 1
}

usage_error() {
  echo "drain-stage: $1" >&2
  exit 2
}

value_of() {
  if [ "$2" -lt 2 ]; then
    usage_error "$1 requires a value."
  fi
}

# ⛔ `_lib.sh` requires jq and this script requires python3, which nothing checked. Every reading it
# takes is parsed by an inline python program, so on a host without a working one each reading came
# back empty and every subcommand refused with a lone full stop and no reason at all. Run rather than
# looked up, because a python3 that is present and cannot start is exactly as fatal as a missing one.
require_python3() {
  if ! python3 -c "" > /dev/null 2>&1; then
    refuse "python3 is not on the PATH or cannot run, and every reading this script takes is parsed by an inline python program, so no subcommand of it works without one."
  fi
}

parse_profile_args "$@"
# ⛔ `${arr[@]+"${arr[@]}"}` rather than `"${REST_ARGS[@]}"`, because macOS ships bash 3.2 and there an
# EMPTY array expanded under `set -u` is an unbound variable, not an empty list. That regression made
# `bee-publishers.sh`'s ordinary invocation the only broken one, since every path exercised while
# writing it happened to pass a third flag.
# shellcheck disable=SC2086 # the entries carry no whitespace, and quoting them here breaks bash 3.2
set -- ${REST_ARGS[@]+"${REST_ARGS[@]}"}
while [ $# -gt 0 ]; do
  case "$1" in
    --rung=*) RUNG="${1#*=}"; shift ;;
    --rung) value_of --rung $#; RUNG="$2"; shift 2 ;;
    --batch=*) BATCH="${1#*=}"; shift ;;
    --batch) value_of --batch $#; BATCH="$2"; shift 2 ;;
    --days=*) DAYS="${1#*=}"; DAYS_GIVEN=1; shift ;;
    --days) value_of --days $#; DAYS="$2"; DAYS_GIVEN=1; shift 2 ;;
    -h|--help) sed -n '2,68p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) usage_error "$1 is not a flag this script has, and its subcommands are ${SUBCOMMANDS}." ;;
    *)
      if [ -n "$SUBCOMMAND" ]; then
        usage_error "one subcommand at a time, and this run named both ${SUBCOMMAND} and $1."
      fi
      SUBCOMMAND="$1"
      shift
      ;;
  esac
done

case "$SUBCOMMAND" in
  print-buy | arm | restore | status) ;;
  "") usage_error "name a subcommand, one of ${SUBCOMMANDS}." ;;
  *) usage_error "${SUBCOMMAND} is not a subcommand, and the four are ${SUBCOMMANDS}." ;;
esac

if [ "$SUBCOMMAND" != "arm" ] && [ -n "$BATCH" ]; then
  usage_error "--batch belongs to arm alone, and this run passed it to ${SUBCOMMAND}."
fi
if [ "$SUBCOMMAND" != "print-buy" ] && [ "$DAYS_GIVEN" = "1" ]; then
  usage_error "--days belongs to print-buy alone, and this run passed it to ${SUBCOMMAND}."
fi

require_jq
require_python3
require_config
require_env
load_env
apply_port_slot

# Now that the env file has been read, the floor is whatever the container will see. A value left in
# this shell as well is refused rather than quietly ignored, because an operator who exported it did
# it to change something and has to be told it changes nothing.
MIN_TTL_HOURS="${STAMP_MIN_TTL_HOURS:-$DEFAULT_MIN_TTL_HOURS}"
if [ -n "$MIN_TTL_HOURS_IN_SHELL" ] && [ "$MIN_TTL_HOURS_IN_SHELL" != "$MIN_TTL_HOURS" ]; then
  refuse "STAMP_MIN_TTL_HOURS is ${MIN_TTL_HOURS_IN_SHELL} in this shell and ${MIN_TTL_HOURS} for the uploader, which reads ${ENV_FILE##*/} and never this shell, so the floor this run would apply is not the floor the container will apply. Set it in ${ENV_FILE##*/} and redeploy, or unset it here."
fi

# ⛔ The same hardcoded map `bee-publishers.sh` carries, and for the same reason: the deploy has
# exactly these services, so a rung not named here has no node to publish through. Same order,
# ascending by height, which is the order the pool is handed the ladder. Adding a rung means adding a
# `bee-uploader-<rung>` service in docker-compose.yml, its ports in _lib.sh, and a line in both
# scripts.
RUNG_PORT_VARS=(
  "360p:BEE_UPLOADER_API_PORT"
  "480p:BEE_RUNG_480P_API_PORT"
  "720p:BEE_RUNG_720P_API_PORT"
  "1080p:BEE_RUNG_1080P_API_PORT"
)

known_rungs() {
  printf '%s\n' "${RUNG_PORT_VARS[@]}" | sed 's/:.*//' | tr '\n' ' ' | sed 's/ $//'
}

if [ -z "$RUNG" ]; then
  usage_error "--rung is required, and the rungs this deployment has nodes for are $(known_rungs)."
fi

PORT=""
PORT_VAR=""
for pair in "${RUNG_PORT_VARS[@]}"; do
  if [ "${pair%%:*}" = "$RUNG" ]; then
    PORT_VAR="${pair##*:}"
    PORT="${!PORT_VAR:-}"
  fi
done

if [ -z "$PORT_VAR" ]; then
  refuse "rung ${RUNG} has no bee node in this deployment, and the rungs that do are $(known_rungs)."
fi
if [ -z "$PORT" ]; then
  refuse "${PORT_VAR} is unset, so rung ${RUNG} has no node to dial, and the fix is --portSlot or a value in ${ENV_FILE}."
fi

TARGET="$(get_target "$SVC_UPLOADER")"
if ! is_enabled "$TARGET"; then
  refuse "${SVC_UPLOADER} is disabled in ${CONFIG_FILE}, so no rung of this deployment publishes anything."
fi
# A natively-run uploader takes its environment from the shell that started it and `deploy.sh` skips
# it, so the rewrite below would land in a file nothing reads and the redeploy would be a no-op.
if is_native "$TARGET"; then
  refuse "${SVC_UPLOADER} runs natively on this deployment, so it reads its environment from the shell that started it rather than from ${ENV_FILE}, and restarting that process by hand is the only way to change one rung's batch."
fi

RECORD_FILE="$ROOT_DIR/.drain-stage.$PROFILE.env"

# ⛔⛔⛔ A FAILED TRANSPORT AND AN UNANSWERED SERVICE ARE NOT THE SAME REFUSAL, and they arrive as the
# same empty string. On 2026-08-31 a wedged 1Password SSH agent made `bee-publishers.sh` report that
# the uploader was not deployed, which was false, and a whole measurement arm was lost to that
# confusion. ssh exits 255 for connection and authentication failures and passes the remote command's
# status through otherwise, so the two are separable and are separated here.
#
# ⛔⛔⛔ AND A NODE THAT ANSWERS AN ERROR IS NEITHER OF THOSE. Bee reports a failure as an ordinary
# JSON body carrying `code` and `message` and no list at all, over an HTTP status nothing here used
# to ask for. So a 503 from a bee whose batch store was not ready parsed cleanly, the missing list
# read as an empty one, and `status` printed that the batch "is not on the node, which lists nothing
# at all" and exited zero. `--write-out` puts the status on its own last line after the body, which
# is the only way one request answers both questions, and `health.sh` reads it the same way.
#
# The answer lands in globals rather than on stdout, because a command substitution takes the
# substitution's own status and would hide the one this has to read.
readonly HTTP_CODE_SUFFIX='\n%{http_code}'
NODE_BODY=""
NODE_STATUS=0
NODE_HTTP_CODE=""
read_node() {
  local path="$1" answer
  if [ "$TARGET" = "$TARGET_LOCAL" ]; then
    answer="$(curl -s -w "$HTTP_CODE_SUFFIX" --max-time 10 "http://127.0.0.1:${PORT}${path}" 2>/dev/null)"
    NODE_STATUS=$?
  else
    answer="$(ssh -o ConnectTimeout=10 "$TARGET" "curl -s -w '${HTTP_CODE_SUFFIX}' --max-time 10 'http://127.0.0.1:${PORT}${path}'" 2>/dev/null)"
    NODE_STATUS=$?
  fi
  split_node_answer "$answer"
}

# The status curl appended, and the body without it. A read curl cut short carries no such line, and
# neither does a body that arrived before curl gave up, so anything whose last line is not three
# digits is taken as all body and no status, which the guards below then read as unknown.
split_node_answer() {
  local raw="$1" last="${1##*$'\n'}"
  if [ "$raw" != "$last" ] && [[ "$last" =~ ^[0-9]{3}$ ]]; then
    NODE_HTTP_CODE="$last"
    NODE_BODY="${raw%$'\n'*}"
    return 0
  fi
  NODE_HTTP_CODE=""
  NODE_BODY="$raw"
}

# What the node called the failure, for a refusal that carries its words rather than only its number.
node_error_words() {
  printf '%s' "$NODE_BODY" | python3 -c '
import json, sys

try:
    body = json.load(sys.stdin)
except ValueError:
    body = None
if isinstance(body, dict):
    said = [str(body[key]) for key in ("code", "message") if key in body]
    if said:
        print(" and said " + ": ".join(said), end="")
'
}

require_node_answer() {
  local path="$1"
  if [ "$NODE_STATUS" = "$SSH_TRANSPORT_FAILED" ] && [ "$TARGET" != "$TARGET_LOCAL" ]; then
    refuse "could not reach ${TARGET} over ssh, which is the transport and not the node, so this says nothing about what ${RUNG} holds, and on this machine it is usually the 1Password SSH agent listing keys and refusing to sign (check with: ssh-add -l && ssh ${TARGET} true)."
  fi
  # Before the empty-body guard, because a node that answers an error with no body at all is still a
  # node that answered. 000 is what curl reports when there was no HTTP response to read a status
  # from, which is the silent node the next guard names.
  case "$NODE_HTTP_CODE" in
    '' | 000 | 2??) ;;
    *)
      refuse "the ${RUNG} node on :${PORT} answered ${NODE_HTTP_CODE} to ${path}$(node_error_words), so this says nothing about what ${RUNG} holds and a node answering an error is not a node holding nothing."
      ;;
  esac
  if [ -z "$NODE_BODY" ]; then
    refuse "the ${RUNG} node on :${PORT} did not answer ${path}, and a node that cannot answer is not a node anything can be armed on."
  fi
  # ⛔⛔ A BODY THAT ARRIVED WITH A NON-ZERO STATUS IS A READ THIS SCRIPT CUT SHORT, not an answer. The
  # block above separates a failed transport from a silent node and this one separates a failed read
  # from a node answering badly, which is the same distinction one hop further in. A truncated body is
  # not empty, so the guard above passes it to a parser that then reports unreadable JSON as something
  # the node said. On a local target this status was captured and never read at all.
  if [ "$NODE_STATUS" != "0" ]; then
    refuse "the read of ${path} from the ${RUNG} node on :${PORT} exited ${NODE_STATUS} with part of an answer, so the read failed rather than the node answering badly, and curl exits 28 at its own --max-time and 18 on a transfer that stopped early."
  fi
}

# The uploader is network_mode: host on every deployment that splits its bees per rung, so 127.0.0.1
# from inside the container is the host loopback and reaches each node directly.
readonly NODE_URL_PREFIX="http://127.0.0.1:"

# `<verdict>\t<text>`, the answer shape every reader below uses: OK carries a reading, REFUSE carries
# a whole refusal sentence, ABSENT carries one that is a refusal for `arm` and a reading for `status`.
verdict_of() {
  printf '%s' "${1%%$'\t'*}"
}

text_of() {
  printf '%s' "${1#*$'\t'}"
}

# The whole sentence to hand a refusal, for an answer that is not OK.
#
# ⛔ An EMPTY answer has no verdict and no text, so `text_of` on it is empty too and the refusal came
# out as a lone full stop. That is the case where the reason matters most: the answer is empty because
# the program that produces it died, which is this script and never the node.
reason_of() {
  if [ -z "$1" ]; then
    printf '%s' "no answer came back at all, which is this script rather than the node or the env file, because the program that reads them died before it printed a verdict, and its own error is on stderr above"
    return 0
  fi
  text_of "$1"
}

short_id() {
  printf '%s…' "${1:0:8}"
}

# One reading of a batch out of the rung's /stamps.
#
# `check` applies every condition an armed batch has to meet and answers with the reason it does not.
# `read` applies none and answers with the reading, which is what `status` wants. Both share one
# parser, so a reading and a refusal can never disagree about what the node said.
#
# ⛔ No apostrophe and no backtick below. The program is passed as a single-quoted shell string, so
# either one closes it and the whole file stops parsing.
read_batch() {
  local mode="$1" batch_id="$2"
  printf '%s' "$NODE_BODY" | MODE="$mode" BATCH="$batch_id" RUNG="$RUNG" PORT="$PORT" \
    WANT_DEPTH="$ARM_DEPTH" FLOOR_HOURS="$MIN_TTL_HOURS" MARGIN_HOURS="$ARM_TTL_MARGIN_HOURS" python3 -c '
import json, os, sys

mode = os.environ["MODE"]
batch_id = os.environ["BATCH"]
rung = os.environ["RUNG"]
port = os.environ["PORT"]
want_depth = int(os.environ["WANT_DEPTH"])
floor_hours = float(os.environ["FLOOR_HOURS"]) + float(os.environ["MARGIN_HOURS"])
# Eight characters and an ellipsis, the same truncation the uploader logs and for the same reason: a
# scrollback outlives the command and a whole batch id reads like a wallet key.
short = batch_id[:8] + chr(8230)


def answer(verdict, text):
    print(verdict + "\t" + text)
    sys.exit(0)


def refuse(text):
    answer("REFUSE" if mode == "check" else "ABSENT", text)


# ⛔⛔⛔ REFUSE IN BOTH MODES, never ABSENT. An unreadable body is not a reading, and status treats
# ABSENT as one and exits zero on it. A bee error envelope is valid JSON with a code and a message
# and no list at all, so reading a missing list as an empty one turned a node that could not answer
# into a node that answered "no batches".
try:
    body = json.load(sys.stdin)
except ValueError as error:
    answer("REFUSE", f"the {rung} node on :{port} answered /stamps with something unreadable ({error})")

if not isinstance(body, dict) or not isinstance(body.get("stamps"), list):
    answer(
        "REFUSE",
        f"the {rung} node on :{port} answered /stamps with no list of stamps in it, which is the shape "
        f"of a bee error envelope, so what that node holds is unknown rather than nothing",
    )

stamps = body["stamps"]
batch = next((b for b in stamps if str(b.get("batchID", "")) == batch_id), None)
if batch is None:
    listed = ", ".join(str(b.get("batchID", ""))[:8] + chr(8230) for b in stamps) or "nothing at all"
    answer("ABSENT", f"batch {short} is not on the {rung} node on :{port}, which lists {listed}")

depth = batch.get("depth")
bucket_depth = batch.get("bucketDepth")
ttl = batch.get("batchTTL")
used = batch.get("utilization")
exists = bool(batch.get("exists", False))
usable = bool(batch.get("usable", False))
immutable = bool(batch.get("immutableFlag", False))

# Absence is a refusal, never a default. A batch with no readable TTL is not a batch with plenty of
# time, and reading it as one would arm a batch that drains at a moment nobody chose.
fields = (("depth", depth), ("bucketDepth", bucket_depth), ("batchTTL", ttl), ("utilization", used))
for name, value in fields:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        refuse(f"batch {short} on the {rung} node reports no readable {name}, and absence is not permission to arm it")

per_bucket = 2 ** (int(depth) - int(bucket_depth))
reading = (
    f"{short} depth {depth}, {used}/{per_bucket} chunks in the fullest bucket, "
    f"{ttl / 3600.0:.1f}h left, usable {str(usable).lower()}, immutable {str(immutable).lower()}"
)

if mode != "check":
    answer("OK", reading)

if not exists or not usable:
    refuse(
        f"batch {short} on the {rung} node reports exists={str(exists).lower()} and "
        f"usable={str(usable).lower()}, and only a batch the node will spend can be made to run dry"
    )
if int(depth) != want_depth:
    refuse(
        f"batch {short} is depth {depth} and this script arms depth {want_depth} alone, the smallest "
        f"bee allows, because a deeper batch holds more chunks than a test broadcast can fill and the "
        f"sitting would report a rung that never drained"
    )
if ttl < floor_hours * 3600.0:
    refuse(
        f"batch {short} has {ttl / 3600.0:.1f}h left and the floor is {floor_hours:.1f}h, so the "
        f"uploader would refuse it at startup and the redeploy would not bring the container up"
    )
if used != 0:
    refuse(
        f"batch {short} already holds {used} chunks in its fullest bucket and an armed batch has to "
        f"start empty, or the drain lands at a moment nobody chose and the sitting is unrepeatable"
    )

answer("OK", reading)
'
}

# Read or rewrite one rung's entry of the BEE_PUBLISHERS line in the profile env file. Either way the
# OK text is the batch the entry named BEFORE the call, which is what `arm` records and what `restore`
# reports as spent.
#
# ⛔ Read from the FILE and never from the environment. `load_env` treats an env file value as a
# default, so a `BEE_PUBLISHERS` already exported in the operator's shell would win over the file, and
# this repo has already lost a stage to a setting that came from a shell export rather than from the
# file it was read out of. The file is also what is being rewritten, so it is the only honest source.
publisher_entry() {
  local mode="$1" new_batch="${2:-}"
  python3 - "$ENV_FILE" "$RUNG" "$mode" "$new_batch" <<'PY'
import os, sys

path, rung, mode, new_batch = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
KEY = "BEE_PUBLISHERS="


def answer(verdict, text=""):
    print(verdict + "\t" + text)
    sys.exit(0)


with open(path) as handle:
    lines = handle.read().splitlines()

at = [index for index, line in enumerate(lines) if line.startswith(KEY)]
if not at:
    answer("REFUSE", f"{path} has no BEE_PUBLISHERS line, so rung {rung} publishes through nothing this script can swap")
if len(at) > 1:
    answer(
        "REFUSE",
        f"{path} carries {len(at)} BEE_PUBLISHERS lines, and which one the uploader reads is decided "
        "by dotenv rather than by the operator, so the unwanted ones have to go first",
    )

index = at[0]
entries = lines[index][len(KEY) :].strip().split()


def split(entry):
    """`rung@url<batch>` as `parsePublisherSpecs` in the uploader splits it, or None.

    The first `@` and the last bracket, so a url carrying userinfo or a path survives. The older `#`
    separator is still accepted there, so it is accepted and preserved here.
    """
    at_sign = entry.find("@")
    if at_sign <= 0:
        return None
    separator = "<>" if entry.endswith(">") else "#"
    open_at = entry.rfind("<") if separator == "<>" else entry.rfind("#")
    if open_at <= at_sign:
        return None
    close_at = len(entry) - 1 if separator == "<>" else len(entry)
    return entry[:at_sign], entry[at_sign + 1 : open_at], entry[open_at + 1 : close_at], separator


parsed = [(entry, split(entry)) for entry in entries]
hit = next((fields for _, fields in parsed if fields and fields[0] == rung), None)
if hit is None:
    named = ", ".join(fields[0] for _, fields in parsed if fields) or "no rung at all"
    answer("REFUSE", f"BEE_PUBLISHERS in {path} has no entry for rung {rung}, and it names {named}")

if mode == "read":
    answer("OK", hit[2])

# Rebuilt entry by entry, so the other three rungs come out of this byte for byte as they went in.
rebuilt = []
for entry, fields in parsed:
    if not fields or fields[0] != rung:
        rebuilt.append(entry)
        continue
    url, separator = fields[1], fields[3]
    rebuilt.append(f"{rung}@{url}<{new_batch}>" if separator == "<>" else f"{rung}@{url}#{new_batch}")

lines[index] = KEY + " ".join(rebuilt)

# ⛔ Written beside the env file and renamed over it, never into it. Opening the env file itself for
# writing truncates it before a byte of the new content is written, so a write that died part way
# through left the whole profile env empty or half written while the caller reported that the entry
# could not be rewritten, which reads as the file being as it was. os.replace is atomic inside one
# directory, so the file an operator reads is either the old one or the new one.
temporary = path + ".drain-stage-" + str(os.getpid()) + ".new"

# The mode is put on the copy before a byte of content goes into it, and not after. A rename replaces
# the file permissions along with the contents, so the copy has to carry the env file mode, and this
# file holds a stamp and a stream key. Created under the umask and chmod-ed once the write had
# finished, both of those were readable by anyone on the host for the length of that write.
mode = os.stat(path).st_mode & 0o7777
try:
    with open(temporary, "w") as handle:
        os.chmod(temporary, mode)
        handle.write("\n".join(lines) + "\n")
    os.replace(temporary, path)
except BaseException:
    if os.path.exists(temporary):
        os.unlink(temporary)
    raise

answer("OK", hit[2])
PY
}

# The rung's line of the record, as `<original> <armed>`, or nothing when the rung is not in it.
recorded_line() {
  [ -f "$RECORD_FILE" ] || return 1
  local line
  line="$(grep "^${RUNG}=" "$RECORD_FILE" 2> /dev/null | head -1)"
  [ -n "$line" ] || return 1
  printf '%s' "${line#*=}"
}

recorded_original() {
  local fields
  fields="$(recorded_line)" || return 1
  printf '%s' "${fields%% *}"
}

# The batch the arm wrote into the entry, which is the only thing that still says which batch drained
# once the entry has been put back. A record written before this field existed, or written by hand,
# carries the original alone and answers non-zero here, and the caller falls back to the entry.
recorded_armed() {
  local fields
  fields="$(recorded_line)" || return 1
  case "$fields" in
    *' '*) printf '%s' "${fields#* }" ;;
    *) return 1 ;;
  esac
}

# Both batches on one line, `<rung>=<original> <armed>`. The original is what `restore` puts back and
# the armed one is what it reports as spent, and the second is needed because the first restore leaves
# the entry naming the original, so a restore run again has nowhere else to read it from.
#
# Non-zero when either write failed, which the caller turns into a refusal.
#
# ⛔⛔ This script runs `set -u` and not `set -e`, so an unchecked redirection here carried on to the
# `✓ recorded the original` line and to the env rewrite. That arms a rung with nothing saying which
# batch it used to publish through, and `restore` then refuses with "nothing is armed" on a stage
# that is armed, which is the state this file's own header calls worse than a lost log.
record_original() {
  local original="$1" armed="$2"
  if [ ! -f "$RECORD_FILE" ]; then
    if ! {
      echo "# What each rung was publishing through before deploy/scripts/drain-stage.sh armed it, and"
      echo "# what it was armed with, as <rung>=<original> <armed>."
      echo "# Read by its restore, and deleted once the last armed rung has been restored."
    } > "$RECORD_FILE"; then
      return 1
    fi
  fi
  printf '%s=%s %s\n' "$RUNG" "$original" "$armed" >> "$RECORD_FILE"
}

# Non-zero when the record still names the rung, which the caller turns into a refusal.
#
# ⛔ Checked like the two writes of an arm, though this one fails in the safe direction: the record
# survives, the stage is genuinely restored, and the only cost is that a later arm refuses with
# "already armed" until the file is cleared. Said out loud rather than left silent, because an
# operator who reads "removed the record" and then cannot arm has no way to connect the two.
#
# ⛔⛔ Both paths answered 0 whether they worked or not, and every caller printed its own success line
# underneath, so the failure arrived as a `!` warning followed by a `✓` about the same file and an
# exit of zero. A warning a script contradicts one line later is a warning nobody acts on.
forget_original() {
  local kept
  kept="$(grep -v "^${RUNG}=" "$RECORD_FILE")"
  if printf '%s\n' "$kept" | grep -qE '^[0-9a-zA-Z]+='; then
    if ! printf '%s\n' "$kept" > "$RECORD_FILE"; then
      log_warn "could not rewrite ${RECORD_FILE} without rung ${RUNG}, so that record still names it, and a later arm of this rung refuses until the line is removed by hand."
      return 1
    fi
    return 0
  fi
  if ! rm -f "$RECORD_FILE"; then
    log_warn "could not remove ${RECORD_FILE}, so that record still names rung ${RUNG}, and a later arm of this rung refuses until the file is removed by hand."
    return 1
  fi
  return 0
}

# Assigned before use rather than in the `local`, because `local X=$(...)` takes the exit status of
# the `local` and not of the command substitution. (SC2155, the same trap `_lib.sh` documents.)
#
# ⛔⛔ An unchecked `cp` reported a copy that was never made and the rewrite went ahead behind it, so
# the operator was told there was a file to fall back on when there was none.
back_up_env() {
  local backup
  backup="${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
  if ! cp "$ENV_FILE" "$backup"; then
    fail "could not copy ${ENV_FILE##*/} aside to ${backup##*/}, so there is no copy to fall back on and this ${SUBCOMMAND} has changed nothing."
  fi
  log_ok "copied ${ENV_FILE##*/} aside to ${backup##*/}"
}

# Keep the uploader container's log before a redeploy ends the process that wrote it.
#
# ⛔⛔⛔ The one thing the first drain sitting could not get back. On 2026-09-04 bee refused the armed
# rung four times in about fifty seconds, and the restore redeployed the container before anybody had
# read the log, so what bee actually answered went with it: `docker logs` is the container's, and a
# replaced container has none. The suite had reported a count, and a count says nothing about which
# batch on which stream bee refused or in what words.
#
# ⚠️ Beside the bench checkout and never inside it. `bench-on-host.sh` keeps the harness at
# `~/swarm-hls-bench` on this same host and syncs it with `rsync --delete`, so a file written into
# that directory is gone at the next sitting's setup.
#
# ⚠️ A dump that fails says so and returns 0, deliberately. A stage left armed because a log could
# not be written is worse than a lost log, and this runs on the restore path.
dump_uploader_log() {
  local suffix name container status
  suffix="$1"
  container="${PROFILE}-${SVC_UPLOADER}-1"
  name="drain-${PROFILE}-${RUNG}-$(date -u +%Y%m%dT%H%M%SZ)${suffix}.uploader.log"

  if [ "$TARGET" = "$TARGET_LOCAL" ]; then
    # HOME rather than the checkout, so the file sits where the bench checkout would on a host that
    # has one. An environment without HOME falls back to the deployment root rather than to wherever
    # the operator happened to be standing.
    local home="${HOME:-$ROOT_DIR}"
    docker logs "$container" > "${home}/${name}" 2>&1
    status=$?
    if [ "$status" != "0" ]; then
      log_warn "could not read the log of ${container} (docker logs exited ${status}), so this process life is not kept, and the ${SUBCOMMAND} carries on regardless"
      return 0
    fi
    log_ok "kept the uploader log at ${home}/${name}"
    return 0
  fi

  ssh -o ConnectTimeout=10 "$TARGET" "docker logs ${container} > ~/${name} 2>&1"
  status=$?
  if [ "$status" != "0" ]; then
    log_warn "could not read the log of ${container} on ${TARGET} (the dump exited ${status}), so this process life is not kept, and the ${SUBCOMMAND} carries on regardless"
    return 0
  fi
  log_ok "kept the uploader log at ${TARGET}:~/${name}"
}

# The uploader reads BEE_PUBLISHERS once at process start, so an env rewrite that does not redeploy is
# inert. Only the uploader, because nothing else on the stage reads that line.
#
# ⛔ The two batches are named by the caller, because a redeploy that fails leaves the env file naming
# one and the container publishing through the other, and which is which is the opposite way round on
# a restore from on an arm. One fixed sentence written for the arm told a restoring operator the exact
# inverse of their own state.
redeploy_uploader() {
  local now_configured="$1" still_publishing="$2"
  log_info "redeploying the uploader, which is what adopts the line:"
  echo "    deploy/scripts/deploy.sh --profile=${PROFILE} --portSlot=${PORT_SLOT} ${SVC_UPLOADER}"
  if ! "$SCRIPT_DIR/deploy.sh" "--profile=${PROFILE}" "--portSlot=${PORT_SLOT}" "$SVC_UPLOADER"; then
    fail "${ENV_FILE##*/} already names the ${now_configured} and the redeploy failed, so the container is still publishing through the ${still_publishing}, and the fix is to run that deploy command again."
  fi
}

heading() {
  echo ""
  log_info "drain-stage ${SUBCOMMAND}, rung ${RUNG} on :${PORT} (profile ${PROFILE}, target ${TARGET})"
  echo ""
}

do_print_buy() {
  if ! [[ "$DAYS" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    usage_error "--days must be a positive number of days, and this run passed ${DAYS}."
  fi

  read_node "/chainstate"
  require_node_answer "/chainstate"

  local quote first amount rows
  quote="$(printf '%s' "$NODE_BODY" | DAYS="$DAYS" WANT_DEPTH="$ARM_DEPTH" BUCKETS_DEPTH="$BUCKET_DEPTH" \
    BYTES_PER_CHUNK="$CHUNK_BYTES" PLUR_IN_BZZ="$PLUR_PER_BZZ" python3 -c '
import json, math, os, sys

days = float(os.environ["DAYS"])
depth = int(os.environ["WANT_DEPTH"])
bucket_depth = int(os.environ["BUCKETS_DEPTH"])
chunk_bytes = int(os.environ["BYTES_PER_CHUNK"])
plur_per_bzz = int(os.environ["PLUR_IN_BZZ"])


def answer(verdict, text, rows=()):
    print(verdict + "\t" + text)
    for row in rows:
        print(row)
    sys.exit(0)


if days <= 0.0:
    answer("REFUSE", "a batch has to be bought for more than zero days")

try:
    state = json.load(sys.stdin)
except (ValueError, AttributeError) as error:
    answer("REFUSE", f"the node answered /chainstate with something unreadable ({error})")

price = state.get("currentPrice")
blocks = state.get("minimumValidityBlocks")
# Absence is a refusal. minimumValidityBlocks is what turns days into an amount, and reading a
# missing one as zero would print a command buying a batch that expires immediately, which the
# uploader would then refuse at startup.
# Bee answers currentPrice as a JSON string and minimumValidityBlocks as a number, so a digit string
# is as readable as a number here. Anything else, including absence, is a refusal.
def readable(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


price = readable(price)
blocks = readable(blocks)
for name, value in (("currentPrice", price), ("minimumValidityBlocks", blocks)):
    if value is None:
        answer("REFUSE", f"the node answered /chainstate with no readable {name}, so the price of a batch is unknown")

# Postage is charged per chunk per block, so an amount is a per-chunk allowance and the whole batch
# costs it 2**depth times over. minimumValidityBlocks is the shortest life bee will sell, one day of
# blocks, so multiplying it by days buys that many days.
amount = int(round(float(price) * float(blocks) * days))
cost_plur = (2 ** depth) * amount
buckets = 2 ** bucket_depth
per_bucket = 2 ** (depth - bucket_depth)
nominal_chunks = 2 ** depth

# Where the batch actually stops accepting, which is well short of its nominal capacity. A chunk
# lands in a bucket by its own address, and the batch refuses the first chunk whose bucket is full,
# so the question is how many uniformly placed chunks it takes for some bucket to hold one more than
# it can. That is the generalised birthday problem, (k! * n**(k-1)) ** (1/k) for k the first count
# that does not fit.
k = per_bucket + 1
expected_chunks = int(round((math.factorial(k) * buckets ** (k - 1)) ** (1.0 / k)))


def mib(chunks):
    return chunks * chunk_bytes / 1048576.0


answer(
    "OK",
    str(amount),
    (
        f"chain price {int(price)} PLUR per chunk per block, minimum validity {int(blocks)} blocks",
        f"depth {depth}, {days:g} days of life, amount {amount} PLUR per chunk",
        f"cost {cost_plur / plur_per_bzz:.4f} BZZ ({cost_plur} PLUR, at {plur_per_bzz} PLUR per BZZ)",
        f"capacity {nominal_chunks} chunks nominal ({mib(nominal_chunks):.1f} MiB), "
        f"{buckets} buckets of {per_bucket} chunks",
        f"expected to start refusing near {expected_chunks} chunks ({mib(expected_chunks):.1f} MiB), "
        f"anywhere from about {int(expected_chunks * 0.45)} ({mib(int(expected_chunks * 0.45)):.1f} MiB) "
        f"to about {int(expected_chunks * 1.35)} ({mib(int(expected_chunks * 1.35)):.1f} MiB)",
        "the spread is the point: a chunk picks its bucket by its own address, so the first refusal "
        "is a chance event and the rung then refuses a growing share of segments rather than falling "
        "silent at once",
    ),
)
')"

  first="${quote%%$'\n'*}"
  if [ "$(verdict_of "$first")" != "OK" ]; then
    refuse "$(reason_of "$first")."
  fi
  amount="$(text_of "$first")"
  rows="${quote#*$'\n'}"

  heading
  printf '%s\n' "$rows" | sed 's/^/  /'
  echo ""
  log_warn "The owner runs this, from their own shell. This script never runs it."
  echo ""
  if [ "$TARGET" = "$TARGET_LOCAL" ]; then
    echo "    curl -s -XPOST -H 'Immutable: true' '${NODE_URL_PREFIX}${PORT}/stamps/${amount}/${ARM_DEPTH}?label=drain-${RUNG}'"
  else
    echo "    ssh ${TARGET} \"curl -s -XPOST -H 'Immutable: true' '${NODE_URL_PREFIX}${PORT}/stamps/${amount}/${ARM_DEPTH}?label=drain-${RUNG}'\""
  fi
  echo ""
  echo "  Then arm the batch id it answers with:"
  echo ""
  echo "    deploy/scripts/drain-stage.sh --profile=${PROFILE} --portSlot=${PORT_SLOT} --rung=${RUNG} arm --batch=<that id>"
  echo ""
}

do_arm() {
  if [ -z "$BATCH" ]; then
    usage_error "arm needs --batch=<64 hex characters>, the id of the small batch the owner bought on the ${RUNG} node."
  fi
  if ! [[ "$BATCH" =~ ^[0-9a-fA-F]{64}$ ]]; then
    usage_error "--batch must be 64 hex characters, and this run passed ${#BATCH}."
  fi

  local original entry reading written record_now
  if original="$(recorded_original)"; then
    refuse "rung ${RUNG} is already armed, its original batch $(short_id "$original") is recorded in ${RECORD_FILE##*/}, and the way out is restore rather than a second arm."
  fi

  entry="$(publisher_entry read)"
  if [ "$(verdict_of "$entry")" != "OK" ]; then
    refuse "$(reason_of "$entry")."
  fi
  original="$(text_of "$entry")"

  read_node "/stamps"
  require_node_answer "/stamps"
  reading="$(read_batch check "$BATCH")"
  if [ "$(verdict_of "$reading")" != "OK" ]; then
    refuse "$(reason_of "$reading")."
  fi

  heading
  log_ok "the ${RUNG} node holds $(text_of "$reading")"
  # ⛔ The copy and the record both come before the rewrite, and in this order. The copy is what the
  # env file can be put back from and the record is what the rung can be put back from, so a rung is
  # never armed until both exist. A failed copy then leaves nothing behind at all, and a failed record
  # leaves a copy and an env file that still names the rung's own batch.
  back_up_env

  if ! record_original "$original" "$BATCH"; then
    fail "could not record the original batch of rung ${RUNG} in ${RECORD_FILE##*/}, so a restore would have nothing to put back, and ${ENV_FILE##*/} has not been rewritten."
  fi
  log_ok "recorded the original $(short_id "$original") in ${RECORD_FILE##*/}"

  written="$(publisher_entry write "$BATCH")"
  if [ "$(verdict_of "$written")" != "OK" ]; then
    # ⛔⛔ The record goes back out with it. It is written BEFORE the rewrite so that a rung is never
    # armed without one, which means a rewrite that fails leaves a record naming a rung the env file
    # and the container both still point at their own batch. A later arm then refuses as already
    # armed, and the restore an operator reaches for out of that refusal writes the original over
    # itself, reports the rung's own batch as spent, dumps a log and redeploys, for a stage nothing
    # ever changed.
    record_now="and the record of rung ${RUNG} has been cleared, so nothing is armed and the next arm is not refused"
    if ! forget_original; then
      record_now="but ${RECORD_FILE##*/} still names rung ${RUNG}, so the next arm of it refuses as already armed until that line is removed by hand"
    fi
    fail "the ${RUNG} entry could not be rewritten, ${ENV_FILE##*/} is as it was ${record_now}: $(reason_of "$written")."
  fi
  log_ok "BEE_PUBLISHERS now names $(short_id "$BATCH") for ${RUNG}, and the other rungs are untouched"

  # Before the redeploy, because it is the redeploy that ends the process this log belongs to. The
  # arm keeps the life that ran on the ORIGINAL batch, and the restore keeps the drained one.
  dump_uploader_log "-before-arm"
  redeploy_uploader "small batch $(short_id "$BATCH")" "original batch $(short_id "$original")"
  echo ""
  log_warn "The stage is armed. Put it back with the same flags and restore, whatever the sitting reports."
  echo ""
}

do_restore() {
  local original entry written spent
  if ! original="$(recorded_original)"; then
    refuse "nothing is armed for rung ${RUNG} in ${RECORD_FILE##*/}, so there is no original batch to put back and guessing the healthiest one on the node would be a different answer from the one that was swapped out."
  fi

  entry="$(publisher_entry read)"
  if [ "$(verdict_of "$entry")" != "OK" ]; then
    refuse "$(reason_of "$entry")."
  fi

  heading
  back_up_env

  written="$(publisher_entry write "$original")"
  if [ "$(verdict_of "$written")" != "OK" ]; then
    fail "the ${RUNG} entry could not be rewritten and ${ENV_FILE##*/} is as it was: $(reason_of "$written")."
  fi
  # ⛔ The record before the entry. What the rewrite hands back is the batch the entry held a moment
  # ago, which is the armed one the first time and the ORIGINAL every time after, because the first
  # restore already put it back. A restore run again after a failed redeploy therefore reported the
  # rung's own batch as the one that drained, which is the line an operator reads to decide the drain
  # happened at all. The entry is still the answer for a record that predates the armed field.
  if ! spent="$(recorded_armed)"; then
    spent="$(text_of "$written")"
  fi
  log_ok "BEE_PUBLISHERS names $(short_id "$original") for ${RUNG} again, and $(short_id "$spent") is spent"

  # ⛔ Before the redeploy. This is the log of the process that spent the drained batch, which is the
  # whole evidence of the sitting, and the redeploy replaces the container it lives in.
  dump_uploader_log ""
  redeploy_uploader "original batch $(short_id "$original")" "drained batch $(short_id "$spent")"

  # ⛔ After the redeploy, because the record is what makes a failed restore recoverable. Forgetting it
  # first meant a restore that could not bring the container up deleted the only note of which batch
  # the rung had been publishing through, and running the same restore again refused with nothing
  # armed. Running it again is now the whole recovery.
  #
  # ⛔ A refusal rather than a warning, and the last step rather than a rollback: the env file and the
  # container are both genuinely back by this point, so there is nothing to undo and the one thing
  # left wrong is a file that will refuse the next arm of this rung.
  if ! forget_original; then
    fail "${ENV_FILE##*/} and the uploader are both restored, but ${RECORD_FILE##*/} still names rung ${RUNG}, so the next arm of it refuses as already armed, and the fix is to remove that line from the record by hand."
  fi
  log_ok "removed the record for ${RUNG} from ${RECORD_FILE##*/}"
  echo ""
}

do_status() {
  local entry configured original reading
  entry="$(publisher_entry read)"
  if [ "$(verdict_of "$entry")" != "OK" ]; then
    refuse "$(reason_of "$entry")."
  fi
  configured="$(text_of "$entry")"

  heading
  echo "  BEE_PUBLISHERS names $(short_id "$configured") for ${RUNG}"
  if original="$(recorded_original)"; then
    echo "  armed: yes, the original is $(short_id "$original") (recorded in ${RECORD_FILE##*/})"
  else
    echo "  armed: no"
  fi

  read_node "/stamps"
  require_node_answer "/stamps"
  reading="$(read_batch read "$configured")"
  # A batch the node does not list is an ABSENT verdict carrying a whole sentence, and that sentence
  # is a legitimate status report: it is what an armed rung looks like once its batch has gone. An
  # EMPTY reading is neither verdict and is this script rather than the node, and printing it left
  # `/stamps: ` on stdout and exit zero, on the one subcommand an operator runs to decide whether a
  # stage is safe to publish against.
  case "$(verdict_of "$reading")" in
    OK | ABSENT) ;;
    *) fail "$(reason_of "$reading")." ;;
  esac
  echo "  /stamps: $(text_of "$reading")"
  echo ""
}

case "$SUBCOMMAND" in
  print-buy) do_print_buy ;;
  arm) do_arm ;;
  restore) do_restore ;;
  status) do_status ;;
esac
