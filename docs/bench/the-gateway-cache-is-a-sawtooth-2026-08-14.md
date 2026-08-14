# `--cache-capacity=0` is not "off", it is a thrash loop, 2026-08-14

**Free, no broadcast, no BZZ.** Read off the two running nodes and bee's own source.

The whole-surface metrics diff added in PR #193 found `bee_localstore_cache_size` **negative on the
gateway in all eight arms** of the same sitting that introduced it. Chasing it down says the counter is
bee's, the pathological corner it sits in is ours, and the setting this repository has used since the
beginning is the worst of the three available.

## What was actually asked, and the short answers

| | |
| --- | --- |
| Did any published result of ours read this counter? | **No.** Nothing to withdraw. |
| Is the negative a bee bug? | **Yes**, and one bee has already been round once. |
| Why does it happen on our gateway and not our uploader? | **`--cache-capacity=0`.** |

## No result of ours read it

`bee_localstore_cache_size` appears exactly once in this repository, in the sitting that found it.
The four cache-sizing documents score on `bee_retrieval_*` request counts and the pass-2 median,
both differenced across two rounds:

- `a-cache-that-does-not-fit-does-nothing-2026-08-08.md`
- `the-cache-cliff-is-at-one-hundred-percent-2026-08-08.md`
- `the-cache-cliff-belongs-to-the-access-pattern-2026-08-09.md`
- `the-cache-has-no-cliff-under-skew-2026-08-09.md`

None of them reads the cache-size gauge, and no driver does either. **The cache-sizing curve does not
move because of this.**

## The natural control, which is as clean as this project gets

Both bee containers are version **2.8.1**, on one host, started within 40 milliseconds of each other on
2026-08-11. The only relevant difference between them is one flag.

| | uploader | gateway |
| --- | --- | --- |
| cache flags | **none set**, so bee's default 1,000,000 | **`--cache-capacity=0 --cache-retrieval=true`** |
| `bee_localstore_cache_size` | **+2,962** | **-1,844** |
| cachestore `Put` | 432 | 4,638,790 |
| cachestore `Get` | 3,138 | 5,204,045 |
| cachestore `RemoveOldest` | **never called** | **2,989 times** |
| localstore on disk | 173 MB | 307 MB |

⚠️ **It is not a controlled experiment.** The two nodes also do entirely different work, and the
gateway's cache traffic is three orders of magnitude larger. The flag is the leading difference, not the
only one.

## What bee does with a capacity of zero, read from source

Four facts from `pkg/storer`, all of them in the version the nodes run:

**1. The cache write path never looks at capacity.** `Cache.Putter` checks only whether the chunk is
already present, then writes the entry, writes the order index and does `size.Add(1)`. There is no
capacity test anywhere in it. **A capacity of zero does not stop anything entering the cache**, which is
the source-level confirmation of what a two-pass timing test proved from outside on 2026-08-10.

**2. Any single cached chunk is over capacity.** `triggerCacheEviction` fires the over-capacity event
when `size > capc`, which at capacity zero is `size > 0`.

**3. Every eviction round asks for at least ten thousand chunks.**

```go
evict := max(uint64(size-capc), db.reserveOptions.cacheMinEvictCount)
```

`cacheMinEvictCount = 10_000` in `pkg/node/node.go`, hard-coded, with no flag to change it. So a
gateway one chunk over a capacity of zero is asked to evict ten thousand.

**4. A negative size switches eviction off entirely.** The worker's guard is `if size <= capc { continue }`.
At capacity zero that is `size <= 0`, so while the counter is negative **no eviction runs at all** until
ordinary caching drags it back above zero.

Points 2 to 4 are a sawtooth by construction. The cache fills, crosses zero, is asked to drop ten
thousand, undershoots into negative, stops evicting, fills again.

### The underflow is bee's, and bee's fix for it only made it visible

`fix: prevent cache size underflow (#4986)`, first released in **v2.5.0**, changes `Cache.Size()` from
`uint64` to `int64`. That is the whole fix. Before it a drifted-negative size was cast to `uint64` and
read as roughly 1.8e19, which is permanently over any capacity and evicted forever. After it the same
drift is reported honestly as a negative, which is permanently *under* any capacity and never evicts.

**The commit renamed the symptom. The counter can still go below zero, and our v2.8.1 node is
demonstrating it.**

⚠️ **The drift mechanism itself is a hypothesis, not a reading.** The window that fits is between
`RemoveOldest` collecting its victims and taking their per-address locks: it captures each entry's
access timestamp during an unlocked iteration, and `Getter` rewrites exactly that timestamp under the
lock on any cache hit. An eviction whose victim was read in that window deletes a stale order-index row
and leaves a live one orphaned, and a later round can decrement for the same chunk twice. That fits
5.2 million gets racing 2,989 eviction rounds. It is not proven, and the exact v2.8.1 tree was not read.

## The arithmetic says most rounds find far less than they ask for

2,989 rounds at a floor of 10,000 is 29.9 million requested deletions, against 4.64 million cache Puts
in the node's whole life. Deletions cannot exceed insertions, so **the average round actually removes at
most about 1,550** and exits having exhausted the index. That is consistent with the sawtooth and it is
the reason the counter wanders in the low thousands rather than in multiples of ten thousand.

## ⭐⭐ What this resolves: two earlier observations that pointed opposite ways

Both are about the same capacity-zero gateway and they have looked contradictory since 2026-08-10.

| observation | what it said |
| --- | --- |
| 2026-08-10, 500 references walked twice back to back | pass 2 cost **4ms against 121ms**, so the cache was plainly on |
| 2026-08-08, cyclic scan of a 10,489 chunk working set | the capacity-0 arm removed **0.0%** of retrievals, so the cache was plainly doing nothing |

**The sawtooth explains both without either being wrong.** A tight immediate repeat of 500 references
fits inside one tooth and is served from cache. A 10,489 chunk cyclic walk outlives several eviction
rounds, each clearing what the walk will return to, so it collects nothing. The state a measurement
lands in is decided by how long it takes relative to the eviction cycle, and **nothing in this project
has ever recorded which one it got**.

## ⛔ The statement to carry forward

**The gateway's cache is neither on nor off. It is a sawtooth whose phase nothing records.** For
measurement that is worse than either steady state, because it is uncontrolled rather than merely
wrong, and a result's exposure to it scales with how long the result takes to gather.

⚠️ **This is not a reason to doubt the 2026-08-14 in-tab result.** Its headline is
`bee_retrieval_request_count`, which counts what the gateway was asked for and is unaffected by whether
the answer came from cache. The three gateway arms landed within 0.9% of each other, so the sawtooth
was not adding visible variance across an hour either.

## What was deliberately not done

⛔ **The gateway was not restarted.** A restart re-initialises the counter from a real row count and
would confirm the drift is in-memory rather than on disk, but it costs about thirteen minutes of chain
sync and both gateways are held up on purpose. The confirmation is not worth the peer set.

⛔ **The capacity was not changed.** Moving off zero is a real decision with a real cost and it belongs
to the owner, not to this document. It would restart the gateway, and it would break comparability with
every sitting this project has run, all of which were gathered at capacity zero.

## The recommendation, for the owner to accept or refuse

**Set `BEE_GATEWAY_CACHE_CAPACITY` to a deliberate number and stop using zero.** Zero is the only value
that guarantees the thrash loop, because it is the only value where every cached chunk is over capacity.
Any capacity above `cacheMinEvictCount` puts the node in the regime the eviction code was written for.

The two honest options, and neither is free:

| | what it gives | what it costs |
| --- | --- | --- |
| `--cache-retrieval=false` | a genuinely cold gateway, which is what "cache off" was always meant to mean | one restart, and every prior sitting stays non-comparable |
| capacity well above 10,000 | a steady warm cache with working eviction | one restart, and results become optimistic against a cold viewer |

⭐ Until one is chosen, the reading to keep is that **the capacity-zero gateway is the pessimistic case
for a repeat read and the optimistic case for a tight one**, and no published figure of ours depends on
which.
