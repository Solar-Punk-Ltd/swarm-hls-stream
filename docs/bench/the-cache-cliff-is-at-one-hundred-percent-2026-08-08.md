# The cache cliff is at exactly one hundred percent, and there is no partial credit

**2026-08-08, 16:03 to 17:06 UTC.** Twenty-four arms on an unfunded gateway, bisecting `--cache-capacity`
between the two points [the eviction sitting](a-cache-that-does-not-fit-does-nothing-2026-08-08.md) had
already established, with a cache-off arm before every cache arm. Two rounds. **Cost: nothing.** The
chequebook was byte-identical before and after.

That sitting measured 46% of the working set removing 0.1% of retrievals and 191% removing 46.4%, and
said plainly that **the whole region between them was unmeasured**. This closes it.

## ⭐⭐ The answer, and it is a step function

The working set is **10,489 chunks**, unchanged: 400 references at 26.2 chunks each.

| capacity | share of the working set | **retrieval operations** | pass 2 median |
| ---: | ---: | ---: | ---: |
| 0, off | | 20,978 / 20,978 | 119 / 106ms |
| 4,800 | 45.8% | 20,978 / 20,978 | 100 / 117ms |
| **8,000** | **76.3%** | **20,978 / 20,978** | **114 / 111ms** |
| **10,500** | **100.1%** | **11,224 / 11,248** | **3 / 4ms** |
| 13,000 | 123.9% | 11,247 / 11,240 | 3 / 3ms |
| 16,000 | 152.5% | 11,240 / 11,234 | 4 / 3ms |
| 20,000 | 190.7% | 11,244 / 11,248 | 3 / 3ms |

⛔⛔ **A cache holding 76% of the working set is byte-identical to no cache at all.** 20,978 retrieval
operations, the same figure the cache-off arms produce, in both rounds. Not reduced, not slightly
reduced. Identical.

⭐⭐ **10,500 chunks is eleven chunks above the working set and it buys the entire benefit.** Retrieval
operations fall to 11,224 and the second pass drops from ~110ms to **3ms**.

⭐ **Every capacity at or above the working set is indistinguishable from every other.** 11,224 to
11,248 operations across 100%, 124%, 153% and 191%, in both rounds, a spread of 0.2%. **Over-provisioning
buys nothing on top.**

## ⭐ Why this is the exact signature of LRU under a cyclic scan

The probe walks the same references in the same order forever. For least-recently-used eviction that is
the pathological case, and the pathology is **total rather than proportional**:

- **Below 100%**, the walk returns to each reference exactly one lap after it became the least recently
  used thing in the cache, which is exactly when it was evicted to make room. Every single lookup misses.
  A cache at 76% does not get 76% of the hits, it gets **none**.
- **At or above 100%**, nothing ever needs evicting, so every lookup on the second pass hits.

⭐ **So the hit rate is not a function of capacity at all. It is a function of whether capacity clears
the working set.** The previous sitting inferred LRU from a 0.1% hit rate where random eviction would
have given 46%. This confirms it by finding the discontinuity exactly where the theory puts it.

⭐ The 46.5% figure is the whole of the second pass. Pass one is cold and must miss, so halving the
total is the ceiling, and pass two goes from 10,489 operations to roughly 735, a **93% reduction**.

## ⭐⭐ What it means for sizing, which is now a much sharper rule

⛔ **Size the cache at or above the working set. There is no partial credit and no reason to exceed it.**

The earlier sitting's advice was to treat an undersized cache as worth nothing, offered as the safe
assumption because the shape between the two points was unknown. **It was not merely safe, it was
exact.**

| | what must fit | chunks |
| --- | --- | ---: |
| live, viewers within ~10s | the live window | **~980 (~3.5 MB)** |
| live, viewers within ~60s | the live window | ~5,900 (~21 MB) |
| **DVR or VOD, one re-watchable hour** | the whole span | **~353,000 (~1.26 GB)** |

⚠️ **`--cache-capacity` is in CHUNKS, not bytes.** At ~3.6 KB per chunk a gigabyte is roughly 280,000.
Sizing it as if it were megabytes is wrong by three orders of magnitude, in the direction that silently
does nothing.

⚠️ **The margin that worked here was 0.1%**, which is not a margin to design against. A live working set
is not a fixed number the way this probe's is, so size above the largest working set the deployment can
produce rather than above its typical one.

## ⚠️ What this does not show

⚠️ **A cyclic scan is the worst case, deliberately.** A real audience re-reads recent segments more often
than old ones, which is the access pattern LRU exists for, so real hit rates at undersized capacities
will beat zero. ⬅ **By how much is still unmeasured.** What this sitting removes is the hope that an
undersized cache degrades gracefully under an adversarial pattern. It does not degrade, it stops.

⚠️ **The step was located to between 76% and 100%, not proven to be at 100.0%.** The theory puts it
exactly at the working set, a capacity 0.1% above it behaves perfectly, and one 24% below it behaves
like no cache. Nothing between 8,000 and 10,500 was run.

⚠️ **One viewer, flat out.** Caching across time is the axis here. Pooling across viewers is a separate
mechanism, measured elsewhere, and the two were shown to compose.

⚠️ **A cache does not raise the throughput ceiling.** Cache-off and cache-warm both cap at 43 to 44 MB/s,
so this is a cost and latency lever rather than a capacity one. See
[the ceiling sitting](the-ceiling-is-bytes-not-viewers-2026-08-08.md).

⚠️ Unfunded gateway, 400 references, two passes, one host, two rounds.

## Artifacts

`/home/solarpunk/retrieval-probe/CLIFF3/`. Probe: `deploy/scripts/retrieval-debt-probe.sh`, capacity is
the 4th arm field. Retrieval operations are the delta on bee's own `req` counter across the arm rather
than anything the probe counts for itself.

⭐ **The interleaving worked and the pass-1 medians are the evidence.** Every arm's first pass ran at 95
to 120ms including the four that then hit 3ms on their second, so no cache arm inherited a warm store
from the arm before it. A cache-on arm whose pass 1 came back fast would have meant the sitting was
measuring its own contamination.

Gateway restored to `--swap-enable=true` and `--cache-capacity=0` and confirmed on the node.
