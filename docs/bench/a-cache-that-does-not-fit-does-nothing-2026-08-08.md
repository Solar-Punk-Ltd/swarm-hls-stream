# A cache that does not fit does nothing at all

**2026-08-08, 14:41 to 15:14 UTC.** Twelve arms on an unfunded gateway, sweeping `--cache-capacity`
against a fixed working set, cache-off arms interleaved so every cache arm starts cold. Two rounds.
**Cost: nothing.** The chequebook was byte-identical before and after.

Every cache figure this project had published came from a working set that always fit: 100 references
fetched twice inside a minute, a few megabytes against a capacity of a million chunks. **Nothing had
measured what happens when it does not fit**, which is the only regime a real event runs in.

⭐ The cheap way to ask is to shrink the capacity rather than grow the working set. The ratio is what
matters, and one is free to vary.

## ⭐⭐ The answer, and it is a cliff rather than a slope

The working set is **10,489 chunks**, read off the node's own retrieval counter rather than estimated:
400 references, 26.2 chunks each, 37 MB.

| capacity | share of the working set | **retrieval operations** | vs cache off | pass 2 median |
| ---: | ---: | ---: | ---: | ---: |
| 0 (off) | — | 20,978 / 20,978 | | 107-120ms |
| 1,000 | **9.5%** | 20,953 / 20,953 | **0.1%** | 126 / 104ms |
| 4,800 | **45.8%** | 20,978 / 20,953 | **0.1%** | 112 / 111ms |
| **20,000** | **191%** | **11,240 / 11,253** | **46.4%** | **3 / 3ms** |

⛔⛔ **A cache holding 46% of the working set removes 0.1% of the retrievals. Not 46%. Not 20%.
Nothing.** Both rounds, on both the counter and the median.

⭐ **At 191% it removes 46.4% of all retrievals**, which is every retrieval the second pass would have
made: pass 2 goes from ~10,489 operations to ~750, a **93% reduction**, and its median from ~110ms to
**3ms**. The whole arm finishes in 84-93s against 129-163s for every other arm.

## ⭐ Why it is a cliff, and what it says about the eviction policy

The probe walks the same references in the same order, over and over. **A cyclic scan larger than the
cache is the worst case for least-recently-used eviction**: by the time the walk comes back to the
first reference, it is the least recently used thing there is, so it has just been thrown away to make
room for the reference the walk is on now. Every hit misses by exactly one lap.

⭐ **So the shape identifies the policy.** Random eviction at 46% capacity would give roughly a 46% hit
rate. What was measured is **0.1%**. That is LRU, or something that behaves like it.

⚠️ **The region between 46% and 191% was not measured**, so where the cliff sits inside it is unknown.
What is known is that 46% is on the useless side and 191% is on the useful one.

## ⭐⭐ What this means for sizing, and the two cases are wildly different

**A live broadcast is not a cyclic scan.** Viewers fetch the newest segments and never come back for
them, so the set that matters is the **live window**: the span of segments that concurrent viewers
might want at the same time.

| | working set to hold | at 26.2 chunks per 267ms segment |
| --- | --- | ---: |
| **live edge**, viewers scattered over ~10s | the live window | **~980 chunks, ~3.5 MB** |
| **live edge**, scattered over ~60s | the live window | ~5,900 chunks, ~21 MB |
| **DVR or VOD**, a re-watchable hour | the whole span | **~353,000 chunks, ~1.26 GB** |

⭐ **For live, the requirement is trivial and any non-zero capacity worth setting will clear it.** The
hot set is seconds of video, not hours.

⛔ **For DVR, VOD, or any audience that scrubs, the requirement is the whole re-watchable span**, and
under-sizing it does not buy a partial win. It buys nothing, while still costing the disk.

⚠️ **`--cache-capacity` is in chunks, not bytes.** At the ~3.6 KB per chunk measured here, a gigabyte
is roughly 280,000. Sizing it as if it were megabytes is off by three orders of magnitude in the
direction that silently does nothing.

## ⚠️ What this does not show

⚠️ **A cyclic scan is the worst case, deliberately.** A real DVR audience re-reads recent segments more
often than old ones, which LRU is built for, so real hit rates at under-sized capacities will be
better than 0.1%. **How much better is not measured**, and the safe assumption for sizing is that a
cache smaller than the hot set is worth nothing.

⚠️ **The late-segment shares in this sitting do not tell a clean story** and are not quoted above. They
range 2.0% to 16.0% across arms with no relation to capacity, which is the ordinary spread an unfunded
node shows on identical work. The retrieval counter and the pass-2 median both moved by 40x and 93%,
in both rounds, and those are what carry.

⚠️ **One viewer, flat out.** Caching across time is the axis here, and pooling across viewers is a
separate mechanism measured elsewhere. The two were shown to compose.

⚠️ Unfunded gateway, 400 references, one host, two rounds.

## Artifacts

`/home/solarpunk/retrieval-probe/evict1/`. Probe: `deploy/scripts/retrieval-debt-probe.sh`, capacity is
the 4th arm field. Cache-off arms were interleaved between every cache arm so a warm store could not
carry into the next one, and the pass-1 medians confirm it worked: 97-117ms in every arm including the
one that then hit 3ms on pass 2. Gateway restored to `--swap-enable=true` and `--cache-capacity=0` and
confirmed on the node.
