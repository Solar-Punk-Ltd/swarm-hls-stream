#!/bin/bash
# What does it cost to ask a gateway for a feed slot that nobody has written?
#
# The announcement floor turned out to be a miss floor: at the live edge a not-found slot read costs
# about 4.5x a successful one and roughly 45% of reads are not-founds. That was read off archived
# browser request logs, which go through the client dev server, so the absolute milliseconds carry a
# proxy hop and cannot be set beside anything measured against the gateway directly.
#
# This measures the same two things on the direct path.
#
# ## Why random identifiers are the right model of an unwritten slot
#
# ⭐ A single-owner chunk's address is a hash of its identifier and its owner, so consecutive feed slots
# land at unrelated addresses. There is no locality and no notion of distance: asking for slot N+1 and
# asking for slot N+100 are both lookups for an address nothing has. **A random identifier under a real
# owner is therefore the same kind of request as the next unwritten slot**, which is what makes this
# measurable without a live publisher.
#
# ⛔ Blocks ALTERNATE hit, miss, hit, miss rather than running all hits then all misses. A sitting that
# runs one condition and then the other cannot tell the condition from drift, which this project has
# already paid for at up to 1.95x with nothing happening.
set -u

GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-10077}"
OUT_DIR="${OUT_DIR:-/home/solarpunk/soc-miss}"
# Real slot identifiers that a browser fetched successfully, one per line, owner included.
HITS_FILE="${HITS_FILE:-${OUT_DIR}/hits.txt}"
READS_PER_BLOCK="${READS_PER_BLOCK:-100}"
BLOCKS="${BLOCKS:-4}"

mkdir -p "${OUT_DIR}"
LOG="${OUT_DIR}/soc-miss.log"
SAMPLES="${OUT_DIR}/soc-miss.tsv"

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "${LOG}"; }

if [ ! -s "${HITS_FILE}" ]; then
  say "⛔ ${HITS_FILE} is missing or empty, so there is nothing to compare a miss against"
  exit 1
fi

OWNER="$(head -1 "${HITS_FILE}" | cut -d/ -f1)"

# 32 bytes of hex from the kernel, so the identifier is one nothing has ever written.
random_identifier() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

read_one() {
  curl -s -o /dev/null -m 30 -w '%{http_code} %{time_total} %{size_download}' \
    "http://127.0.0.1:${GATEWAY_BEE_PORT}/soc/$1"
}

# ⭐ Spendable balance per block, so what a miss costs is attributed rather than inferred. A whole run's
# delta cannot separate the two conditions, and it cannot separate either from the node settling
# something in the background, which is what the idle block is for.
spendable() {
  curl -s -m 5 "http://127.0.0.1:${GATEWAY_BEE_PORT}/chequebook/balance" 2>/dev/null |
    grep -o '"availableBalance":"[0-9]*"' | grep -o '[0-9]*'
}

run_block() {
  local kind="$1" block="$2" i out code secs bytes ms
  for i in $(seq 1 "${READS_PER_BLOCK}"); do
    if [ "${kind}" = hit ]; then
      # Cycles the list rather than sampling it, so every block asks for the same work in the same order.
      out="$(read_one "$(sed -n "$(((i - 1) % $(wc -l <"${HITS_FILE}") + 1))p" "${HITS_FILE}")")"
    else
      out="$(read_one "${OWNER}/$(random_identifier)")"
    fi
    read -r code secs bytes <<<"${out}"
    ms="$(awk -v s="${secs}" 'BEGIN{printf "%d", s*1000}')"
    printf '%s\t%s\t%s\t%s\t%s\n' "${block}" "${kind}" "${code}" "${ms}" "${bytes}" >>"${SAMPLES}"
  done
}

summarise() {
  awk -F'\t' '
    # ⛔ Skip the header. A proving run counted it as a sample and reported a third condition called
    # "kind" with one reading of 0ms, which looked like a result rather than a column name.
    NR == 1 { next }
    { key = $2; n[key]++; v[key "\t" n[key]] = $4; codes[key "\t" $3]++ }
    END {
      for (k in n) {
        c = n[k]
        for (i = 1; i <= c; i++) a[i] = v[k "\t" i]
        # Insertion sort is fine at these counts and keeps the reducer to one pass of plain awk.
        for (i = 2; i <= c; i++) { x = a[i]; j = i - 1; while (j > 0 && a[j] > x) { a[j+1] = a[j]; j-- } a[j+1] = x }
        printf "%-5s n=%-4d median %5dms  p10 %5dms  p90 %5dms  max %5dms\n", \
          k, c, a[int(c/2)+1], a[int(c*0.1)+1], a[int(c*0.9)+1], a[c]
      }
      for (k in codes) { split(k, p, "\t"); printf "  %s returned HTTP %s x%d\n", p[1], p[2], codes[k] }
    }' "${SAMPLES}"
}

say "=== SOC miss cost: ${BLOCKS} alternating blocks of ${READS_PER_BLOCK}, direct to the gateway ==="
say "owner ${OWNER}, $(wc -l <"${HITS_FILE}") known-good identifiers"
[ -s "${SAMPLES}" ] || printf 'block\tkind\tcode\tms\tbytes\n' >"${SAMPLES}"

for b in $(seq 1 "${BLOCKS}"); do
  kind=hit
  [ $((b % 2)) = 0 ] && kind=miss
  before="$(spendable)"
  started="$(date +%s)"
  run_block "${kind}" "${b}"
  after="$(spendable)"
  say "block ${b}: ${READS_PER_BLOCK} ${kind}s in $(($(date +%s) - started))s, spent $((before - after)) wei"

  # ⛔ An idle block of the same shape after every measured one. Without it a spend is being attributed
  # to the reads when the node settles in the background whether or not anything asked it for a chunk.
  before="$(spendable)"
  sleep "${IDLE_BLOCK_S:-20}"
  after="$(spendable)"
  say "  idle ${IDLE_BLOCK_S:-20}s control: spent $((before - after)) wei with nothing asked of it"
done

say "=== result ==="
summarise | tee -a "${LOG}"
say "=== done ==="
