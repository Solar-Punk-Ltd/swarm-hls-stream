# ✅✅ #72 ANSWERED: the profile we ship sustains in a gateway-less in-browser node, with no stalls

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

## ⭐⭐ THE OCCUPANCY MODEL PREDICTED THE MIDDLE POINT BEFORE IT WAS MEASURED

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
- ⭐ **Segment size is a first-class product knob**, not a latency detail. It sets how much of the
  chunk semaphore a viewer can fill, and that sets whether playback holds.

## Still open

- **n=1.** ⚠️ Worth a replicate now that a sitting costs only wall clock.
- **The ceiling at this segment size is unmeasured**, because the player stopped asking. It needs a
  fetch-as-fast-as-possible arm at 787 KB, not a playback arm.
- **Live edge, rather than VOD.** This played a finished recording, like abel-1. A viewer joining a
  live broadcast has the push-sync race as well.
