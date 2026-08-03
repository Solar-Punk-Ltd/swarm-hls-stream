# Operating profiles: what this deployment can actually do

Measured 2026-08-03 on `manager-host`, profile `latbench`, engine SRS, 86 runs and 430 samples.
Everything below is `pnpm bench:sweep-report` over the artifacts in this directory, which anyone can
re-derive without spending anything.

Read [swarm-hls-tuning-results](#) alongside this: it explains why 1.0s and a 6s player buffer became
the defaults. This document is the wider question the owner asked, which is not "how low can it go"
but "what can we choose between".

## Where these numbers come from, and why that matters more than usual

**Every run publishes and fetches from the deployment host.** Publishing the same stream from a
workstation lost about 15% of SRT packets and cost 3.18s of an 8.18s reading, roughly 39% of it,
none of which was the product. A row's `skew` column is the tell: 3 to 5ms means on-host, and the two
rows at 156ms are the old workstation runs, kept as a warning rather than deleted.

**Latency here means capture to fetchable**, the interval from a frame being captured to the instant
its segment could first be retrieved from the gateway. It is not what a viewer sits behind live. That
is this number, minus one segment, plus whatever buffer the player holds, and the last column of the
profile table does that arithmetic.

## The profiles

| profile | picture | segment | capture to fetchable | player buffer | behind live | samples |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| **`live-fast`** | 1280x720 2500k 30fps | 0.50s | **1.96s** | 5.0s | **6.43s** | 25 |
| **`live`** _(current default)_ | 1280x720 2500k 30fps | 1.00s | **2.88s** | 5.9s | **7.77s** | 30 |
| **`hd-fast`** | 1920x1080 6000k 30fps | 0.50s | **2.89s** | 5.3s | **7.65s** | 20 |
| `sd-fast` | 854x480 1200k 30fps | 0.50s | **1.93s** | 5.2s | **6.60s** | 25 |
| `live-quarter` | 1280x720 2500k 30fps | 0.27s | **2.17s** | 5.4s | **7.26s** | 25 |
| `hd-quarter` | 1920x1080 6000k 30fps | 0.27s | **2.71s** | 5.9s | **8.31s** | 25 |
| `sd-one` | 854x480 1200k 30fps | 1.00s | **2.83s** | 6.1s | **7.93s** | 25 |
| **`hd-max`** | 1920x1080 9000k 30fps | 1.00s | **4.38s** | 7.0s | **10.37s** | 25 |
| `sd-two` | 854x480 1200k 30fps | 2.00s | **5.31s** | 7.9s | **11.21s** | 25 |
| `hd-onehalf` | 1920x1080 6000k 30fps | 1.50s | **4.55s** | 8.2s | **11.25s** | 25 |
| **`hd`** | 1920x1080 6000k 30fps | 1.00s | **4.35s** | 8.0s | **11.38s** | 20 |
| `live-relaxed` | 1280x720 2500k 30fps | 2.00s | **5.01s** | 8.5s | **11.46s** | 30 |
| **`hd-relaxed`** | 1920x1080 6000k 30fps | 2.00s | **6.49s** | 11.1s | **15.59s** | 25 |
| `archive` | 1280x720 2500k 30fps | 4.00s | **9.42s** | 12.7s | **18.13s** | 25 |
| `hd-three` | 1920x1080 6000k 30fps | 3.00s | **8.21s** | 13.1s | **18.32s** | 25 |
| `hd-four` | 1920x1080 6000k 30fps | 4.00s | **10.60s** | 15.1s | **21.67s** | 25 |

The player buffer is **derived, not chosen**. A player stalls unless it covers the largest observed
edge-to-fetchable delay, which is `total - segment` per sample, and the figure above is that floor
plus the client's poll cadence plus one segment of margin. Lower it below the floor and it will
stall on a segment this sweep has already seen.

## The segment curve, swept properly

Every picture across every segment length, so the shape is measured rather than extrapolated from one
resolution. `n` is samples, `behind live` uses each row's own derived buffer.

| picture | 0.27s | 0.50s | 1.00s | 1.50s | 2.00s | 3.00s | 4.00s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 854x480 1200k | | **6.60s** | 7.93s | | 11.21s | | |
| 1280x720 2500k | 7.26s | **6.43s** | 7.77s | | 11.46s | | 18.13s |
| 1920x1080 6000k | 8.31s | **7.65s** | 11.38s | 11.25s | 15.59s | 18.32s | 21.67s |

**The floor is half a second and it is a real minimum, not a limit of patience.** Going to a quarter
second makes a viewer's latency *worse* at every picture measured: 720p goes from 6.43s to 7.26s and
1080p from 7.65s to 8.31s. Capture to fetchable at 720p also rises, from 1.96s to 2.17s, so this is
not an artefact of the buffer derivation.

The mechanism is the one the flat `manifestPublish` row already implied. A manifest write costs about
220ms **per segment** and does not care how much video is in it, so halving the segment doubles that
work per second of broadcast. Measured at 720p, the `feed` hop nearly doubles from 728ms to 1352ms
while the segment saves only 233ms. **Below half a second the pipeline spends more on bookkeeping
than the shorter segment gives back.**

So the answer to how low this can go is **6.43s behind live, at 720p with half-second segments**, and
it is a floor rather than a stopping point.

## The two things this measured that were not known

### Quality is not free, and it is paid in Swarm rather than in the encoder

At a fixed one-second segment, raising the picture costs:

| picture | capture to fetchable | manifest write | segment retrieval |
| --- | ---: | ---: | ---: |
| 1280x720 2500k | 2.86s | 221ms | 192ms |
| 1920x1080 6000k | 4.14s | 217ms | 346ms |
| 1920x1080 9000k | 4.38s | 217ms | 438ms |

**The manifest write does not move at all.** It is 217 to 254ms on every one of the fifteen settings
measured, from 480p at 1200k to 1080p at 9000k, because a feed update is a small chunk whatever the
video is. Every second the picture costs is spent putting the segment into Swarm and getting it back
out, and it shows up cleanly in `fetch`, which is bounded by one clock and rises from 70ms to 438ms
across the range.

The practical consequence is the opposite of what it first looks like. **1080p at half-second
segments (7.65s behind live) beats 720p at two-second segments (11.44s)**, so if latency is what
matters, shorten the segment before you lower the resolution.

### The publish path, not the encoder, is what breaks first at 1080p

Three of nine 1080p runs at 6000kbps emitted **30 frames over 1.6 to 2.0 seconds**, so the stream ran
at 15 to 18fps and the segment stretched to fit a GOP that took too long to fill. The manifest agreed
with the bytes. Nothing was lost in transit.

It is not the encoder running out of room. `ffmpeg` alone on that host reaches **76fps** at 1080p
6000k and 100fps at 720p 6000k, against the 30 needed. What it is, precisely, is not established: the
publisher shares a machine with 69 containers including the whole stack it is publishing into, and a
real broadcaster does not.

**So the 1080p rows are honest about this deployment and pessimistic about a real one.** They are
also why the `hd` row's buffer is 8.0s against `hd-fast`'s 5.3s: the same variance that stretched
those segments widened the arrival tail on the runs that stayed clean.

## Segments per minute, which is the cost nobody sees in a latency table

| segment | uploads per minute | relative postage and requests |
| ---: | ---: | --- |
| 0.50s | 120 | 4x the two-second baseline |
| 1.00s | 60 | 2x |
| 2.00s | 30 | 1x |
| 4.00s | 15 | 0.5x |

This is the whole argument for `live` over `live-fast`. Half a second is measured, supported, and
about a second better, and it doubles the number of uploads, feed writes and viewer requests forever.
The five-profile sweep in this directory cost **0.257 BZZ** and moved stamp utilisation from 12 to 16
of 64.

## Choosing

- **Latency above all:** `live-fast`, 720p at half-second segments. **6.43s, the best row in the
  whole matrix**, and there is nothing below it.
- **The default, and the one to leave alone without a reason:** `live`. 7.77s at half the operational
  cost of `live-fast`.
- **1080p and you still care about latency:** `hd-fast`, not `hd`. **7.65s against 11.38s for the
  same picture**, purely by halving the segment. It also beats 720p at a one-second segment, so at
  this deployment 1080p is not something latency has to be traded for.
- **1080p and you do not:** `hd-relaxed` at 2.0s, 15.59s, one third the uploads of `hd-fast`.

**480p is not worth carrying.** At half a second it measures 6.60s against 720p's 6.43s, so the
cheaper picture is not the faster one, and at every other segment length it is behind too. The
retrieval saving from fewer bytes is smaller than the run-to-run scatter. Drop `sd-fast` unless the
constraint is the broadcaster's uplink rather than this deployment.

**Quarter-second segments are measured, supported and not recommended**, for the reason in the curve
above.

## What is not measured here, stated so nobody reads it as measured

- **`SRT_LATENCY` is held at 200 throughout.** The bench publishes over loopback where nothing is
  lost, and a retransmission buffer that never absorbs a retransmission cannot be told from one that
  is not there. It is a real knob for a real broadcaster on a real network and this is the wrong
  instrument for it.
- **`HLS_FRAGMENT` is a floor, not a target.** SRS cuts on the first keyframe at or after it, so the
  segment is really the publisher's GOP whenever the GOP is longer. Every row above pairs them
  deliberately. **The operator owns the fragment and the broadcaster owns the GOP, and they are
  different people:** a 1.0 fragment against a broadcaster's 2s GOP gives 2s segments and the
  `live-relaxed` row's latency, not `live`'s.
- **60fps was not measured at all**, at any resolution.

## The browser attempt, and why the buffer column is still a model

The buffer column is a floor over observed arrivals. The claim it supports is that these samples
would not have stalled a player configured that way, not that none ever will, and closing that gap
means watching one. A 420 second stream was published with the host's clock burned into the picture,
against a client rebuilt so `LIVE_SYNC_DURATION_S = 6` is in the served bundle, verified in the
JavaScript actually shipped.

**Four things were established, none of which had been observed before:**

- The whole viewer path works in a real browser. Catalog feed, manifest through Swarm, segments
  through Swarm, decoded at 1280x720 with `readyState` 4.
- hls.js accepts the shipped config **in a browser**. Until now that was asserted by constructing
  `new Hls(...)` under Node, where the constructor's checks run and the media pipeline does not.
- **The 1.1x catch-up is real.** `playbackRate` was observed at 1.1 while the player was behind and
  back at 1 once it had caught up, which is LAT-2's fix seen rather than argued. Playback advanced
  1.10 seconds per second of wall clock while recovering.
- A live stream appeared in the catalog as `LIVE` and was playable within seconds of the publish.

**The steady-state measurement could not be taken, and the reason is the harness rather than the
product.** The automated browser pane reports `visibilityState: hidden` permanently, and Chromium
treats a hidden page two ways that each break this. Muted playback is stopped outright, logged as
`video-only background media was paused to save power`, which is fixable by unmuting at zero volume
and was. Once playback stalls for any reason the page's timers are throttled to roughly one per
minute, and hls.js drives its own playlist polling and fragment loading from those timers, so the
first stall starves the loader and guarantees the next one. The player ended up chasing its own
download frontier with under a second of buffer, logging `bufferStalledError ... due to low buffer`,
and drifted 578 seconds behind live. **None of that is a reading about this deployment.**

`deploy/scripts/publish-clock.sh` is the method and it works: one screenshot carried the host clock
inside the video and the browser clock beside it, both legible. It needs a browser whose page is
actually visible.
