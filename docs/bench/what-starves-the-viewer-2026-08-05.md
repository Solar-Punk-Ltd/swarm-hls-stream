# What starves the viewer, and why the fastest profile is the worst one

**2026-08-05. Three broadcasts, one per GOP, watched in a real browser with every request logged.
All three instrument-sound.** Follows [the first browser validation](./viewer-in-a-browser-2026-08-05.md).

## The answer

| GOP | media per wall second | wall clock frozen | segments fetched | segments produced | **headroom** | behind live |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **0.25s** | 0.819 | **17.3%** | 3.07/s | 3.75/s | **0.82x** | 2.19s |
| 0.50s | 0.904 | 9.6% | 1.85/s | 2.00/s | 0.93x | 2.17s |
| **1.00s** | **0.976** | **2.4%** | 0.99/s | 1.00/s | **0.99x** | 2.54s |

**The advance ratio equals the fetch headroom, in all three runs, to within 0.02.** A viewer's picture
advances at exactly the rate their client can pull segments, and nothing else in the pipeline shows
up in it. That is the whole finding.

## Both prior hypotheses were wrong, and the log says so plainly

⛔ **Not the 404-and-retry theory.** The obvious candidate was hls.js waiting its `retryDelayMs` of
1000ms after a fragment refused with a 404, which is roughly four segment intervals at 0.25s. The
request log records **0 refusals in 469 segment requests** and **0ms spent waiting between attempts**.
Not the cause, not a contributor, not present at all.

⛔ **Not a slow gateway.** A successful segment transfer takes **125ms** at 0.25s and **184ms** at
0.5s, for segments of roughly 90kB. The gateway serves everything asked of it, promptly.

✅ **The client asks too slowly, because it asks serially.** Segment requests and feed reads run
**one-for-one**: 469 segments against 455 feed reads, and 280 against 274. The live loop walks one
feed slot, reads one manifest, fetches one segment, and repeats, with at most **2** requests in flight
at any moment. Each cycle pays a feed-read round trip of 51-72ms *on top of* the segment's own
duration, and the media gained is one segment. So:

```
advance ratio  ≈  segment duration / (segment duration + feed round trip)
```

At a 0.267s segment a 60ms round trip is 22% of the budget. At 1.0s it is 2.5%. **Shorter segments do
not make the client faster, they make it ask more often**, and the per-ask cost is fixed.

## Why this changes which profile ships

The 10-minute gate chose 0.25s on **1.074s capture-to-fetchable** against 1.535s for 0.5s, a 462ms
advantage. That advantage does not reach a viewer:

**Behind live was 2.19s, 2.17s and 2.54s.** Essentially identical across a fourfold change in segment
length, because what a viewer sits behind is dominated by the player's own buffer and not by how
finely the stream is cut. The 0.25s profile bought 462ms that nobody sees and paid **17.3% of the
wall clock frozen** for it.

⚠️ **The bench could not have caught this and it is not a defect in the bench.** It measures when one
segment first becomes fetchable, one segment at a time. A player must sustain a *rate*, continuously,
through a client that serialises. Those are different questions and only the second one is what a
viewer experiences.

## What to do

**Ship 1.0s until the client's live loop is fixed.** Same viewer latency, one seventh of the
freezing, and it needs no code change.

**Then fix the loop, and 0.25s becomes available again.** The ceiling is a serialised
read-then-fetch cycle at the live edge, so the fixes are the obvious ones: request the next feed slot
while the current segment is still downloading, or fetch several announced segments at once. The
client already addresses segments by computed slot, so it does not need new information to do either.

⚠️ **1.0s is break-even, not comfortable.** 0.976 is still four rebuffers in 150 seconds, and the
model says the margin at 1.0s is about 25ms per segment. A slower afternoon eats that.

## What this does not say

**One run per GOP, one afternoon, one machine.** The three agree with each other and with a mechanism
that predicts them, which is stronger than three bare numbers, but this project has been caught
before reading one afternoon as a property of a configuration.

**The 1.0s row has not been gated at ten minutes**, and the profile grid it would replace was.

**The `advance ≈ duration/(duration + overhead)` model is fitted to three points.** It is a
description with a mechanism behind it, not a law, and 2.0s was not measured.
