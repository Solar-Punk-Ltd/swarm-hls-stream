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

# What this night has cost so far, summed over every node that can spend.
#
# Prints two lines: the total in plur, then the names of any nodes now holding MORE than their start
# balance. Prints nothing at all when any node's balance is unknown. ⛔ An unreadable chequebook is
# not zero spend: a node that stopped answering is exactly when a run should stop.
#
# ⛔ The second line exists because this runs inside a command substitution, so a variable set here
# dies with the subshell and cannot reach the caller.
spent_so_far_plur() {
  local total=0 rose='' who port start now fell
  for pair in "uploader:${UPLOADER_BEE_PORT}:uploader_start_plur" \
    "gateway:${GATEWAY_BEE_PORT}:gateway_start_plur"; do
    who="${pair%%:*}"
    port="$(echo "${pair}" | cut -d: -f2)"
    start="$(ledger_field "$(echo "${pair}" | cut -d: -f3)")"
    if [ -z "${start}" ]; then
      say "  REFUSING: the spend ledger has no start balance for the ${who}, so tonight's cost is unknown"
      return 1
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
  done
  printf '%s\n%s' "${total}" "${rose}"
}

# Zero when this sitting fits inside what is left of the authorisation.
within_ceiling() {
  local minutes="$1" ceiling reading spent rose projected remaining
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

  reading="$(spent_so_far_plur)" || return 1
  spent="$(printf '%s\n' "${reading}" | sed -n 1p)"
  rose="$(printf '%s\n' "${reading}" | sed -n 2p)"
  projected=$(((UPLOADER_BURN_PLUR_PER_MIN + GATEWAY_BURN_PLUR_PER_MIN) * minutes))
  remaining=$((ceiling - spent))

  say "  spend ceiling: $(spend_bzz "${ceiling}") BZZ authorised, $(spend_bzz "${spent}") BZZ already spent, $(spend_bzz "${projected}") BZZ projected for ${minutes} min"
  # Printed after the summary on purpose, so the run log carries the number this refusal is rejecting
  # rather than leaving a reader to wonder what the gate saw.
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
