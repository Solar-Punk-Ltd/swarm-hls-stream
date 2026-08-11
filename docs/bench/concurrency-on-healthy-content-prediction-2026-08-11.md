# Pre-registration: what concurrency buys a browser node, on content of known health

**Written 2026-08-11 evening, before the sweep ran.** Free: unfunded in-browser node, references already
published. The point of writing first is that today produced two findings that a post-hoc mechanism
would have fitted comfortably, and both were wrong. See [[swarm-hls-gate-lesson]] AGI and AGU.

## Why this run exists

Every previous concurrency figure for an in-browser node is unusable:

- **c16 at 410-467 KB/s (n=3)** was taken on a node at 4.5% occupancy **and** on the 2026-08-03 corpus,
  which is now known to have been decaying. Its arms spent budget on timeouts, so it is a **floor**.
- **"c32 kills the node"** was retracted by its own replicate.

Today's size sweep re-measured delivery on healthy content at **concurrency 1** and found 40/40 at every
size. That leaves the obvious question unanswered: a player fetches **four** segments at once, not one,
so none of today's absolute figures are a player's.

## The plan

360 references from the shipping-profile broadcast (fragment 1.0, 629 segments, **787 KB** each,
indices 0-628, published 10:59:53Z to 11:19:59Z). Arms **c4 and c16**, 2 rounds, block 90, arms
alternated between rounds. Canaries are abel-1's, so a discarded round means a sick node rather than
content we cannot retrieve.

⛔ **The 252 references reserved for the untouched decay arm are excluded, and the exclusion was
verified rather than assumed: overlap is 0.** Reading them would apply the treatment to the control of
the only experiment that separates ageing from absence of reads.

## The three predictions, which disagree

A 787 KB segment is 197 chunks. The chunk semaphore is `RETRIEVE_CHUNK_CONCURRENCY = 2_048`.

| arm | chunks in flight | occupancy |
| ---: | ---: | ---: |
| c4 | 788 | **38.5%** |
| c16 | 3,152 | **154%, saturated** |

⭐ **c4 lands at almost exactly the occupancy of today's 3.4 MB single-fetch arm (41%), which delivered
1,007 KB/s.** That makes the arms directly comparable across two different ways of filling the same
semaphore, which is the sharpest test available for free.

| model | c4 | c16 |
| --- | ---: | ---: |
| **occupancy sets throughput** | **~1,007 KB/s**, matching the 3.4 MB arm at equal occupancy | at the ceiling, so ~1,000 or a little above |
| **requests are independent** | ~1,340 KB/s (4 x the 335 measured at c1 on 801 KB) | ~5,360 KB/s |
| **the ceiling is already reached at c1** | ~335 KB/s | ~335 KB/s |

## Falsifiers, written down now

- **Occupancy dies** if c4 comes back near 1,340 KB/s, or if c4 and c16 differ by more than about 30%
  while both sit above 41% occupancy.
- **Independence dies** if c16 is not roughly 4x c4.
- **The old 410-467 KB/s floor is confirmed as a floor** if either arm clears it comfortably. If c16
  comes back at 450 again on healthy content, then that figure was never a decay artefact and the
  retraction of its scope was too generous.
- ⛔ **The run is void** if a canary round is discarded, because then the node was sick.

## What this cannot answer

This is a bulk fetch sweep, not playback. It measures what the node can pull, not what a player
experiences, and it has no buffer, so the fill-versus-steady contamination that ruined today's
"461 KB/s" and "1,014 KB/s" cannot arise here. It also says nothing about a **funded** node.
