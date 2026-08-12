# Two hours continuous, and nothing degrades

**2026-08-12 night, funded, 1.5501 BZZ uploader and 1.2633 gateway, 14 postage buckets.** Task #89.
One unbroken 720p broadcast at the shipping profile (2500 kbps, 0.5s GOP), 7,115 seconds, watched in
a real browser throughout, with **both bee nodes sampled every 120 seconds: 60 readings**.

⭐⭐⭐ **The longest run this project had ever done before tonight was ten minutes.** Every statement
about a longer broadcast was a projection from a synthetic fill. This is twelve times that, and it is
the first time the nodes' own account of a run has been recorded alongside the viewer's.

## The result: flat

Four independent 30-minute windows, each differenced from its own pair of snapshots.

| window | push-sync | push errors | retrieval | peers asked | retrieval failures | uploader | gateway |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0-30 min | 11.8 ms | 5.6% | 25.4 ms | 1.59 | 4.9% | 0.80 BZZ/hr | 0.61 |
| 30-60 min | 11.2 ms | 3.9% | 27.5 ms | 1.60 | 4.8% | 0.75 | 0.65 |
| 60-90 min | 11.2 ms | 6.2% | 27.2 ms | 1.62 | 4.9% | 0.79 | 0.64 |
| 90-120 min | 11.9 ms | 4.8% | 29.0 ms | 1.66 | 5.0% | 0.80 | 0.67 |

**Nothing that matters moves.** Push-sync time is flat to a rounding error. The retrieval failure rate
is flat to a tenth of a point. Cost per hour is flat on both nodes.

⚠️ **Two things drift slightly and neither is alarming**: mean retrieval time rises 25.4 to 29.0 ms
(+14% across two hours) and peers asked per request rises 1.59 to 1.66 (+4%). They are consistent
with each other, since asking more peers takes longer. Whether that continues or plateaus is what the
four-hour run is for.

## Over the whole soak

| | |
| --- | ---: |
| chunks push-synced | **789,015** at 11.5 ms mean |
| push errors, retried | 40,737, 5.2% of pushes |
| unsynced backlog | **0 → 0** |
| invalid stamps | **0** |
| retrieval requests | **666,461** at 27.3 ms mean |
| retrievals failed outright | 32,749, 4.9% |
| invalid chunks retrieved | **0** |
| `segmentsSkipped` | **0 → 0** |
| `segmentsNeverNamed` | **0 → 0** |
| `maxConsecutiveSegmentFailures` | **0 → 0** |
| postage | 215 → 229 of 512 buckets, 7.1 per broadcast hour |

⭐ **The uploader dropped nothing across two hours and 789,015 chunks.** `segmentsSkipped`,
`segmentsNeverNamed` and `maxConsecutiveSegmentFailures` all held at zero, and the unsynced backlog
never left zero, so the write path kept up with a live encoder for the whole run without queueing.

## ⭐⭐⭐ What this changes about cost, which is the finding with the widest reach

**0.78 BZZ per broadcast hour on the uploader, 0.64 on the gateway**, and flat.

The arm sitting three hours earlier the same night, on the same box, cost **2.06 BZZ per broadcast
hour** idle-to-idle. It started eight broadcasts in 56 minutes where this started one in 119.
Subtracting the marginal rate leaves about **1.19 BZZ across 8 starts, so roughly 0.15 BZZ per
broadcast started**, independent of how long it runs.

⚠️ **That per-broadcast figure is a fit across two sittings, not a measurement.** The arm sitting's
window also contains four failed launches and an alternating GOP. What would test it is two sittings
of equal total broadcast time and different arm counts.

⛔ **The operational consequence is large either way.** A sweep of short arms is dominated by setup
and a soak is dominated by minutes, so a single BZZ-per-minute constant misprices both. Ten BZZ buys
roughly **twelve hours of continuous broadcast** or roughly **sixty seven-minute arms**.

## What this sitting does not answer

- ⛔ **The four-hour figure itself.** This is two hours. The 14% retrieval drift has not been given
  long enough to show whether it plateaus.
- ⛔ **The viewer-side half is not in this document.** `#EXT-X-TARGETDURATION`, the stall count, the
  latency and the advance ratio come from the browser report in the same run directory and are read
  separately; nothing here should be quoted as a viewer's experience.
- **n=1.** One sitting, one box, one gateway, one browser. The four windows replicate the rate within
  the sitting, which is not the same as replicating the sitting.
- ⚠️ **Host load ran 7 to 11 of 48 cores** and roughly four of those were ours. A quiet night on a
  shared box, and the interleaving that usually defends against neighbours does not exist in a soak.

## Ledger

| | |
| --- | ---: |
| broadcast | 118.6 min |
| uploader | **1.5501 BZZ** |
| gateway | **1.2633 BZZ** |
| postage | 14 buckets |
| node-metric samples | **60** |
| arms lost | none, it ran to its own end with no floor crossed |
