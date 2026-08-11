# ✅✅ #72 ANSWERED: the profile we ship sustains in a gateway-less in-browser node, with no stalls

> ⚠️ **2026-08-12: the stream this sustained is 3.21 Mbps, and the reason is now known.** It is not
> SRS, and it is not the deployment host. **The publish path from the laptop to the host delivers
> about 2.7-3.3 Mbps of this profile**, reproduced in `segment-stretch-2026-08-12.md` by moving only
> the media engine onto the host. The publisher has no rate limit of its own, so it runs at whatever
> the socket drains, and its wallclock timestamps then record that as the stream's frame rate.
>
> ⭐ **The result below is unaffected and its headroom figure is the right one for this deployment**:
> a viewer really does receive 787 KB every 1.917s from it. A publisher on a fatter link would send
> 750 KB/s instead of 411, so the same browser node would have about **1.5x** headroom rather than
> 2.76x. Both are true of different publishers, and neither is a property of the viewer.



**2026-08-11.** Broadcast fresh, then played back through `deploy/scripts/run-sustain-headless.mjs` in
headless Chrome over raw CDP. Node unfunded, no gateway, 200 connected / 0 connecting at start.
Raw samples in `docs/bench/ours-shipping-sustain-2026-08-11.json`.

| | |
| --- | --- |
| **realtimeRatio** | **0.9996** |
| **stalls** | **0**, `lostS` 0.3 |
| startup to first advance | 2s |
| playhead / wall | 716.9s / 719.2s |
| buffer lead at the end | **90.8s** |
| main thread utilization | **0.116** |

⭐ **This is the first time the shipping profile has ever been measured in an in-browser node.** Every
earlier sitting replayed a `HLS_FRAGMENT=0.25` bench recording and was reported as "our stream".

## What was actually published, which is not what was configured

| | configured | **delivered** |
| --- | ---: | ---: |
| fragment | 1.0s | **1.917s** |
| bitrate | 6000 kbps | **3.21 Mbps** |
| segment | - | **787 KB** |

Both gaps are recorded in `live-shipping-profile-prediction-2026-08-11.md` with their causes. They do
not weaken this result: **1.917s segments at `HLS_FRAGMENT=1.0` are what a deployment on the compose
defaults actually produces**, so this is the shipping profile as shipped, not as intended.

## ⛔⛔⛔ CORRECTION: A PLAYBACK RUN MEASURES THE STREAM'S BITRATE, NOT THE NODE'S CAPABILITY

**Everything below the next heading was written from a whole-run average and is wrong.** Both runs
ramp to a ~90s buffer lead and then hold it flat for the remaining 570 seconds. Once the buffer is
satisfied the player fetches at exactly the stream's bitrate, so **the steady phase measures the
demand we chose, not what the node can do.** Averaging the two phases together buries the only
informative part of the run.

⭐⭐ **The fill phase is the measurement.** Both runs, independently:

| | fill rate | **delivered** |
| --- | ---: | ---: |
| run 1 | 1.875x realtime | **770 KB/s** |
| run 2 | 1.860x realtime | **764 KB/s** |

**~767 KB/s, n=2, agreeing within 0.8%** — not the 461 first reported.

⛔ **abel-1 carries the same defect and its figure moves too.** Its 1,014 KB/s was `ratio x demand`
from a run that also reached a steady lead. Recomputed off its own fill phase: **1,135 and 1,160 KB/s**,
so **~1,148**. ⚠️ Note how much closer to its demand that sits: abel needs 1,018 and can do 1,148, a
13% margin, while this profile needs 411 and can do 767, an **87%** margin.

⚠️ 767 is what the node **and hls.js together** achieve when the player wants more than realtime. It
is a floor on the node alone.

## ⛔⛔ AND SO THE OCCUPANCY MODEL IS REFUTED AT THE POINT IT PREDICTED

| stream | segment | occupancy | demand | **capability** |
| --- | ---: | ---: | ---: | ---: |
| bench 0.25s | 90 KB / 0.266s | **4.5%** | 338 KB/s | **228** |
| **ours, as shipped** | **787 KB / 1.917s** | **38.5%** | **411 KB/s** | **767** |
| abel-1 | 4,241 KB / 4.167s | saturated | 1,018 KB/s | **1,148** |

⭐ The 4.5% point survives unchanged, and for an instructive reason: **that run never filled a buffer**,
so its playback rate really was its capability. A failure measures the node; a success measures the
stream.

**A line through the outer points predicts 382 KB/s at 38.5%. Measured 767, twice.** The linear model
is not 10% out as first reported, it is **half**. ⭐⭐ The real shape is strongly saturating: 8.6x the
occupancy from 4.5% to 38.5% buys **3.4x** the throughput, and a further 5.4x buys only **1.5x**.

⭐⭐⭐ **The product reading is better than the linear model's, not worse.** At 38.5% occupancy the
shipping profile already gets **two thirds of what a saturated node gets**, with 87% headroom over what
it needs. Chasing bigger segments buys much less than the line suggested.

## ⛔ SUPERSEDED: what the whole-run average said

Chunk concurrency is 2,048 (`lib.rs:321`); segment concurrency is 4 (`stream_hls.rs:3720` plus one
exempt foreground fetch). A segment fills `bytes / 4096` chunks, so **small segments cannot fill the
semaphore that binds** no matter how many are in flight.

| stream | segment | chunks x 4 | occupancy | demanded | delivered | ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| latbench bench profile | 90 KB / 0.266s | 92 | **4.5%** | 338 KB/s | ~229 | 0.6734 |
| **ours, as shipped** | **787 KB / 1.917s** | **788** | **38.5%** | **411 KB/s** | **461** | **0.9996** |
| abel-1 | 4,241 KB / 4.167s | 4,240 | saturated | 1,018 KB/s | ~1,014 | 0.9962 |

A line through the two outer points predicts **508 KB/s** at 38.5%. Measured **461**, which is 10%
under. ⭐ The prediction was written down before the run and the middle point had never been measured.

⚠️ **461 is a floor, not the node's ceiling.** The buffer lead sat at a constant 90.8s for the last
several minutes, so the node had stopped pulling as hard as it could and was pacing against a
satisfied buffer. It fetched **1.123x realtime** across the run. The model predicted a ceiling and the
measurement is a lower bound, so the 10% gap does not refute it.

## ⛔ It is not CPU

0.253 cores of a 12-core machine, main thread at **0.116**. A single-threaded node at 12% of one
thread is not the constraint, which rules out the alternative explanation for any throughput ceiling
seen here. Startup to first frame was 25.1s at 0.222 cores.

## What this retires

- ⛔ **"A browser viewer cannot hold 2.7 Mbps" stays withdrawn, and now has a positive replacement:**
  3.21 Mbps held with zero stalls on the profile we ship.
- ⛔ **`#44`'s 0.6734 is fully explained.** It was 90 KB segments at 4.5% occupancy, and the same node
  reaches 0.9996 at 38.5% and 0.9962 when saturated. The node was never the problem.
- ⛔⛔ **"Segment size is a first-class product knob" is withdrawn, 2026-08-12, and points the other
  way.** It is a knob for a client fetching one segment at a time. At the concurrency hls.js really
  uses, throughput across a 8.3x size range varies by **1.26x**, while per-segment latency varies by
  **7.2x**. So size still matters, as a **latency** decision, and small wins.
  See `c4-across-sizes-2026-08-12.md`.

## Still open

- **n=1.** ⚠️ Worth a replicate now that a sitting costs only wall clock.
- **The ceiling at this segment size is unmeasured**, because the player stopped asking. It needs a
  fetch-as-fast-as-possible arm at 787 KB, not a playback arm.
- **Live edge, rather than VOD.** This played a finished recording, like abel-1. A viewer joining a
  live broadcast has the push-sync race as well.
