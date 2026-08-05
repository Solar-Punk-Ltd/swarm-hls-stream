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

⚠️ **Those three were taken back to back, and a fourth run of the same configuration an hour later
measured 936ms**, which is 119ms below the lowest of them. So the 29ms is how much three consecutive
runs agree, and it is **not** the width of this configuration.

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

Neither appears at 0.5s, and **they are not the same fact**, which is what two extra runs settled.

| | 0.25s | 0.5s |
| --- | --- | --- |
| segments refused on the first ask | **14.1%, 5.2%, 5.3%**, and 22.6% and 0.0% on two later runs | 1.0%, 0.0%, 0.0% |
| polls spending the whole walk budget | **50%, 53%, ~50%**, and 32 slots on both later runs too | 9%, 9%, ~10% |

The walk depth is the same in **all five** runs, including the one that refused nothing. The refusal
share ranges over the whole interval from zero to a fifth. **One of these is a property of the
configuration and the other is a property of the afternoon**, and reading them as one thing is what a
single sweep would have licensed.

**Refused is not lost.** Every one of the thirteen refs the first run refused answered 200 when asked
again twenty minutes later, and all 21 refusals across the six runs are 404s with zero unusable
segments.

⛔ **And the refusal share is not a property of this profile, which took two more runs to find out.**
Five runs of the identical configuration, in order:

| run | refused | capture to fetchable | `fetch` hop |
| --- | ------: | -------------------: | ----------: |
| gate round 1 | 14.1% | 1084ms | 329ms |
| gate round 2 | 5.2% | 1055ms | 300ms |
| gate round 3 | 5.3% | 1081ms | 318ms |
| a run that retried refusals inside the loop | **22.6%** | 1408ms | **492ms** |
| a run an hour after the gate | **0.0%** | **936ms** | **128ms** |

**Zero to 22.6% on one configuration**, and it moves with the `fetch` hop rather than with anything
the profile chooses. So the three gate rows above are three draws from something dispersed, and the
5-14% they suggested was never a rate.

⚠️ **The retry run is the worst of the five and that is the instrument's own doing.** Retrying a
refusal puts more reads on the gateway the run is measuring, the gateway slows, and slower retrieval
is what a 404 here means. Measuring the thing made the thing worse.

⚠️ 0.5s does not fit the same story: its `fetch` hop is **longer** at 438ms and it refuses **less** at
0-1%, so retrieval speed alone does not explain it and the segment rate probably matters. **Unresolved.**

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

**Ten minutes is not an hour.** Nothing here has run longer.

⚠️ **An earlier draft of this file said the refusal share grows with duration**, on the grounds that it
went from 0.0-2.9% at three minutes to 5-14% at ten. A fifth ten-minute run then refused nothing at
all. Three points in one direction were a trend until the fourth and fifth arrived, and the honest
statement is that the share is dispersed and its cause is unresolved.

**Nobody has watched it.** Every figure is the bench's, and browser validation is still blocked.

**One profile, one machine.** 720p 2500kbps on a host that also runs a permanent encode, so the
ambient load is real and constant and has never been varied.
