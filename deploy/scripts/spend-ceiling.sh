# shellcheck shell=bash
#
# Sourced, never executed, so it carries a shell directive instead of a shebang.
#
# Refuse a sitting that would spend past what the owner authorised, as something that exits non-zero
# before the publisher starts.
#
# ⛔⛔⛔ `can_afford()` IS NOT THIS CHECK, AND READS EXACTLY LIKE IT.
#
# `can_afford` asks whether a node holds enough to pay for the next sitting. That stays true until the
# chequebook is empty, so it authorises the whole balance. An owner who says "up to 2.4 BZZ tonight"
# out of a 3.5 BZZ balance has authorised less than the node can pay, and no driver could see the
# difference. Worse, two sittings that each pass `can_afford` can still land past the authorisation
# together, because neither knows the other ran.
#
# ⛔⛔ A THRESHOLD WRITTEN DOWN IS NOT A CONTROL, ONLY A GATE THAT REFUSES IS.
#
# On 2026-08-12 a postage stop line lived in two files, in bold, with an automatic checker already
# reading it, and three paid sittings ran past it anyway, because the checker warned at the END of a
# run. The number has to sit in the path between the operator and the spend.
#
# ## What it measures spend with
#
# `availableBalance`, per node, against what that node held when the authorisation was written.
#
# ⚠️ NOT `totalBalance`. The two move on different events: writing a cheque drops `available` and
# leaves `total`, and a peer **cashing** a cheque already written drops `total` and leaves `available`.
# Spending is the first of those, so `available` is the field that falls when this night costs
# something, and a run that quoted `total` would report a neighbour cashing an old cheque as tonight's
# spend.
#
# ⛔ A node whose balance ROSE counts as having spent nothing, never as headroom. Summing signed
# deltas would let a top-up on one node pay for an overrun on the other, which is not what an
# authorisation of a total means.
#
# ⛔⛔⛔ AND A RISE ALSO ENDS THE LEDGER, WHICH THE CLAMP ALONE DOES NOT SAY.
#
# Clamping keeps the arithmetic honest and still throws the history away. On 2026-08-14 the owner
# deposited 12 BZZ into the gateway. That node's 0.5406 BZZ of real spend stopped being a counted
# term and became a clamped zero, and this gate went on printing a total short by exactly that much
# with nothing anywhere marking it. The uploader was topped up minutes later, which would have taken
# the printed total to 0.000 BZZ against a ceiling 1.98 of which was already gone.
#
# `availableBalance` has no other way up. Writing a cheque lowers it and a peer cashing one leaves it
# alone, so a rise is a deposit, and a deposit means these baselines were written before it. Spend
# measured from stale baselines is not a smaller number, it is an unknown one, and unknown spend is
# refused here for the same reason an unreadable chequebook is.
#
# ## ⛔⛔⛔ EVERY NODE THAT CAN SPEND, NEVER A FIXED PAIR
#
# This read exactly two chequebooks until 2026-08-31, an `uploader` and a `gateway`, which was the
# whole deployment when it was written. Splitting the publisher into one Bee node per ABR rung made it
# four plus the gateway, and the three new ones were invisible here while holding 5.00 BZZ each. That
# is worse than a refusal: the gate would pass a sitting while watching a minority of the money, and
# most publishing spend now lands on the nodes it was not looking at.
#
# The publisher set therefore comes from the uploader's own `BEE_PUBLISHERS`, and coverage is checked
# both ways. A node with no baseline is refused because unknown spend is not zero spend. A baseline
# with no node is refused because a node that stopped answering is exactly when a run should stop.
#
# ## What the caller owes it
#
# These drivers run `set -u` without `set -e`, so a gate that quietly did nothing because its caller
# had not defined something yet would let the sitting publish. An incomplete caller is refused here,
# where the mistake is.
declare -F say > /dev/null 2>&1 || {
  echo "spend-ceiling.sh: source me after the caller's say(), so a refusal lands in the run's own log" >&2
  exit 1
}
declare -F available_plur > /dev/null 2>&1 || {
  echo "spend-ceiling.sh: source me after available_plur(), which is how it reads a chequebook" >&2
  exit 1
}
declare -F uploader_env > /dev/null 2>&1 || {
  echo "spend-ceiling.sh: source me after capacity-gate.sh, which is where uploader_env() lives. The set of nodes that can spend comes from the uploader's own BEE_PUBLISHERS, not from a constant here" >&2
  exit 1
}
: "${LOG:?spend-ceiling.sh needs LOG, the file its refusals are written to}"
: "${UPLOADER_BEE_PORT:?spend-ceiling.sh needs UPLOADER_BEE_PORT}"
: "${GATEWAY_BEE_PORT:?spend-ceiling.sh needs GATEWAY_BEE_PORT}"
: "${UPLOADER_BURN_PLUR_PER_MIN:?spend-ceiling.sh needs UPLOADER_BURN_PLUR_PER_MIN, source burn-rates.sh}"
: "${GATEWAY_BURN_PLUR_PER_MIN:?spend-ceiling.sh needs GATEWAY_BURN_PLUR_PER_MIN, source burn-rates.sh}"

# Where the night's authorisation lives. Written once, when the owner gives it, and read by every
# sitting that follows so they cannot each spend the whole allowance.
SPEND_CEILING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPEND_LEDGER="${SPEND_LEDGER:-${SPEND_CEILING_DIR}/../../.spend-ledger.env}"

# Its own formatter rather than the caller's `bzz()`, so sourcing this cannot depend on which driver
# it landed in or quietly redefine a function the driver already uses.
spend_bzz() { printf '%d.%03d' "$(($1 / 10000000000000000))" "$((($1 % 10000000000000000) / 10000000000000))"; }

ledger_field() {
  sed -n "s/^$1=//p" "${SPEND_LEDGER}" 2>/dev/null | head -1
}

# Every node that can spend, as "port name" lines: each publisher the uploader routes through, then
# the gateway.
#
# ⛔ Deduplicated by port, because two rungs can share one Bee node and reading that node twice would
# count its spend twice, which is an overrun the gate would create rather than catch.
#
# ⛔ Takes the publisher list as an argument rather than reading it, for the reason `resolve_batches`
# in capacity-gate.sh does: this runs inside a command substitution, so anything it assigned would be
# assigned in a subshell and lost.
spend_nodes() {
  local publishers="$1" entry url port seen='' rung
  if [ -z "${publishers}" ]; then
    printf '%s uploader\n' "${UPLOADER_BEE_PORT}"
    seen="${UPLOADER_BEE_PORT}"
  else
    for entry in ${publishers}; do
      rung="${entry%%@*}"
      url="${entry#*@}"
      # Angle brackets are the batch form; `#` is the older one, which an env file truncates at.
      url="${url%%<*}"
      url="${url%%#*}"
      port="${url##*:}"
      port="${port%%/*}"
      case " ${seen} " in *" ${port} "*) continue ;; esac
      seen="${seen}${seen:+ }${port}"
      printf '%s %s\n' "${port}" "${rung} publisher"
    done
  fi
  case " ${seen} " in
    *" ${GATEWAY_BEE_PORT} "*) ;;
    *) printf '%s gateway\n' "${GATEWAY_BEE_PORT}" ;;
  esac
}

# The ports the ledger holds a baseline for, so a baseline nothing read can be named.
ledger_ports() {
  sed -n 's/^node_\([0-9]\{1,\}\)_start_plur=.*/\1/p' "${SPEND_LEDGER}" 2>/dev/null | sort -u
}

# What this night has cost so far, summed over every node that can spend.
#
# Prints three lines: the total in plur, the names of any nodes now holding MORE than their start
# balance, then the nodes with no baseline at all. Prints nothing when any node's balance is unknown.
# ⛔ An unreadable chequebook is not zero spend: a node that stopped answering is exactly when a run
# should stop.
#
# ⛔ The extra lines exist because this runs inside a command substitution, so a variable set here
# dies with the subshell and cannot reach the caller.
spent_so_far_plur() {
  local total=0 rose='' missing='' who port start now fell nodes
  nodes="$(spend_nodes "$1")"
  # A heredoc rather than a pipe: a piped `while` runs in its own subshell, so every total below would
  # be discarded at the `done`.
  while read -r port who; do
    [ -z "${port}" ] && continue
    start="$(ledger_field "node_${port}_start_plur")"
    if [ -z "${start}" ]; then
      missing="${missing}${missing:+, }${who} on ${port}"
      continue
    fi
    now="$(available_plur "${port}")"
    if [ -z "${now}" ]; then
      say "  REFUSING: the ${who} chequebook on ${port} did not answer, and unknown spend is not zero spend"
      return 1
    fi
    fell=$((start - now))
    # A rise contributes nothing. Signed deltas would let a top-up on one node fund an overrun on the
    # other, which is not what a total authorisation means. It is also reported, because a clamp that
    # is silent turns a deposit into permanently missing history.
    if [ "${fell}" -lt 0 ]; then
      fell=0
      rose="${rose}${rose:+ }${who}"
    fi
    total=$((total + fell))
  done << NODES
${nodes}
NODES
  printf '%s\n%s\n%s' "${total}" "${rose}" "${missing}"
}

# Zero when this sitting fits inside what is left of the authorisation.
within_ceiling() {
  local minutes="$1" ceiling reading spent rose missing projected remaining publishers unread port nodes
  if [ ! -r "${SPEND_LEDGER}" ]; then
    say "  REFUSING: no spend ledger at ${SPEND_LEDGER}, so nothing here is authorised to spend"
    return 1
  fi
  ceiling="$(ledger_field ceiling_plur)"
  case "${ceiling}" in
    '' | *[!0-9]*)
      say "  REFUSING: the spend ledger names no numeric ceiling, and a missing ceiling is not an unlimited one"
      return 1
      ;;
  esac

  # Assigned out here rather than inside spent_so_far_plur, which runs in a command substitution.
  publishers="${BEE_PUBLISHERS:-$(uploader_env BEE_PUBLISHERS)}"

  reading="$(spent_so_far_plur "${publishers}")" || return 1
  spent="$(printf '%s\n' "${reading}" | sed -n 1p)"
  rose="$(printf '%s\n' "${reading}" | sed -n 2p)"
  missing="$(printf '%s\n' "${reading}" | sed -n 3p)"

  # The other direction: a baseline the ledger holds for a node nothing on this stage reads.
  #
  # ⛔ Anchored at the start of a line rather than matched anywhere in the list, because a port that
  # is a suffix of another one would otherwise report itself as covered.
  nodes="$(spend_nodes "${publishers}")"
  unread=''
  for port in $(ledger_ports); do
    printf '%s\n' "${nodes}" | grep -q "^${port} " || unread="${unread}${unread:+, }${port}"
  done

  # ⚠️ Measured on a single 720p rendition at 2500 kbps. A four-rung ladder publishes about 3.9x that
  # many bytes, so this forecast is LOW on a split stage and the override in burn-rates.sh is how a
  # caller corrects it. Deliberately not scaled by an invented multiplier here: the first four-rung
  # sitting measures the real rate, and a number nobody measured does not belong in a money gate.
  projected=$(((UPLOADER_BURN_PLUR_PER_MIN + GATEWAY_BURN_PLUR_PER_MIN) * minutes))
  remaining=$((ceiling - spent))

  say "  spend ceiling: $(spend_bzz "${ceiling}") BZZ authorised, $(spend_bzz "${spent}") BZZ already spent, $(spend_bzz "${projected}") BZZ projected for ${minutes} min"
  # Printed after the summary on purpose, so the run log carries the number this refusal is rejecting
  # rather than leaving a reader to wonder what the gate saw.
  # Coverage outranks both refusals below. A total summed over some of the nodes is not a smaller
  # total, it is a different quantity, so quoting it would tell the operator to act on a number that
  # does not mean what it says.
  if [ -n "${missing}" ] || [ -n "${unread}" ]; then
    [ -n "${missing}" ] && say "  REFUSING: the spend ledger has no start balance for ${missing}, and unknown spend is not zero spend"
    [ -n "${unread}" ] && say "  REFUSING: the spend ledger baselines port ${unread}, which nothing on this stage reads, so it was written for a different set of nodes"
    say "  Rewrite ${SPEND_LEDGER} covering every node that can spend: deploy/scripts/spend-ledger.sh --authorise=<BZZ>"
    return 1
  fi
  if [ -n "${rose}" ]; then
    say "  REFUSING: balance is above its start on ${rose}, so a deposit landed after this authorisation was written and the spend above is measured from baselines that predate it"
    say "  Rewrite ${SPEND_LEDGER} with fresh start balances and the total the owner has now authorised."
    return 1
  fi
  if [ "${projected}" -gt "${remaining}" ]; then
    say "  REFUSING: $(spend_bzz "${projected}") BZZ projected against $(spend_bzz "${remaining}") BZZ left of the authorisation"
    return 1
  fi
  return 0
}
