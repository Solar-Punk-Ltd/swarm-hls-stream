# shellcheck shell=bash
#
# Sourced, never executed, so it carries a shell directive instead of a shebang.
#
# Refuse a sitting the postage batch cannot carry, in the same breath as the funding check beside it.
#
# ⛔⛔⛔ THIS FILE EXISTS BECAUSE THE GATE WAS IN ONE DRIVER OF THREE.
#
# On 2026-08-13 `viewer-arms.sh` refused on postage and the other two publishing drivers did not.
# `sweep-interleaved.sh` asked nothing at all. `phase06-light-vs-ultralight.sh` had a reader of its
# own that selected `depth == 24 and immutableFlag` out of `/stamps` and compared the result against a
# hardcoded 256 buckets. The measurement batch on the host is **depth 25 with 512 buckets**, diluted
# there by the fix `stamp-guard.sh` itself prints, so that filter matched nothing at all: the sitting
# would have refused with "postage utilization could not be read", which names neither the batch nor
# the reason.
#
# ⭐ A gate stuck closed fails in the safe direction and is still not a gate. It never read the batch
# it was protecting, and the day somebody buys a depth-24 batch for something else it starts gating a
# sitting on a row that sitting does not write to. Selecting a batch by SHAPE is the defect; the id
# the uploader is configured with is the only thing that cannot drift.
#
# ## The rule this enforces
#
# **Pricing a sitting and checking it can carry are the same precondition.** A driver that knows the
# minutes well enough to cost them knows them well enough to ask whether the postage lasts, so
# `deploy/test/capacityGate.test.js` obliges every script sourcing `burn-rates.sh` to source this too,
# and refuses a second definition anywhere in `deploy/scripts`.
#
# ## What the caller owes it
#
# ⛔ These drivers run `set -u` without `set -e`, so a gate that quietly did nothing because its
# caller had not set `LOG` yet would let the sitting publish. An incomplete caller is refused here,
# where the mistake is, rather than four hundred lines later inside a funding function.
declare -F say > /dev/null 2>&1 || {
  echo "capacity-gate.sh: source me after the caller's say(), so a refusal lands in the run's own log" >&2
  exit 1
}
: "${LOG:?capacity-gate.sh needs LOG, the file its refusals are written to}"
: "${UPLOADER_BEE_PORT:?capacity-gate.sh needs UPLOADER_BEE_PORT, the node it reads /stamps from}"

CAPACITY_GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP_GUARD="${STAMP_GUARD:-${CAPACITY_GATE_DIR}/stamp-guard.sh}"
UPLOADER_CONTAINER="${UPLOADER_CONTAINER:-latbench-stream-uploader-1}"

# ⛔ Read off the container that is actually publishing, never off a file and never by shape.
# `.env.latbench` is gitignored and lives on the host, `/stamps` lists batches of which some are dead,
# and "the stamp" has meant a different row on three separate days here. The uploader's own
# environment is the only source that cannot be stale.
resolve_stamp() {
  [ -n "${STAMP:-}" ] && {
    printf '%s' "${STAMP}"
    return 0
  }
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${UPLOADER_CONTAINER}" 2>/dev/null |
    sed -n 's/^STAMP=//p' | head -1
}

# Capacity, checked the same way funding is: before the spend, as something that refuses.
#
# ⛔ The rule this enforces was already written down, in bold, in two places, and read automatically
# by `e2e/src/browser/resources.ts` — which warns at the END of a run, after the broadcast is paid
# for. Three sittings ran past the 75% line on 2026-08-12 because remembering to look was the only
# thing between the threshold and the spend.
has_capacity() {
  local minutes="$1" batch
  batch="$(resolve_stamp)"
  if [ -z "${batch}" ]; then
    say "  REFUSING: could not read STAMP off ${UPLOADER_CONTAINER}, so batch capacity is unknown"
    return 1
  fi
  if ! STAMP_GUARD_PORT="${UPLOADER_BEE_PORT}" bash "${STAMP_GUARD}" \
    --batch "${batch}" --minutes "${minutes}" --port "${UPLOADER_BEE_PORT}" >> "${LOG}" 2>&1; then
    say "  REFUSING: stamp-guard says this sitting cannot finish on batch ${batch:0:8}"
    return 1
  fi
  return 0
}
