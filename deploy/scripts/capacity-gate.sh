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

# One variable off the container that is actually publishing.
uploader_env() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${UPLOADER_CONTAINER}" 2>/dev/null |
    sed -n "s/^$1=//p" | head -1
}

# ⛔ Read off the container that is actually publishing, never off a file and never by shape.
# `.env.latbench` is gitignored and lives on the host, `/stamps` lists batches of which some are dead,
# and "the stamp" has meant a different row on three separate days here. The uploader's own
# environment is the only source that cannot be stale.
resolve_stamp() {
  [ -n "${STAMP:-}" ] && {
    printf '%s' "${STAMP}"
    return 0
  }
  uploader_env STAMP
}

# Every batch this stage will spend, one `port batch rung` per line.
#
# ⛔⛔⛔ BEE_PUBLISHERS first, and this is the whole point of the function. After the per-rung split
# STAMP names only the fallback node, so a gate reading STAMP alone checks one batch of four. Across
# the shipped ladder 1080p burns roughly seven times the bytes of 360p, which makes the batch most
# likely to run out mid-sitting precisely the one that gate would never read. Same failure shape as
# the one this file was written for, one level up: a gate that reads a row the sitting does not write.
resolve_batches() {
  local publishers
  publishers="${BEE_PUBLISHERS:-$(uploader_env BEE_PUBLISHERS)}"

  if [ -z "${publishers}" ]; then
    local batch
    batch="$(resolve_stamp)"
    [ -n "${batch}" ] && printf '%s %s all\n' "${UPLOADER_BEE_PORT}" "${batch}"
    return 0
  fi

  # `rung@url<batch>`, split on the first `@` and the last bracket, which is what
  # `parsePublisherSpecs` in the uploader does, so a url carrying userinfo or a path survives. The
  # older `#` separator is still accepted there and so is accepted here.
  local entry rung rest url stamp hostport port
  for entry in ${publishers}; do
    rung="${entry%%@*}"
    rest="${entry#*@}"
    if [ "${rest%>}" != "${rest}" ]; then
      stamp="${rest##*<}"
      stamp="${stamp%>}"
      url="${rest%<*}"
    else
      stamp="${rest##*#}"
      url="${rest%#*}"
    fi
    hostport="${url##*://}"
    hostport="${hostport%%/*}"
    port="${hostport##*:}"
    printf '%s %s %s\n' "${port}" "${stamp}" "${rung}"
  done
}

# Capacity, checked the same way funding is: before the spend, as something that refuses.
#
# ⛔ The rule this enforces was already written down, in bold, in two places, and read automatically
# by `e2e/src/browser/resources.ts` — which warns at the END of a run, after the broadcast is paid
# for. Three sittings ran past the 75% line on 2026-08-12 because remembering to look was the only
# thing between the threshold and the spend.
#
# ⚠️ **The projection is exact for nothing above 360p, and the two hard checks are exact for all of
# them.** `stamp-guard.sh` costs a sitting at `BUCKETS_PER_BROADCAST_HOUR`, measured on the shared
# single-node stage, so for the taller rungs it under-costs the sitting and the "will it finish"
# arithmetic is optimistic. The utilization ceiling and the TTL floor need no rate and hold on every
# rung, which is what stops a batch that is already past the line. Naming the gap rather than scaling
# it by a number nobody measured.
has_capacity() {
  local minutes="$1" pairs port batch rung refused=0
  pairs="$(resolve_batches)"
  if [ -z "${pairs}" ]; then
    say "  REFUSING: could not read a postage batch off ${UPLOADER_CONTAINER}, so capacity is unknown"
    return 1
  fi

  # Every rung is checked and none short-circuits, so one run tells an operator every batch that
  # needs attention instead of one per refused sitting.
  while read -r port batch rung; do
    [ -n "${port}" ] || continue
    case "${port}" in
      '' | *[!0-9]*)
        say "  REFUSING: the ${rung} publisher entry names no port, so its batch cannot be read"
        refused=1
        continue
        ;;
    esac
    if [ "${#batch}" != 64 ]; then
      say "  REFUSING: the ${rung} batch id is ${#batch} characters, not 64, so it is a truncated paste"
      refused=1
      continue
    fi
    if ! STAMP_GUARD_PORT="${port}" bash "${STAMP_GUARD}" \
      --batch "${batch}" --minutes "${minutes}" --port "${port}" >> "${LOG}" 2>&1; then
      say "  REFUSING: stamp-guard says this sitting cannot finish on the ${rung} batch ${batch:0:8} (:${port})"
      refused=1
    fi
  done <<< "${pairs}"

  [ "${refused}" = "0" ]
}
