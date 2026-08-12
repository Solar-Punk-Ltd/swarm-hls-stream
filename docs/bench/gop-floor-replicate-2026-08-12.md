# The 0.25s GOP 404s are our own publish ordering, and the rate does not replicate

**2026-08-12, funded, 0.9520 BZZ.** Six `bench:longrun` arms, GOP 0.25 against 0.50 at 720p30/2500k,
8 minutes each, round 1 discarded as warm-up and rounds 2 and 3 run in opposite order. Same rig, same
day, same instrument as `gop-floor-2026-08-12.md`, five hours later. All six arms passed the axis
guard.

This sitting was bought to replicate that morning's headline. **It refutes it**, and the follow-up
question that doc named as next is answered in the same minutes.

## 1. The refusal rate does not replicate

| sitting | 0.25s GOP, share unreadable | 0.5s GOP |
| --- | ---: | ---: |
| morning, 3 arms each | **18.3%, 18.6%, 21.4%** | 0.0%, 0.0%, 0.0% |
| this sitting, 3 and 3 | **2.9%, 13.1%, 0.0%** | 0.5%, 0.3%, 0.0% |

The morning's three 0.25 arms agreed to within 3 points. This sitting's three span the whole range
from nothing to 13%. ⛔ **A quantity that lands at 18, 19 and 21 one morning and at 0, 3 and 13 the
same afternoon is not a property of the GOP.**

The 0.5 arms replicate: essentially zero in both sittings.

## 2. Every refusal came back, and fast

`BENCH_UNSERVED_WATCH_MS=60000` timed each refusal off the collection loop, 4 at a time at one ask a
second, so the watcher added at most 4 requests a second to the gateway being measured.

| arm | refusals timed | median | worst | back inside 1s | still refused at 60s | unwatched |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.25, round 1 | 3 | 0.09s | 0.11s | 3 of 3 | **0** | 0 |
| 0.5, round 1 | 2 | 0.12s | 0.14s | 2 of 2 | **0** | 0 |
| 0.5, round 2 | 1 | 0.10s | 0.10s | 1 of 1 | **0** | 0 |
| 0.25, round 2 | 13 | 0.10s | 0.14s | 13 of 13 | **0** | 0 |
| 0.25, round 3 | 0 | | | | | |
| 0.5, round 3 | 0 | | | | | |

✅✅✅ **19 refusals, 19 resolved, none slower than 0.14s, none outstanding, none uncounted.**

The unwatched column matters as much as the others: a distribution over whatever fitted in the
watcher's slots, reported as if it covered everything, is the failure this instrument has made
before. Nothing was dropped.

## 3. The mechanism, which was written down in our own uploader

`StreamUploader.ts` publishes the two halves of a segment differently, on purpose:

| write | flag | line |
| --- | --- | --- |
| the feed slot naming the segment | **`deferred: false`** | `uploadDataAsSoc`, 565 |
| the segment bytes | **`deferred: true`** | `uploadDataToBee`, 579 |

Its own comment on the first:

> Deferred means bee acks the SOC from its own local store and push-syncs it in the background, so
> the publish reports success while the chunk is still only local and a viewer's gateway is told
> about a segment it cannot yet resolve.

That is the argument for making the **manifest** synchronous, which LAT-10 did. The segment below it
is still deferred, so the reference is always fully synced before the bytes necessarily are. A reader
quick enough to reach the live edge asks for bytes that exist only on the uploader, and gets a 404
until push-sync lands, which the table above measures at about **100ms**.

⭐ `check-axis.py` recorded the same thing on 2026-08-05 and it went unread: *"every one of the
thirteen a 10-minute run refused on 2026-08-05 answered 200 when asked again."*

## 4. Why the 0.25 arms see it more, and why the rate is unstable

The reader walks the feed forward each poll, bounded at 32 slots.

| GOP | reader vs publisher | median walk | polls that spent the whole 32-slot budget |
| ---: | --- | ---: | ---: |
| 0.25 | 3.74 to 3.75 against **3.76** slots/s | 16 | **23%, 34%, 23%** |
| 0.5 | 2.00 against 2.00 | 2 | **0%, 0%, 0%** |

At a 0.25s GOP the reader runs at 99.7% of the write rate with no headroom, so it is permanently at
the live edge and permanently racing push-sync. At 0.5 it has slack and never reaches the bound.

⚠️ **Ordering only, n=3.** Across the three 0.25 arms the bound share and the refusal rate move
together (23% → 0.0%, 24% → 2.9%, 34% → 13.1%). That is three points and one sitting. It is offered
as the reason the rate is unstable, not as a fitted relationship, and the 0.5 arms show refusals do
occur at 0% bound.

## 5. ⭐ The latency comparison is not void on the arm that discarded nothing

The morning's doc voided its own latency table because the 0.25 medians were computed after deleting
19% of reads, and the deleted ones are the slowest. That objection is exactly right and does not
apply to the round-3 arm here, **which discarded nothing at all**.

| arm | discarded | capture to fetchable, median | p95 | worst | smallest buffer that would not have stalled |
| --- | ---: | ---: | ---: | ---: | ---: |
| **0.25, round 3** | **0** | **1.01s** | 1.71s | 3.76s | 3.49s |
| 0.25, round 2 | 13 | 0.98s | 1.20s | 3.07s | 2.80s |
| 0.5, round 2 | 1 | 1.55s | 2.16s | 2.62s | 2.12s |
| 0.5, round 3 | 0 | 1.55s | 2.13s | 2.57s | 2.07s |

✅ **On an uncensored arm a 0.25s GOP is about 0.54s faster to fetchable than 0.5.** ⚠️ n=1 for the
uncensored case.

⛔ **And it does not follow that it is better for a viewer.** The tails overlap and run the other way:
worst-case fetchable is 3.07 to 3.76s at 0.25 against 2.57 to 3.69s at 0.5, so **the smallest buffer
that would not have stalled is larger at 0.25 in three of four comparisons**. A viewer is held by the
tail, not the median. See `swarm-hls-size-collapses-at-c4`: this project has already had one
recommendation reverse when the measure moved from a median to what a player actually does.

## What this changes

⛔ **WITHDRAWN**, from `gop-floor-2026-08-12.md`:

> A viewer at the live edge cannot retrieve one segment in five at a 0.25s GOP.

That is the bench discarding a segment it asked for before push-sync finished. A viewer's hls.js
retries a refused fragment, and every refusal here was retrievable within 140ms.

✅ **UNCHANGED: 0.5 remains the operating point**, on evidence that never rested on 404s:

- 2026-08-11, funded: latency 1.55s against 3.88s and confirmed stalls 0-of-3 against 3-of-3 at 2.0.
- #155 ships `HLS_FRAGMENT 0.5`, so `ceil(0.5 / 0.25) * 0.25 = 0.5s`: **a broadcaster asking for a
  0.25s GOP on shipped config gets 0.5s segments.** Reaching sub-0.5 needs a second deliberate change
  no default leads to.

✅ **New and worth its own line:** the 404s a viewer would meet at the live edge are a **~100ms
publish race of ours**, not Swarm failing to return content. That is a different defect with a
different fix, and it is ours to close.

## Scope

- **n=2 counted arms per GOP**, one sitting. The refutation of the morning's 18-21% is strong because
  a single 0.0% arm is enough to break a claimed property. The 1.01s uncensored median is n=1.
- The rig runs `hls_fragment 0.25` / `hls_aof_ratio 10`, which is what makes a 0.25s GOP reachable at
  all. Identical to shipped config at every GOP at or above 0.5, and **not** reachable below it.
- The watcher's 60s budget was never approached. Nothing here bounds how long a refusal *could* last,
  only that none of these did.

## Next

**Close the race rather than measure it again.** The manifest write was made synchronous for exactly
this reason and the segment write was left deferred. Whether the segment can also be synchronous, and
what it costs at the live edge, is a question about our uploader and needs no broadcast to begin.
