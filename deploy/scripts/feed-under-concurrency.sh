#!/bin/bash
# What does a feed slot read cost when many viewers are reading the feed at once?
#
# ## The gap this fills, and it is a large one
#
# Every concurrency figure this project has (0.9c, 0.9c-ii: 16, 128, 192, 512 viewers) came from a
# probe that replays a fixed list of chunk references. That probe never reads a feed. So the whole
# scale story above eight viewers was measured with **zero feed reads in it**, while LAT-11 put feed
# staleness at 1.30x at eight and nothing has looked since. Task #23.
#
# It matters because the feed is where a viewer learns that media exists. The announcement floor
# measured one slot read at the live edge at ~289ms averaged over a 45% miss rate, so a reader
# sustains about 3.5 slot reads a second **on an idle gateway**. If that degrades with concurrency,
# viewers stop discovering segments before they stop retrieving them, and no reference-list sweep can
# see it.
#
# ## Why this needs no broadcast
#
# A single-owner chunk's address is a hash of its identifier and its owner, so slots sit at unrelated
# addresses and a slot nobody has written is simply an address nobody has. That is what makes both
# conditions reproducible against a **finished** feed:
#
#   - a **hit** is a real identifier a browser fetched, from `hits.txt`
#   - a **miss** is a random identifier under the same owner, which is the same kind of request as the
#     next unwritten slot
#
# No encoder, no publisher, no upload, no postage. Misses were measured to spend nothing at all, and
# the hits are chunk reads on the **gateway** chequebook, which holds 6.1 BZZ and has never bound.
# The uploader chequebook is untouched.
#
# ⛔ **What this therefore cannot say.** It measures what a feed read COSTS under concurrency. It does
# not measure how far behind a live publisher a viewer ends up, because there is no live publisher
# here. The cost is the mechanism and the lag is the outcome; deriving one from the other assumes the
# walk is read-bound, which is stated in the report rather than hidden in it.
#
# ## The two shapes, and the reason both are run
#
# `spread`  each reader walks its own offset, so N readers want N different slots
# `same`    every reader asks for the same slot at the same time, which is what a live audience IS
#
# ⭐ The synchronised-audience finding says what limits a gateway is how many viewers want the same
# chunk at once, and it was established on **segments**. The feed is where that pressure is sharpest,
# because every viewer at the live edge wants exactly the same newest slot. Running only `spread`
# would measure the comfortable case and call it the answer.
#
# ⛔ Arms ALTERNATE against a reference of one reader rather than climbing. Relabelling eight unchanged
# runs as if the viewer count had varied once moved a metric by 1.95x with nothing happening, so a
# ladder cannot resolve anything under ~2x on this host.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_LOAD="${HERE}/host-load.sh"
# shellcheck source=deploy/scripts/host-load.sh
. "${HOST_LOAD}" || {
  echo "cannot read ${HOST_LOAD}: sync deploy/scripts as a directory, not one script" >&2
  exit 1
}

GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-10077}"
OUT_DIR="${OUT_DIR:-/home/solarpunk/feed-concurrency}"
HITS_FILE="${HITS_FILE:-/home/solarpunk/soc-miss/hits.txt}"

# Reads per reader, held CONSTANT across arms. The work one viewer does must not change with how many
# viewers there are, or the arms measure two things at once.
READS_PER_READER="${READS_PER_READER:-40}"

# `viewers:mode`, in order. One reader either side of each pair, so drift across the sitting separates
# from concurrency.
ARM_PLAN="${ARM_PLAN:-1:spread 8:spread 8:same 1:spread 32:spread 32:same 1:spread 128:spread 128:same 1:spread}"

LOAD_SAMPLE_S="${LOAD_SAMPLE_S:-2}"
LOAD_SETTLE_MAX_S="${LOAD_SETTLE_MAX_S:-120}"
IDLE_BLOCK_S="${IDLE_BLOCK_S:-15}"

mkdir -p "${OUT_DIR}"
LOG="${OUT_DIR}/feed-concurrency.log"
SAMPLES="${OUT_DIR}/feed-concurrency.tsv"

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "${LOG}"; }

if [ ! -s "${HITS_FILE}" ]; then
  say "⛔ ${HITS_FILE} is missing or empty, so there is nothing to read as a hit"
  exit 1
fi

OWNER="$(head -1 "${HITS_FILE}" | cut -d/ -f1)"
HIT_COUNT="$(wc -l <"${HITS_FILE}")"

host_load() { awk '{print $1}' /proc/loadavg; }
# One runnable task per core, which is where the box stops having spare capacity and starts making
# everything queue. ⛔ This host carries forty other bee nodes and eight unrelated stacks and they are
# not ours to slow down, so the plan is ordered by ascending viewers and the first arm to push the box
# too far is the last one that runs.
LOAD_CEILING="${LOAD_CEILING:-$(nproc)}"

BASELINE_RUNNABLE="$(baseline_runnable)"

settle_host() {
  local waited=0 now target="${LOAD_SETTLE:-$((BASELINE_RUNNABLE + 8))}"
  while [ "${waited}" -lt "${LOAD_SETTLE_MAX_S}" ]; do
    now="$(host_runnable)"
    if [ "${now}" -le "${target}" ]; then
      [ "${waited}" -gt 0 ] && say "  box settled to ${now} runnable after ${waited}s"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  say "  ⚠️ box did not settle to ${target} runnable within ${LOAD_SETTLE_MAX_S}s, now $(host_runnable)"
}

# The mean of an arm's runnable samples, for the reason the retrieval probe gives: readers fire
# together and then all block, so the queue is bimodal and neither its median nor its peak describes
# the box. Field 2 is the runnable count; field 1 is the one-minute average, which lags by about a
# minute and cannot follow arms this short.
mean_runnable() { awk '{n++; s += $2} END {if (n == 0) print 0; else printf "%d", s / n}' "$1"; }

spendable() {
  curl -s -m 5 "http://127.0.0.1:${GATEWAY_BEE_PORT}/chequebook/balance" 2>/dev/null |
    grep -o '"availableBalance":"[0-9]*"' | grep -o '[0-9]*'
}

random_identifier() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

read_one() {
  curl -s -o /dev/null -m 30 -w '%{http_code} %{time_total}' \
    "http://127.0.0.1:${GATEWAY_BEE_PORT}/soc/$1"
}

# One reader's whole arm: alternating miss, hit, miss, hit.
#
# ⭐ Alternating INSIDE the arm rather than running the two conditions as separate arms. Concurrency is
# the variable, and a hit block at 128 followed by a miss block at 128 could differ because the box
# moved between them. Alternating makes both conditions share whatever the box was doing.
#
# ⚠️ 50/50 is a controlled model, not the live-edge mix. A viewer at the edge misses about 45% of the
# time, so the report weights these rather than quoting the raw ratio as a walk rate.
one_reader() {
  local arm="$1" mode="$2" reader="$3" out="$4"
  local i target out_line code secs ms slot
  for i in $(seq 1 "${READS_PER_READER}"); do
    # Every reader asks for the same slot at the same iteration in `same`, and for its own offset in
    # `spread`. The readers stay roughly in step because each iteration costs them about the same.
    if [ "${mode}" = same ]; then
      slot=$(((i - 1) % HIT_COUNT + 1))
    else
      slot=$((((i - 1) + (reader * 7)) % HIT_COUNT + 1))
    fi
    target="$(sed -n "${slot}p" "${HITS_FILE}")"
    out_line="$(read_one "${target}")"
    read -r code secs <<<"${out_line}"
    ms="$(awk -v s="${secs}" 'BEGIN{printf "%d", s*1000}')"
    printf '%s\t%s\thit\t%s\t%s\n' "${arm}" "${mode}" "${code}" "${ms}" >>"${out}"

    out_line="$(read_one "${OWNER}/$(random_identifier)")"
    read -r code secs <<<"${out_line}"
    ms="$(awk -v s="${secs}" 'BEGIN{printf "%d", s*1000}')"
    printf '%s\t%s\tmiss\t%s\t%s\n' "${arm}" "${mode}" "${code}" "${ms}" >>"${out}"
  done
}

run_arm() {
  local arm="$1" viewers="$2" mode="$3"
  local flag="${OUT_DIR}/.sampling.${arm}" loads="${OUT_DIR}/load.${arm}.txt"
  local r pids=() before after started elapsed

  settle_host
  # ⛔ Median of three rather than one instantaneous read. The proving pass read 52 runnable on a box
  # whose settled baseline is 21, so a single sample would stop the sitting on noise and report a
  # ceiling that was never reached. The existing retrieval probe learned the same thing: two reads
  # seconds apart on an idle box gave 47 and 30.
  local runnable
  runnable="$(baseline_runnable)"
  if [ "${runnable}" -gt "${LOAD_CEILING}" ]; then
    say "⛔ stopping before arm ${arm}: ${runnable} runnable is over the ${LOAD_CEILING} ceiling, and the box has neighbours"
    return 1
  fi

  : >"${loads}"
  touch "${flag}"
  sample_host_load "${loads}" "${flag}" &
  local sampler=$!

  before="$(spendable)"
  started="$(date +%s)"
  for r in $(seq 1 "${viewers}"); do
    one_reader "${arm}" "${mode}" "${r}" "${OUT_DIR}/.reader.${arm}.${r}.tsv" &
    pids+=($!)
  done
  wait "${pids[@]}"
  elapsed=$(($(date +%s) - started))
  after="$(spendable)"

  rm -f "${flag}"
  wait "${sampler}" 2>/dev/null || true

  cat "${OUT_DIR}"/.reader."${arm}".*.tsv >>"${SAMPLES}" 2>/dev/null || true
  rm -f "${OUT_DIR}"/.reader."${arm}".*.tsv

  say "arm ${arm}: ${viewers} readers ${mode}, ${READS_PER_READER} hit+miss pairs each, ${elapsed}s, spent $((before - after)) wei"
  say "  runnable mean $(mean_runnable "${loads}"), peak $(awk '{if ($2>m) m=$2} END {print m+0}' "${loads}")"

  # An idle block of the same shape after every measured arm, so a spend is attributed rather than
  # inferred: the node settles in the background whether or not anything asked it for a chunk.
  before="$(spendable)"
  sleep "${IDLE_BLOCK_S}"
  after="$(spendable)"
  say "  idle ${IDLE_BLOCK_S}s control: spent $((before - after)) wei with nothing asked of it"
}

summarise() {
  awk -F'\t' '
    NR == 1 { next }
    { key = $1 "\t" $3; n[key]++; v[key "\t" n[key]] = $5 }
    END {
      for (k in n) {
        c = n[k]
        for (i = 1; i <= c; i++) a[i] = v[k "\t" i]
        for (i = 2; i <= c; i++) { x = a[i]; j = i - 1; while (j > 0 && a[j] > x) { a[j+1] = a[j]; j-- } a[j+1] = x }
        split(k, p, "\t")
        printf "%-14s %-5s n=%-6d median %6dms  p90 %6dms  max %6dms\n", p[1], p[2], c, a[int(c/2)+1], a[int(c*0.9)+1], a[c]
      }
    }' "${SAMPLES}" | sort
}

say "=== feed reads under concurrency: ${ARM_PLAN} ==="
say "owner ${OWNER}, ${HIT_COUNT} known-good identifiers, ${READS_PER_READER} hit+miss pairs per reader"
say "baseline ${BASELINE_RUNNABLE} runnable, ceiling ${LOAD_CEILING}"
[ -s "${SAMPLES}" ] || printf 'arm\tmode\tkind\tcode\tms\n' >"${SAMPLES}"

INDEX=0
for spec in ${ARM_PLAN}; do
  INDEX=$((INDEX + 1))
  VIEWERS="${spec%%:*}"
  MODE="${spec##*:}"
  run_arm "$(printf 'a%02d-%s-%s' "${INDEX}" "${VIEWERS}" "${MODE}")" "${VIEWERS}" "${MODE}" || break
done

say "=== result ==="
summarise | tee -a "${LOG}"
say "=== done ==="
