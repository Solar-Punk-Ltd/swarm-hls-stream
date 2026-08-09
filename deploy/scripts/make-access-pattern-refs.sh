#!/bin/bash
# Builds the reference sequences that let one sitting ask whether the cache cliff is a property of the
# cache or a property of the access pattern.
#
# The cliff sitting found a cache holding 76% of the working set byte-identical to no cache at all, and
# said in its own limitations that a cyclic scan is the worst case LRU can be given: the walk returns to
# each reference exactly one lap after it became the least recently used thing, which is exactly when it
# was evicted. **A real audience re-reads recent segments more often than old ones.** How much that is
# worth was left unmeasured.
#
# ## Why the sequence lives in a file rather than in the probe
#
# The probe walks a reference list in order, so the list IS the access pattern and nothing in the probe
# has to know about distributions. It also makes the three patterns provably comparable: same pool, same
# number of fetches, same working set, and a first lap that is byte-identical across all of them.
#
# ⭐ Every pattern opens with one lap over the whole pool in order. A first lap cannot hit a cache no
# matter what the pattern is, so making it identical means the arms differ ONLY in how they re-read.
#
# ## The three patterns
#
# - `cyclic`  lap two repeats the pool in order. The worst case, and the one already measured.
# - `recent`  lap two draws 80% of its fetches from the newest fifth of the pool. This is the live and
#             DVR shape: an audience clusters on recent segments.
# - `oldest`  lap two draws 80% of its fetches from the OLDEST fifth. Same skew, worst possible
#             placement for LRU, because those are the entries an undersized cache evicted during lap
#             one. ⛔ Without this arm, `recent` beating `cyclic` could be the skew or could be the
#             recency, and the sitting could not say which.
set -u

SRC="${SRC:-/home/solarpunk/phase06/refs.txt}"
OUT_DIR="${OUT_DIR:-/home/solarpunk/phase06}"

# 400 references at 26.2 chunks each is a 10,489 chunk working set, which is the one the cliff was
# located against. Keeping it identical is what makes the 76.3% capacity mean the same thing here.
POOL_SIZE="${POOL_SIZE:-400}"
# One lap of cold fill plus one lap of re-reads, so 800 fetches, matching the cliff sitting's two passes.
DRAWS="${DRAWS:-400}"

HOT_FRAC="${HOT_FRAC:-0.2}"
HOT_SHARE="${HOT_SHARE:-0.8}"
# Fixed so the sequences are reproducible and a later sitting can rebuild them exactly.
SEED="${SEED:-20260809}"

write_pattern() {
  local where="$1" out="${OUT_DIR}/refs-$1.txt"
  awk -v n="${POOL_SIZE}" -v draws="${DRAWS}" -v frac="${HOT_FRAC}" -v share="${HOT_SHARE}" \
    -v seed="${SEED}" -v where="${where}" '
    NR <= n { pool[NR] = $0 }
    END {
      if (NR < n) { print "pool too small: " NR " < " n > "/dev/stderr"; exit 1 }
      srand(seed)
      hot = int(n * frac)
      for (i = 1; i <= n; i++) print pool[i]
      for (d = 1; d <= draws; d++) {
        if (where == "cyclic") { print pool[(d - 1) % n + 1]; continue }
        if (rand() < share) {
          k = int(rand() * hot) + 1
          idx = (where == "recent") ? n - hot + k : k
        } else {
          k = int(rand() * (n - hot)) + 1
          idx = (where == "recent") ? k : hot + k
        }
        print pool[idx]
      }
    }' "${SRC}" >"${out}" || return 1
  printf '%s: %s lines, %s distinct\n' \
    "${out}" "$(wc -l <"${out}")" "$(sort -u "${out}" | wc -l)"
}

for pattern in cyclic recent oldest; do
  write_pattern "${pattern}" || exit 1
done

# ⛔ The check that matters is not the line count, it is that all three cover the SAME references. A
# pattern that missed even one reference would have a smaller working set, and every capacity expressed
# as a share of it would mean something different for that arm.
distinct_cyclic="$(sort -u "${OUT_DIR}/refs-cyclic.txt")"
for pattern in recent oldest; do
  if [ "${distinct_cyclic}" != "$(sort -u "${OUT_DIR}/refs-${pattern}.txt")" ]; then
    printf '⛔ %s does not cover the same references as cyclic, so the working sets differ\n' "${pattern}"
    exit 1
  fi
done
printf '✅ all three patterns cover an identical working set\n'
