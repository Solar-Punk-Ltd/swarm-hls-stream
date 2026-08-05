# The quarter second, gated at ten minutes

**2026-08-05. Six 10-minute runs, two configurations, three interleaved rounds with the order reversed
on even rounds. 532 samples, 6 of 6 passed the axis guard.**

The screening figure was taken over three minutes, which is enough to reproduce a median and
[not enough for the tail](./quarter-second-2026-08-05.md). This is the same comparison run for ten
minutes each, against a deployment carrying the byte-budgeted live window rather than the
ten-segment one the screening ran on.

## It holds

| GOP       | run 1 | run 2 | run 3 |     mean |   spread |
| --------- | ----: | ----: | ----: | -------: | -------: |
| **0.25s** | 1055 | 1081 | 1084 | **1074ms** | **29ms** |
| 0.5s      | 1502 | 1507 | 1596 |   1535ms |     94ms |

**A 29ms spread across three ten-minute runs is the tightest repeatability this project has
measured.** The screening figure was 1.00-1.06s and the gate says 1.074s, so it did not move.

**No run drifted.** Every one of the six has `msPerMinute` below its own `scatterMsPerMinute`
(12/182, 117/144, 6/110, 32/126, 59/139, 95/188), which is this project's own rule for when a trend is
not readable. Ten minutes of continuous broadcast does not degrade either configuration.

⚠️ **The gap narrowed.** Three minutes suggested about 650ms between the two; ten minutes says
**462ms**. The ordering holds and the advantage is real, and it is smaller than the screening claimed.

The per-hop split, averaged over three runs each:

| hop               |  0.25s |   0.5s |      delta |
| ----------------- | -----: | -----: | ---------: |
| segment           |  266ms |  500ms | **−234ms** |
| upload            |  243ms |  271ms |      −28ms |
| manifestPublish   |  196ms |  228ms |      −32ms |
| feedPropagation   |   48ms |   64ms |      −16ms |
| fetch             |  316ms |  438ms | **−122ms** |

Same two movers as the screening: waiting for a segment to close, which is the GOP by definition, and
retrieving half as many bytes.

## The encoder behaved, which is new

**30.0 to 30.1 delivered fps in all six runs**, and 419-433 kB/s of media throughout. The publisher
throttle that [cost a third of the screening sweep](./publisher-backpressure.md) did not appear once.
6 of 6 usable against 4 of 6, and this is the first sweep whose reports carry `segmentBytes`, so the
absence is read off the byte rate rather than inferred.

## What the 0.25s profile pays

Both of these are the same fact seen from two ends, and neither appears at 0.5s.

| | 0.25s | 0.5s |
| --- | --- | --- |
| segments refused on the first ask | **14.1%, 5.2%, 5.3%** | 1.0%, 0.0%, 0.0% |
| polls spending the whole walk budget | **50%, 53%, ~50%** | 9%, 9%, ~10% |

**Refused is not lost.** Every one of the thirteen refs the first run refused answered 200 when asked
again twenty minutes later, and all 21 refusals across the six runs are 404s with zero unusable
segments. Segments upload `deferred: true` while the manifest naming them is a synchronous SOC write,
so the announcement outruns the bytes. hls.js retries a fragment six times starting at one second, so
whether a viewer notices depends entirely on how long the wait is, **which is still unmeasured**.

**The reader has no headroom left.** A slot read costs about 265ms and a 0.25s GOP writes 3.76 slots a
second, so `MAX_WALK_PER_READ = 32` is spent on half the polls. The pace check cannot see this,
because a reader at the bound has exactly the right rate: it walks 32 while the publisher writes 32.
Samples stayed fresh, `feedPropagation` at 48ms, so the figures above stand. There is nothing left for
a faster publisher or a slower gateway.

Both trace to four segments a second against a pipeline whose per-segment costs are near their
budgets: the segment queue runs at **89% duty** at 0.25s against 55% at 0.5s.

## The buffer, re-derived on ten-minute data

| GOP   | worst edge-to-fetchable | plus poll and margin |
| ----- | ----------------------: | -------------------: |
| 0.25s |                   2.40s |                3.65s |
| 0.5s  |                   2.45s |                3.95s |

`LIVE_SYNC_DURATION_S = 6` covers the worst of them by **2.05s**, so the value survives its second
re-derivation of the day, now on runs three times longer. The live window holds 9.0s at 0.25s on this
deployment, so the target is reachable.

## What this does not say

**Ten minutes is not an hour.** Nothing here has run longer, and the one quantity that plainly grows
with duration is the refusal share, which went from 0.0-2.9% at three minutes to 5-14% at ten.

**Nobody has watched it.** Every figure is the bench's, and browser validation is still blocked.

**One profile, one machine.** 720p 2500kbps on a host that also runs a permanent encode, so the
ambient load is real and constant and has never been varied.
