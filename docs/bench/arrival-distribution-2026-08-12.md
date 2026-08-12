# How late a segment can be, by GOP, and why that does not settle the player buffer

**2026-08-12, free.** Distilled from the eleven funded arms of `gop-sustain-2026-08-12` and
`gop-floor-2026-08-12`, which were bought for other questions. No new spend.

Every figure the two sittings published was a **median**. A buffer does not drain on the median, so
this is the same data read as a distribution.

## Capture to fetchable, in milliseconds

| GOP | samples | p50 | p90 | p99 | max |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.25 | 221 | 1058 | 1543 | 2845 | **4353** |
| **0.5** | 1681 | **1563** | 1676 | 2517 | **4539** |
| 1.0 | 773 | 2299 | 2625 | 3206 | **3635** |
| 2.0 | 205 | 3881 | 4821 | 5768 | **6667** |

⭐⭐ **The tail is worth far more than the median for planning.** At the shipping profile the median is
1.56s and the worst arrival measured is **4.54s, 2.9x the median**. Anything sized off the median
alone is sized off the wrong number.

⚠️ The 0.25 row is drawn from a sample with **19% of its reads deleted as 404s**, so its tail is
optimistic by an unknown amount. See `gop-floor-2026-08-12.md`. It is shown for shape, not for use.

## ⛔ What this does NOT say, and I nearly said it

The obvious next step looked like comparing the max against `LIVE_SYNC_DURATION_S`, which is 6000 ms,
and concluding that a 2.0s GOP overruns the player's buffer while a 0.5s one does not. **That
comparison is wrong and the code says so:**

```
viewerLatencyMs = totalMs - segmentMs + playerBufferMs      // e2e/src/bench/split.ts
playerBufferMs  = LIVE_SYNC_DURATION_S * 1_000
```

**The buffer is additive to the pipeline, not racing it.** A viewer sits `LIVE_SYNC_DURATION_S`
behind the point where content became fetchable, so a 4.5s arrival and a 6s buffer do not describe a
near miss. They describe a viewer 6s back from a live edge that was itself 4.5s old.

**So nothing here says the buffer can be lowered, and nothing here says it cannot.** The quantity that
would decide it is arrival *jitter* against hls.js's own stall condition, which is a different
measurement and is not in this data.

## What is worth carrying

⭐ **Plan against the tail:** at the shipping profile, budget **4.6s** for a segment to become
fetchable, not 1.6s.

⭐⭐ **The buffer is now the dominant term in what a viewer experiences.** At a 0.5s GOP the pipeline
delivers in 1.56s and the player deliberately sits 6s back, so **roughly four fifths of the delay a
viewer feels is a configured choice rather than a network cost**. That makes it the largest remaining
lever and the one with the least evidence under it.

⛔ **It is also the riskiest to touch.** One stall raises hls.js's latency target and it never lowers
it again, so a buffer cut that is slightly too deep costs a viewer permanently rather than
transiently. `LIVE_SYNC_DURATION_S`'s own doc comment rests on 244 arrivals over four three-minute
runs at a **different segment length**, which this table does not re-validate.

**The measurement that would settle it** is a browser sitting at the shipping profile with
`LIVE_SYNC_DURATION_S` swept, scored on stall count rather than on latency. It is a real experiment
with a real cost, not an inference from what is already bought.
