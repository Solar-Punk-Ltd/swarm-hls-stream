# Pre-registration: the shipping profile, live, and whether our fresh content behaves like his

**Written 2026-08-11 before a single byte was published.** Owner authorised spend, so this run costs
real BZZ and the predictions are recorded first. See [[swarm-hls-gate-lesson]] AGI: a mechanism
invented after the fact fits whatever it is shown.

## Why this run exists

Two results from today sit in tension and one broadcast separates them.

1. A gateway-less in-browser node sustained **8.34 Mbps** on abel-1's 4.24 MB segments, ratio 0.9962.
2. Our own references from 2026-08-03 delivered **2/10**, and a 225 KB one of ours **0/5**, on the same
   node in the same minutes his delivered 10/10.

Everything we have measured in a browser used **our** content, and our content is the arm that fails.
So every in-browser throughput figure in this repo is confounded with corpus health, and the shipping
profile has never been measured at all.

## The two live hypotheses

| | claim | prediction for **fresh** content of ours |
| --- | --- | --- |
| **H1 decay** | content stops being retrievable when nothing reads it, while postage still pays | fresh refs deliver like his, **≥8/10** |
| **H2 upload path** | our uploads were never distributed well, and age is a coincidence | fresh refs deliver **badly, ≤5/10**, exactly like the aug03 arm |

These are opposite and the arm is cheap: alternate his refs and our fresh ones one at a time, order
flipped between rounds, same node, same minutes. Identical instrument to
`docs/bench/size-vs-replication-2026-08-11.md`.

⭐ H2 would mean the browser numbers measure our uploader, not Swarm. H1 would mean Swarm does not
durably hold unread content, which is a first-order fact about shipping video on it.

## The occupancy model, and what it predicts for the profile we ship

From the weeb-3 source: chunk concurrency `RETRIEVE_CHUNK_CONCURRENCY = 2_048`, segment concurrency
`HLS_PREFETCH_BODY_MAX_PARALLEL = 3` plus one exempt foreground fetch, so **4 segments in flight**.
A segment is `bytes / 4096` chunks, so the semaphore that binds is only filled in proportion to
segment size.

| profile | segment | chunks | in flight | **occupancy** | measured |
| --- | ---: | ---: | ---: | ---: | ---: |
| latbench 0.25s / 2500k | 90 KB | 23 | 92 | **4.5%** | 235 KB/s |
| **720p 1.0s / 2500k** | ~329 KB | 82 | 329 | **16.1%** | ⬅ this run |
| **1080p 1.0s / 6000k, SHIPS** | ~766 KB | 192 | 767 | **37.5%** | ⬅ this run |
| abel-1 4.17s | 4,241 KB | 1,060 | 4,241 | **saturated** | 1,014 KB/s |

Two points exist. A straight line through them is
`KB/s = 235 + 8.16 x (occupancy - 4.5)`.

| profile | linear prediction | needed to sustain | **predicted ratio** |
| --- | ---: | ---: | ---: |
| 720p 1.0s / 2500k | 330 KB/s | 321 KB/s | **1.03, marginal** |
| **1080p 1.0s / 6000k** | **504 KB/s** | **748 KB/s** | **0.67, DOES NOT SUSTAIN** |

⚠️ **The line is fitted through two points from different sittings on different instruments.** It is a
prediction, not a supported model. Recorded so it can be wrong in public.

**The competing shape is saturation**: throughput could climb steeply and flatten well before the
semaphore fills, in which case 37.5% occupancy already buys most of the ceiling and 1080p sustains at
a ratio near 1.0. The two shapes disagree by 80% at the profile we ship, which is what makes the run
worth paying for.

⛔ **Whatever comes back, it is one sitting.** The 720p and 1080p arms are a within-sitting contrast
and comparable to each other. Against abel-1 they are across sittings, and abel-1 is itself n=1.

## What is being bought

Uploader chequebook holds **2.1237 BZZ available** (not the 26.55 total; `availableBalance` only
recovers on a deposit). Postage `7849851f…`, depth 24, immutable, 152/256, 24.05 days.

| arm | minutes | MB published | **BZZ** | buckets |
| --- | ---: | ---: | ---: | ---: |
| 1080p / 6000k / 1.0s | 20 | ~920 | 0.78 - 1.06 | ~11 |
| 720p / 2500k / 1.0s | 15 | ~296 | 0.26 - 0.32 | ~4 |
| **total** | **35** | **~1,216** | **1.04 - 1.38** | **~15** |

Leaves 0.74 - 1.08 BZZ and takes postage to ~167/256, under the 192 stop-and-ask line.
The in-browser node is unfunded, so **every measurement taken through it is free**. The gateway is not
used and its 5.99 BZZ is untouched.

## ⛔⛔ CORRECTION, 11:25Z, AFTER THE BROADCAST AND BEFORE THE BROWSER ARM RAN

**The prediction above assumed 1.0s segments because that is what `HLS_FRAGMENT` was set to. The
broadcast delivered 1.92s segments.** Correcting the input flips the prediction, and this is recorded
before any browser measurement was taken so it cannot be a rescue afterwards.

Measured off the run itself: 629 segments, indices 0-628, logged between 10:59:53Z and 11:19:59Z, so
**1.917 s per segment**. Eight of them fetched through the gateway average **806,497 bytes**.

| | pre-registered | **measured** |
| --- | ---: | ---: |
| segment duration | 1.0s | **1.917s** |
| segment size | ~766 KB | **787 KB** |
| delivered bitrate | 6.29 Mbps | **3.37 Mbps** |
| chunks per segment | 192 | **197** |
| occupancy at 4 in flight | 37.5% | **38.5%** |
| **throughput needed to sustain** | **748 KB/s** | **411 KB/s** |
| **linear model predicts** | 504 KB/s | **512 KB/s** |
| **predicted ratio** | **0.67, fails** | **1.25, SUSTAINS** |

⭐ The model did not change and neither did the occupancy. What changed is the bar: a 1.92s segment
carries nearly twice the media of a 1.0s one, so the same bytes have twice as long to arrive.

**So the falsifier inverts.** The occupancy model now predicts the shipping profile sustains
comfortably, and a measured ratio meaningfully below 1.0 refutes it.

## ⚠️ TWO INSTRUMENT FACTS THIS TURNED UP, BOTH WORTH THEIR OWN CHECK

1. **`HLS_FRAGMENT=1.0` with a 1.0s GOP produces 1.92s segments, roughly double.**

   ⛔⛔ **THE MECHANISM I FIRST GAVE FOR THIS IS WITHDRAWN.** I wrote that SRS cutting on the first
   keyframe *at or after* the fragment makes GOP-equal-to-fragment pathological, because the keyframe
   landing a hair under the boundary is skipped. That was reasoned from **one** configuration, and a
   second one refutes it: `HLS_FRAGMENT=0.5` with a 0.5s GOP, the same pairing, produced **0.502s**
   segments (968 of them in 8.1 minutes, and its own report agrees at a 0.50s median). If the
   near-miss story were right, 0.5 would double to 1.0 as well. It does not.

   The encoder settings are not exotic and rule out the obvious alternatives: `-g round(fps*gop)`,
   `-sc_threshold 0` so scene changes insert no extra keyframes, `-tune zerolatency`
   (`e2e/src/bench/wallclockPublisher.ts:115`).

   ⭐ **So the finding is the observation, not an explanation for it: the delivered segment duration
   is not predictable from the fragment knob and has to be measured per configuration.**

   **Three arms in, and the anomaly is a single point:**

   | `HLS_FRAGMENT` | segments | observed median | **ratio** |
   | ---: | ---: | ---: | ---: |
   | 0.5 | 968 | 0.50s | **1.00x** |
   | **1.0** | **629** | **1.90s** | **1.92x** |
   | 2.0 | 245 | 2.00s | **1.00x** |

   ⛔⛔ **It is not a systematic pathology. 0.5 and 2.0 both land on the knob, and only 1.0 doubles.**
   That rules out every "boundary rounding" story, including the one I withdrew, because a rounding
   effect would hit 0.5 and 2.0 as well.

   ⚠️⚠️ **And 1.0 is the compose default, so it is what ships.** A deployment on defaults publishes
   segments twice as long as configured, which doubles the latency floor a viewer waits through. That
   is a product consequence, not just an instrument one, and it deserves its own investigation rather
   than another guess from me.

   > ### ✅ 2026-08-12: ANSWERED, AND IT IS NOT THE FRAGMENT VALUE
   >
   > A twenty-arm bracket on stock SRS settles it: **`median = ceil(fragment / GOP) * GOP`**, and all
   > three pairs above are GOP equal to fragment, so all three should land on the knob.
   > `gop-vs-fragment-2026-08-12.md`, every arm replicated to three decimals.
   >
   > | pair | predicted paced | this table measured |
   > | --- | ---: | ---: |
   > | 0.5 / 0.5 | 0.50s | **0.50s** ✓ |
   > | **1.0 / 1.0** | **1.00s** | **1.90s** ✗ |
   > | 2.0 / 2.0 | 2.00s | **2.00s** ✓ |
   >
   > ⭐⭐ **So the 1.0 row is the odd one out because that sitting was starved, not because 1.0 is a
   > special number.** The publisher has no rate limit of its own, so its frame rate is whatever the
   > socket accepts, and its wallclock timestamps write that straight into the media timeline.
   > 30 frames at the ~15.8 fps that sitting achieved is 1.90s. See `segment-stretch-2026-08-12.md`,
   > whose replicate of one identical configuration moved **1.8x**, which is the same variance showing
   > up here as a single anomalous row.
   >
   > ⛔⛔ **And "GOP equal to the fragment doubles the segment" is WITHDRAWN.** Three equal pairs were
   > run paced and none doubled.
   >
   > ⭐⭐⭐ **The product consequence is the opposite of the one recorded above.** A deployment on
   > defaults does not publish "twice as long as configured" because of the fragment. It publishes
   > **one GOP**, and at `hls_fragment 0.25` with `gopSeconds: 2` that is **8x** the fragment. The knob
   > to reach for is `gopSeconds`, and `HLS_FRAGMENT` at 0.25 is doing nothing at all.
2. **The bench's `6000 kbps` is a request, not a delivered bitrate.** On this synthetic source it
   delivered 3.37 Mbps.

⛔ Together these mean **`docs/bench/what-a-gateway-burns-at-each-profile-2026-08-09.md`'s BZZ/min
column is suspect for its 1.0s rows.** It records "6000k @ 1.0s, 792 kB, 47.9 MB/min", and 47.9 MB/min
from 792 kB segments requires them to be 1.0s. If they were really 1.92s the true rate is 24.6 MB/min
and **every BZZ/min figure on those rows is about twice what it should be.** That matches today's
measurement: predicted 0.0322 BZZ/min gateway, measured **0.0119**.
⭐ Its per-byte headline (0.000678 BZZ/MB) is **not** affected, because that was measured by fetching
a fixed 30 MB per arm and never divided by an assumed duration.

## Falsifiers, written down now

- **The occupancy model dies** if 1080p @ 1.0s returns a ratio above 0.9 with delivered throughput
  under ~600 KB/s, or if 720p and 1080p come back with the same throughput.
- **H2 dies** if our fresh refs deliver ≥8/10 against his in the alternating arm.
- **H1 dies** if our fresh refs deliver ≤5/10. That would also void the decay reading in
  [[swarm-hls-content-decay]] and point the whole investigation at our uploader.
- **The run is void** if the abel-1 control arm does not deliver ≥8/10, because then the node is sick
  and neither arm means anything. ⭐ The control is **his** content, deliberately: a canary made of
  ours cannot tell a sick node from missing content, which is the defect this instrument was built to
  avoid.
