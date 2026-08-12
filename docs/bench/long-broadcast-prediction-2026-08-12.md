# Four hours of one broadcast, predicted before spending

**Registered 2026-08-12, before the sitting.** Task #89. Predictions here so the result can refute
them rather than be read back as having been expected.

## Why this is the biggest gap in the corpus

**Nothing in this repo has ever run past ten minutes.** Every figure about what a viewer experiences
over time is either a ten-minute observation or a projection from one. Four of the things this project
currently believes are only reachable by holding a broadcast open:

| what | its current status |
| --- | --- |
| a viewer's manifest cost at hour scale | projected from 1,200 segments, and `manifest-growth` says so |
| the fourteen-minute collapse | **one occurrence in fifteen runs**, never reproduced |
| the `#EXT-X-TARGETDURATION` ratchet | derived from the code, never watched happen |
| a stall at the shipping profile | the profile ran a sustained stretch with **zero**, so the penalty has never been observed being paid |

Four hours at a 0.5s GOP is about **28,800 segments** and **16 fourteen-minute windows**.

## Predictions

1. **The manifest reaches about 3.0 MB and serialises in roughly 4 to 5 ms.** `manifest-growth`
   measured 774 KB and 0.76 ms at 7,200 segments and projected 7.6 MB and 13.9 ms at 72,000. Bytes
   are linear in segment count at about 105 bytes each, so 28,800 segments gives 3.0 MB. Time was
   superlinear over that range, 18x for 10x the segments, which puts 4 hours nearer 4.5 ms than 3.0.
   ⚠️ Refuting the **byte** figure would be more interesting than refuting the time one, since bytes
   are the part the arithmetic is confident about.

2. **`#EXT-X-TARGETDURATION` stays at 1 for the whole broadcast.** `ceil(0.5 + 0.135)` is 1, and the
   only way to 2 or 3 is a segment force-closed at the `fragment * aof_ratio` ceiling of 2.5s. If it
   moves, **the moment it moves is the finding**, because the stall penalty ratchets with it and never
   comes back down.

3. ⭐ **Median viewer latency is non-decreasing across the four hours.** This is the sharpest thing
   here. hls.js adds `min(stallCount, targetduration)` on every stall and **never lowers the target
   again**, so a viewer's distance from live should be a staircase that only goes up. If it comes
   back down, something resets it that this project has not accounted for, and that would change how
   every latency figure here is read.

4. **Between zero and three occurrences of the fourteen-minute collapse.** One run in fifteen showed
   a read-path service-time step at t=822s. Sixteen windows at that rate gives about one, and the
   uncertainty is wide enough that zero refutes nothing. ⚠️ Weakest prediction here, and stated so
   that a zero is not written up afterwards as a success.

## What would make it void rather than negative

- **The broadcast not lasting four hours.** `publish-clock.sh` paces with `realtime` filters, and
  `wallclockPublisher`'s own comment records that pacing drift accumulates over a long publish, which
  is why bench runs are minutes. This is the first time anything here asks ffmpeg to hold four hours,
  and drift is a real way for the axis to move under the measurement.
- **The browser dying.** 14,400 samples and about 480 screenshots, against a longest-ever run of ten
  minutes. Memory growth in the sampler is untested at this length.
- **Screenshots landing out of order**, which was true until today: the index padded to four digits,
  so everything past sample 9,999 sorted before what came earlier. Fixed, and this run is the first
  that would have hit it.

## Design

One continuous broadcast, 720p30 at 2500 kbps and a **0.5s GOP**, which is the shipping profile. One
browser watching throughout, sampling every second, screenshotting every thirtieth sample.

Run through `viewer-arms.sh` with `WARMUP_ROUNDS=0`, since a soak has nothing to compare against and
nothing to warm up for. Host-side and detached, because a four-hour ssh session is not a dependency
worth having.

⛔ Both ends self-terminate: ffmpeg is bounded by `-t` and the watch by `BROWSER_WATCH_SECONDS`, so
an unattended run cannot outlive its budget even if nobody is watching it.

## Cost

Measured today rather than assumed: the uploader burned about **0.6 BZZ per broadcast hour** across
the day's sittings, against the 0.90 planning figure. Four hours is therefore nearer **2.4 BZZ** than
3.6. The gateway's own rate is being measured cleanly off the buffer sweep and will be stated with
the result rather than guessed at here.
