# Prediction: does the small GOP that `c4-across-sizes` recommends actually survive a broadcast?

**Written 2026-08-12, before any funded arm ran.** Registered before spending so the answer cannot be
read backwards out of the data.

## Why this costs money when the last three questions did not

`c4-across-sizes-2026-08-12.md` measured segment size by **fetching references that were already on
Swarm**. It found that at the concurrency hls.js uses, throughput is flat across an 8.3x size range
while per-segment latency varies 7.2x, and concluded: prefer small.

Nothing has ever broadcast that way. A live broadcast adds the uploader, the feed, the postage batch
and a live edge, none of which a fetch sweep touches. And there is a specific reason to expect
trouble: `shipping-profile-sustains-2026-08-11.md` records that small segments **underfill the chunk
semaphore that binds**, at 4.5% occupancy for 90 KB segments against 38.5% for 787 KB ones. So the
plausible failure is that small segments win on latency and lose on sustain.

⭐ **And `gop-vs-fragment-2026-08-12.md` is what makes this runnable at all.** It established that the
segment length is `ceil(fragment / GOP) * GOP`, so with the deployment at `hls_fragment 0.25` every
GOP at or above 0.5 binds on its own. **No deployment config change is needed**, which is measured
rather than assumed.

## The arms

Bitrate, size and frame rate are held at the defaults, so **every arm produces the same bytes per
second and costs the same**. Only the segment boundary moves. `bench:longrun` on the host over
loopback, which is the one place the publisher cannot write network variance into the timeline.

| `BENCH_GOP_SECONDS` | expected segment | 2500 kbps plus 128 kbps audio |
| ---: | ---: | ---: |
| **0.5** | ~164 KB | the small end |
| 1.0 | ~328 KB | |
| **2.0** | ~657 KB | **today's default, and the top of the valid range** |

Three rounds, arm order rotated each round, because a caveat is not a replicate.

### ⛔⛔ CORRECTED BEFORE THE SECOND LAUNCH: a 4.0s GOP arm was queued and cannot validly run

The first version of this file listed a fourth arm at **GOP 4.0**, and the sweep was launched with it.
It was stopped after one arm, at a cost of **0.0331 BZZ**.

SRS force-closes a segment at `hls_fragment * hls_aof_ratio` whether a keyframe arrived or not. The
deployment runs **fragment 0.25 and ratio 10**, so the ceiling is **2.5s** and a 4.0s GOP would have
produced segments mostly carrying no keyframe. `swarm-hls-srs-fragment-rule` records that this exact
mistake previously invalidated twelve runs, and I made it again while holding the rule in memory.

⭐ **So the sweep now reads `hls_fragment` and `hls_aof_ratio` off the running engine and refuses any
arm outside `[fragment, fragment * ratio]` before anything spends.** Remembering the rule was not
enough. The instrument had to enforce it.

⚠️ The range this costs us is real: the largest valid segment here is ~657 KB, so this sweep cannot
reach the 1.3 MB and above sizes where `c4-across-sizes` found latency worst. Covering those needs a
deployment at a larger fragment, which is a redeploy and a separate sitting.

## H1: small segments still sustain

**Claim.** All four GOPs return a `realtimeRatio` at or above 0.99 with **zero stalls**, the way the
2.0 profile already does.

**Falsifier.** Any stall, or a ratio below 0.99, at the 0.5 or 1.0 arm while the 2.0 arm is clean.
That would mean the fetch sweep's recommendation does not survive a broadcast and **`prefer small` has
to be withdrawn as product advice**, for the second time in two days.

## H2: latency falls with the GOP, roughly one segment's worth

**Claim.** The reported end-to-end latency falls monotonically from the 4.0 arm to the 0.5 arm, and
the gap between the extremes is on the order of the segment-duration difference, so several seconds.

**Falsifier.** A flat latency curve, which would mean segment duration is not the dominant term at a
live edge and the whole size question is smaller than it looks.

## H3: cost is flat across the arms

**Claim.** BZZ spent per arm is equal within measurement noise, because the cost model is per byte
with no GOP premium and every arm pushes the same bitrate for the same duration.

**Falsifier.** The 0.5 arm costing materially more. That would mean per-segment overhead is real and
`swarm-hls-cost-model`'s per-byte-only claim needs a chunk-count term.

## What no arm here can say

⛔ This is a gateway-fed viewer, not an in-browser node. `c4-across-sizes` measured an in-browser
node. The two are different clients and the numbers are not interchangeable.

⛔ One deployment, one bitrate, one resolution. Nothing here separates segment **duration** from
segment **bytes**, because at a fixed bitrate they move together. Separating them needs a bitrate
sweep crossed with a GOP sweep, which is four times the cost.

⚠️ Budget: `availableBalance` was **1.8807 BZZ** at the start. Eight arms of 8 minutes at 19.7 MB/min
is about 1.26 GB, which the cost model prices near **1.0 BZZ**. If the measured burn diverges from
that, the divergence is itself a result and `swarm-hls-cost-model` gets corrected.
