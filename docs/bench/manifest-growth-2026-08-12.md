# A viewer keeps the whole broadcast, and #155 doubled how fast that pile grows

**2026-08-12, free.** Pure CPU on this laptop, no network, no bee, no browser, no postage. Three runs
of a synthetic fill against the real `ManifestStateManager`, n=6 per point.

`ManifestStateManager` appends every segment a viewer has seen and never trims. Grepping the module
for `splice`, `shift`, `trim`, `prune` or `evict` finds nothing, and its one `slice` is over an
incoming playlist rather than over the accumulated `state.segments`. `serialize` rebuilds the entire
manifest string whenever the state is dirty, and a poll that finds a new segment sets dirty, so a
viewer at the live edge pays the rebuild on nearly every poll.

This morning #155 shipped `HLS_FRAGMENT 0.5`, so the profile we recommend produces 0.5s segments
where it used to produce 1.0s ones. That halves nothing on this side. It **doubles the segment count
a broadcast of any given length produces**, and the rebuild is priced by the count.

## The control, run first

A rebuild is only paid when the state is dirty. If that were wrong, every number below would be
measuring the wrong path.

| at 72,000 segments | per call |
| --- | ---: |
| poll that found a new segment | **10.97 / 12.24 / 12.27 ms** |
| poll that found nothing new | **0.0021 / 0.0019 / 0.0017 ms** |

Five thousandfold apart across three runs, so the timed path is the rebuild and the cached path is
genuinely free.

## What one rebuild costs

| segments held | median ms | min | max | manifest | broadcast at 0.5s | at 1.0s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,200 | 0.17 | 0.11 | 0.23 | 129 KB | 10 min | 20 min |
| 3,600 | 0.31 | 0.27 | 0.37 | 387 KB | 30 min | 1 h |
| 7,200 | **0.76** | 0.61 | 2.17 | 774 KB | **1 h** | 2 h |
| 14,400 | 1.91 | 1.24 | 4.06 | 1.5 MB | 2 h | 4 h |
| 28,800 | 3.72 | 3.18 | 5.84 | 3.0 MB | 4 h | 8 h |
| 72,000 | **13.90** | 10.48 | 18.58 | **7.6 MB** | **10 h** | 20 h |

**Roughly linear, with a superlinear tail.** Doubling the count multiplies the cost by 1.95 to 2.50
through the middle of the range, then 2.5x the count costs 3.74x at the top, which is what allocating
an ever larger string looks like.

⭐ **The two arms are a control, not a variable.** Each point was measured at both 0.5s and 1.0s
segments, and the manifests are byte-identical at equal count (129 / 387 / 774 / 1547 / 3094 /
7734 KB in both). The cost depends on how many segments are held and not on how long each one is, so
the arms' spread is this probe's noise floor rather than a result. That is where the 0.61 to 2.17 ms
range at 7,200 comes from: whichever arm ran second inherited a heap already holding the first arm's
7.6 MB.

## What #155 changed, at equal wall clock

| broadcast | at 1.0s segments | at 0.5s segments | |
| --- | ---: | ---: | ---: |
| 1 hour | 3,600 held, 0.31 ms, 387 KB | **7,200 held, 0.76 ms, 774 KB** | 2.5x the cost |
| 4 hours | 14,400 held, 1.91 ms, 1.5 MB | **28,800 held, 3.72 ms, 3.0 MB** | 1.9x |

⛔ **My own prediction was half wrong and it is worth writing down why.** I registered that #155 would
cost about fourfold: twice the work per rebuild and twice as many rebuilds. The first half holds. The
second does not follow from anything measured here, because **the number of rebuilds is set by the
poll cadence, not by the segment rate** — a poll that finds three new segments rebuilds once, exactly
as a poll that finds one does. Whether the poll cadence itself tracks the segment length is a
separate question this probe cannot see. Until it is measured, the honest figure is **2x per rebuild,
and the total per broadcast is unmeasured.**

## ⛔ Three things this is not

**It is not the whole per-poll cost.** hls.js re-parses the entire playlist on every refresh:
`handleTrackOrLevelPlaylist` is the single handler for every playlist load and calls
`M3U8Parser.parseLevelPlaylist(response.data, ...)` on the whole string, with no incremental path
(`dist/hls.js:36331`, version 1.6.15). Our rebuild is a **floor** on what a poll costs, not the total.
hls.js does not export its parser, so the size of that second half is unmeasured rather than small.

**It is not a viewer's device.** These are Apple Silicon numbers from a laptop running nothing else.
A phone is several times slower and this work is on the main thread.

**It is mostly projection.** The longest run this project has ever done is ten minutes, which is the
1,200 row: **0.17 ms, and entirely uninteresting.** Every row below it is a synthetic fill standing in
for a broadcast nobody has run. That is the finding as much as the numbers are.

## Why trimming is not the free fix it looks like

`normalizeHeaders` pins every playlist this client serves to media sequence zero, so segment N means
the Nth since this viewer joined. Dropping the front of the list changes what every number already
handed to hls.js refers to, which is what it reports as a media sequence mismatch, and the client
answers a fatal parsing error by remounting the player, and a remounted player starts at the
beginning. That is the failure the uploader's own
`ending a broadcast that live viewers are still following` suite was written against.

So a fix has to keep the sequence stable while bounding the list, which is a real change rather than
a two-line trim, and it should not be made on reading alone.

## Where this leaves it

A one-hour broadcast costs a viewer **0.76 ms per poll and 774 KB of retained string**, which is
nothing. Four hours is 3.72 ms and 3.0 MB, which is still not much on a laptop and unmeasured on a
phone. The shape only becomes uncomfortable at broadcast lengths this project has never run and has
no evidence anyone wants.

**Nothing here justifies changing the shipped configuration.** It justifies knowing the number before
someone runs a ten-hour stream, and it puts a guard under the growth so it stays a known cost:
`packages/client/test/manifestGrowth.test.ts`.
