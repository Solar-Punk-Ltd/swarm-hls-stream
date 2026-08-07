# A freeze and the seek that ended it used to net to 1.000

**2026-08-07.** Task #102, raised by the pre-merge review of PR #74 and fixed here. Replayed against
every browser run this repository has recorded, rather than argued from the code.

## What was wrong

`overallAdvanceRatio` is the headline viewer figure: media seconds delivered per wall second across
a whole session. It was computed by reading `currentTime` at the start and end of each life of the
player, breaking only where the playhead moved **backwards** past five seconds, which is the client
remounting.

Nothing broke it where the playhead moved **forwards**. hls.js writes
`media.currentTime = liveSyncPosition` whenever latency passes `LIVE_MAX_LATENCY_DURATION_S`. That
is its designed recovery and the normal end of every freeze the gateway causes. So a viewer who
watched a frozen frame for ten seconds and was then jumped ten seconds forward had a playhead that
covered the whole wall clock, and scored exactly **1.000**.

The frame rate had the same defect through the same function. `deliveredFps` divides decoded frames
by media seconds played, and a seek decodes nothing it jumps over, so the skipped media inflated the
denominator and understated the rate.

## The fix

A ceiling rather than a judgement. No viewer can watch more media seconds than the clock allows at
the fastest rate the player is configured to run, `MAX_LIVE_SYNC_PLAYBACK_RATE = 1.1`. Anything
gained above that was jumped past, so it is excluded from what played and reported on its own row.

The ceiling is the configured rate rather than the rate either sample reported, because hls.js may
raise the rate between two samples and a ceiling that trusted the samples would call that a seek.
The detection threshold adds half a second for reading `currentTime` and the clock at slightly
different instants.

That threshold has a wide gap to sit in, and the recorded data confirms the gap is real: an honest
second gains at most 1.1s, and **the smallest forward jump in 17,726 recorded samples was 5.36s**.

## Replayed against every recorded run

36 runs, 17,726 samples. **35 forward seeks flagged, 0.2% of samples.**

Every flagged jump gained between 5.36 and 28.13 media seconds inside a single ~1.0 second sample.
There is not one borderline case anywhere in the corpus: the nearest flagged jump is more than three
times the threshold. The clustering at ~7.5s is the hls.js recovery seek's own signature, which
fires past a 12s latency and lands on a 6s one.

### Every run whose figure moved, and every one that did not

| run | before | after |
| --- | ---: | ---: |
| crash, uploader crash (2026-08-05) | 0.992 | **0.603** |
| crash, writer bee outage | 0.994 | **0.669** |
| crash, viewer gateway outage (08-06 04:46) | 0.992 | **0.751** |
| crash, viewer gateway outage (08-05 17:05) | 1.006 | **0.756** |
| crash, viewer gateway outage (08-06 05:13) | 1.001 | **0.764** |
| crash, viewer gateway outage (08-06 05:06) | 0.989 | **0.794** |
| crash, uploader crash (2026-08-06) | 1.003 | **0.855** |
| watch (08-06 06:58), two mid-session seeks | 0.984 | **0.934** |
| **the other 28 runs** | **unchanged to three decimals** | |

**Every faulted run moved. Not one clean run did.** That is the result worth keeping: the change
does not touch a single healthy-session figure, and the loop fix, the quality figures and the hour
that held are all measured on clean runs.

Two faulted runs are unchanged and both are correct to be:

- **crash, engine restart** stays at 0.383. That fault rewinds the player rather than seeking it,
  and the backwards case was already handled. The old code was right about restarts and wrong about
  seeks, which is a narrow defect rather than a broken metric.
- **crash, writer bee pause** stays at 0.994 with zero seeks. A short pause really did cost the
  viewer almost nothing, and that result survives.

### The frame rate

One run moved: **28.38 → 29.89 fps**, +5.3%, toward the 30 it was encoded at. Every other run is
unchanged, because the crash runs predate `decodedFrames`.

## What this retracts

The two crash reports that said a viewer kept playing at roughly 1.00x through a fault. They did
not. A viewer through an uploader crash got **0.603** of real time, not 0.992, and through a gateway
outage **0.751 to 0.794**, not ~0.99. The faults were always visible in the other columns, in
`stalledSamples` and in the rebuffer totals. The one row that was supposed to summarise them was the
row that hid them.

The direction of every A/B in those reports is unaffected, because both arms were measured the same
way. The magnitudes are what moved.
