# The cache cliff belongs to the access pattern, not to the cache

**2026-08-09, 01:30 to 02:16 UTC.** Eighteen arms on an unfunded gateway, three access patterns over an
identical working set, interleaved inside one sitting. **Cost: nothing.** `availableBalance` was
byte-identical before and after.

[The cliff sitting](the-cache-cliff-is-at-one-hundred-percent-2026-08-08.md) found a cache holding 76% of
the working set **byte-identical to no cache at all**, and concluded: size at or above the working set,
there is no partial credit. It also said, in its own limitations, that a cyclic scan is the worst case
LRU can be given and that **how much a real re-read pattern beats it was unmeasured**. This measures it.

## The design

Three 800-fetch sequences over the **same 400 references**, so the working set is the same 10,489 chunks
in every arm. **Lap one is byte-identical across all three**, one pass over the pool in order, because a
first lap cannot hit a cache no matter what the pattern is. Only lap two differs:

| pattern    | lap two                                                       |
| ---------- | ------------------------------------------------------------- |
| `cyclic`   | the pool again in order. The worst case, already measured     |
| `recent`   | 80% of draws from the **newest** fifth. The live and DVR shape |
| `oldest`   | 80% of draws from the **oldest** fifth                        |

⛔ **`oldest` is the arm that makes the sitting mean something.** It is the worst possible placement for
LRU, because those are exactly the entries an undersized cache evicted during lap one. Without it,
`recent` beating `cyclic` could be the skew or could be the recency, and the sitting could not say which.

⭐ **Every cache arm is preceded by a cache-off arm on its own pattern**, which flushes the store and
doubles as **that pattern's own no-cache baseline**. Without it, a skewed arm's retrieval count could
differ because its hot references happen to be larger than average rather than because it cached better.
The baselines came out 20,969, 21,025 and 20,978, a spread of 0.3%, so the correction is small and it is
now measured rather than assumed.

## ⭐⭐ The result

Retrieval operations, read off bee's own counter, at **8,000 chunks of capacity, which is 76.3% of the
working set**, the point the cliff sitting proved worthless:

| pattern                        | cache off, r1 / r2 |    cache 8,000, r1 / r2 |  retrievals removed |
| ------------------------------ | -----------------: | ----------------------: | ------------------: |
| **cyclic**                     |  20,978 / 20,978   |   **20,978 / 20,978**   |     **0.0 / 0.0%**  |
| **recent**                     |  20,969 / 20,969   |   **13,250 / 13,260**   |   **36.8 / 36.8%**  |
| **oldest**                     |  21,025 / 21,033   |   **14,463 / 14,497**   |   **31.2 / 31.1%**  |
| cyclic at 10,500 (100.1%), ref |  20,978 / 20,978   |       11,252 / 11,207   |       46.4 / 46.6%  |

⭐⭐ **The same capacity that removes nothing under a cyclic scan removes 37% of retrievals under a
recency-biased one.** Both rounds agree to within 0.1 percentage points.

⭐ **The last row is the ceiling.** A cache sized at 100.1% of the working set removes 46.5%, because lap
one must miss and lap one is half the fetches. **So a cache at 76% of the working set collects 79% of
everything a cache can possibly collect here**, and the cliff sitting's own anchor reproduced exactly:
20,978 for cache-off and for 76% cyclic alike, in both rounds.

### ⭐⭐ And the second lap is as fast as a fully sized cache

| arm                        | lap 1 median, r1 / r2 | lap 2 median, r1 / r2 |
| -------------------------- | --------------------: | --------------------: |
| cache off (all four arms)  |          94 to 117ms  |         101 to 117ms  |
| **cyclic at 76%**          |          109 / 109ms  |     **104 / 115ms**   |
| **recent at 76%**          |           90 / 103ms  |         **4 / 3ms**   |
| **oldest at 76%**          |          119 / 97ms   |         **4 / 4ms**   |
| cyclic at 100.1%           |          121 / 112ms  |           3 / 4ms     |

⭐⭐ **An undersized cache under a skewed pattern serves the median second-lap fetch in 3 to 4ms, which
is what a correctly sized cache does.** The median lap-two fetch is a hot one, so the hot set is being
served entirely from cache and the retrievals that remain are the cold tail that was always going to miss.

⭐ **Lap one runs at 90 to 121ms in every arm including the ones that then hit 4ms**, which is the
contamination check: no cache arm inherited a warm store from the arm before it.

## ⭐⭐ What this actually changes: size for the hot set, not the working set

⛔ **The published rule was "size at or above the working set, there is no partial credit". That is true
of a cyclic scan and false of everything else.**

The reason the two sittings disagree is that **a cyclic scan has no hot set**. Every reference is equally
popular, so its hot set _is_ its working set, and "size for the working set" falls out of that as a
special case. Under any skew the two come apart:

- the **hot set** here is 80 references, **2,096 chunks, 20% of the working set**
- the capacity that worked, 8,000 chunks, is **3.8x the hot set** and only **0.76x the working set**

⭐⭐ **What has to fit is the hot set.** For a live event the working set is the live window and it is
tiny either way. **For DVR or VOD it is the difference between provisioning for a whole re-watchable hour
and provisioning for the part of it people actually re-watch.**

⚠️ **`oldest` getting 31% is the load-bearing part of that claim.** The skew was placed where LRU is
worst, on entries the cache had already evicted, and it still collected two thirds of what `recent`
collected and the same 4ms median. **So the mechanism is that a skew exists, not that it points at recent
content.** LRU re-warms a hot set on its first re-touch and then holds it, as long as the hot set fits.

## ⚠️ What this does not show

⚠️ **It does not locate the new cliff.** One capacity was tested. 8,000 chunks is 3.8x the hot set and it
buys nearly everything, and the theory puts the cliff at the hot set rather than the working set, but
**nothing between 2,096 and 8,000 was run.** ⬅ Open, and cheap if it matters.

⚠️ **80/20 is a chosen shape, not a measured one.** No real audience's popularity distribution has been
observed here. The finding is that skew converts a step into partial credit, not that 37% is the number a
real deployment gets.

⚠️ **The late share carries no weight and is not quoted above.** It ran 0.6% to 12.9% with no consistent
relation to the arm, which is the tenfold spread an unfunded node produces run to run. **Retrieval
operations and lap-two medians moved consistently in both rounds, and those are the claim.**

⚠️ **The cyclic result is not overturned.** It is exactly reproduced, and it remains the right assumption
for an audience that reads a catalogue uniformly, which a seek-everywhere VOD workload can resemble.

⚠️ One viewer, flat out, unfunded gateway, one host, two rounds. The host was quiet throughout.

## Artifacts

`/home/solarpunk/retrieval-probe/PATTERN1/`. Probe:
[`deploy/scripts/retrieval-debt-probe.sh`](../../deploy/scripts/retrieval-debt-probe.sh), the pattern is
the 9th arm field. Sequences:
[`deploy/scripts/make-access-pattern-refs.sh`](../../deploy/scripts/make-access-pattern-refs.sh), seeded
so they rebuild exactly. Retrieval operations are the delta on bee's own `req` counter.

Gateway restored to `--swap-enable=true` and `--cache-capacity=0` and confirmed on the node.
