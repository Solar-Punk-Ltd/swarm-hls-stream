# A viewer's thread creeps while it watches, and joining late is free

**2026-08-14 into 2026-08-15, one live broadcast of 4.2 hours, four counted arms of 40 minutes,
4.565 BZZ.** Task #104.

## The question

Every observation of the in-tab node before tonight was **six minutes long**. A broadcast is hours. A
single-threaded runtime that creeps from 0.23 to 0.9 over an evening is a different product from one
that holds, and nothing measured so far could tell those apart.

## Design

Six arms of **40 minutes** under one live broadcast, 0.5s GOP, 720p 2500 kbps, 2.0s target, order
`AB AB BA`, first round discarded. Each arm is a **fresh browser started later than the last**, which
turns the sitting into two experiments for one price:

- the **slope inside** an arm is what a viewer pays for watching longer
- the **opening window** of each arm is what a viewer pays for **joining** a broadcast already that old

## Result 1: the thread does creep, and it is replicated

Eight equal wall-clock windows per arm, thread fraction:

| arm | cond | windows | slope/hr | host load |
| ---: | --- | --- | ---: | --- |
| 1 | gateway | 0.069 0.075 0.080 0.085 0.091 0.093 0.098 0.103 | +0.056 | 3.29 → 12.85 ⚠️ |
| 3 | gateway | 0.070 0.076 0.083 0.085 0.089 0.096 0.098 0.101 | **+0.052** | 9.45 → 9.67 |
| 6 | gateway | 0.073 0.078 0.081 0.083 0.091 0.093 0.096 0.101 | **+0.046** | 8.88 → 8.07 |
| 2 | weeb3 | 0.219 0.228 0.224 0.229 0.239 0.237 0.237 0.246 | +0.040 | 9.97 → 10.39 |
| 4 | weeb3 | 0.229 0.221 0.230 0.232 0.230 0.244 0.238 0.237 | **+0.024** | 8.55 → 7.58 |
| 5 | weeb3 | 0.230 0.217 0.220 0.239 0.225 0.233 0.238 0.238 | **+0.027** | 7.24 → 8.18 |

Counted arms in bold. **Gateway +0.049/hr, weeb3 +0.026/hr.** Sitting 1's seven-minute arms are the
control and show nothing at all (gateway slopes +0.001, +0.042, +0.007), which is exactly why the long
arms were booked.

### ⭐⭐⭐ The host-load confound, and why it is dead

Arm 1's host load ramped 3.29 → 12.85 inside its own window, so its +50% is contaminated and is **not
quoted**. Two independent facts kill the confound:

1. **Arm 2 ran at flat load (9.97 → 10.39) and climbed anyway.**
2. **Arms 1 and 3 lie on top of each other window by window, to within 0.003**, and one ran through
   the ramp while the other did not. Had the ramp driven arm 1, they could not agree.

⚠️ Load never exceeded 13 of **48 cores**, so nothing here was starved.

## Result 2: ⭐⭐⭐ joining a long broadcast is FREE

Opening window of each arm, which is a fresh viewer joining at that broadcast age:

| cond | joins at | join cost |
| --- | ---: | ---: |
| gateway | 83 min | 0.070 |
| gateway | **209 min** | **0.073** |
| weeb3 | 125 min | 0.229 |
| weeb3 | **167 min** | **0.230** |

**Flat.** A viewer joining a broadcast that has run three and a half hours starts where an opening
viewer does. **The cost is per SESSION, not per broadcast.**

⛔⛔ **This refutes the mechanism this sitting was designed around.** The hypothesis was hls.js
re-parsing a playlist that never trims, which predicts a late joiner inherits the history and starts
high. It does not. The manifest carries a ~25.5s live window, so a joining viewer gets a short one
whatever the broadcast age. What survives is the client's **own** accumulated state, which is empty for
every new viewer.

⚠️ **A trap worth naming.** Including the warmup arms makes the join cost look like it trends upward
(gateway 0.069 → 0.070 → 0.073, weeb3 0.219 → 0.229 → 0.230). Both warmup arms are the LOW anchors,
and warmup arms are discarded precisely because the first arms of a sitting run differently. The
"trend" is the warmup effect wearing a broadcast-age costume.

## Result 3: the gateway path drifts about twice as fast, and the heap does not explain it

| cond | slope/hr | over 41 min | **heap floor Δ over 41 min** |
| --- | ---: | ---: | --- |
| gateway | +0.049 | +0.031 | +7.9, +7.4 MB |
| weeb3 | +0.026 | +0.017 | +8.2, +8.7, +7.8 MB |

⭐ **The heap accumulates identically in both conditions while the CPU drift differs 1.9x.** The same
amount of state is retained; the gateway path pays roughly twice as much to carry it. ⛔ **No mechanism
is offered here**, because none is established. The heap floor is read as the minimum of each quartile
rather than first-to-last, since a garbage-collected heap read at its endpoints gave the opposite sign.

⭐ Two internal checks agree: off-main falls in the long arms (gateway 0.800 → 0.771, weeb3 0.651 →
0.639), more for the gateway; and the condition ratio narrows **3.12x on six-minute arms to 2.66x on
41-minute arms**, because the gateway baseline is the one climbing.

## Result 4: nothing broke, and the economics got better

| arm | cond | retrievals | cores | thread | thrPeak | stalls | behind live |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | gateway | 232,002 | 1.22 | 0.087 | 0.129 | 0 | 2.46s |
| 6 | gateway | 232,585 | 1.22 | 0.087 | 0.152 | 0 | 2.55s |
| 4 | weeb3 | 7,677 | 1.85 | 0.233 | 0.553 | 0 | 2.86s |
| 5 | weeb3 | 7,784 | 1.83 | 0.230 | 0.534 | 0 | 2.42s |

**Zero stalls across all six arms, which is 4.1 hours of continuous playback**, and the three gateway
arms read 0.087 to three decimal places. ⭐ **The retrieval saving is 30.0x on 40-minute arms against
23.4x on six-minute ones**, so the in-tab advantage is understated by short arms.

## ⚠️ The extrapolation, labelled as one

Straight lines from the measured slopes, which is **not** a claim that the drift stays linear past
41 minutes:

| watching for | gateway | weeb3 |
| ---: | ---: | ---: |
| 1h | 0.119 | 0.256 |
| 4h | 0.266 | 0.334 |
| **7h** | **0.413** | **0.412** |
| 10h | 0.560 | 0.490 |

**They cross at about seven hours.** Past that the gateway path would cost more main thread than the
in-tab one. ⛔⛔ **Extrapolated from a 41-minute window and worth exactly what that is worth.** It is
written down because it is cheap to test: one arm of three hours settles whether the slope holds,
decays, or bends up.

## What this does not say

⛔ Neither path approached saturation. The worst single window in the sitting is 0.246 of one thread
mean, peaks reached 0.553. ⛔ 720p only, n=2 counted arms per condition, one broadcast, one machine.
⛔ The latency column still cannot rank the conditions, every arm 2.42-2.86s behind a 2.0s target.

## Cost

**4.565 BZZ** over 253 minutes: uploader 3.266 (0.77 BZZ/hr), gateway 1.300 (0.31 BZZ/hr). Postage
`7849851f` 297 → 317 of 512 buckets, TTL 9.2 days. Both chequebook floors and the 75% postage line were
armed and sampled every 30s and neither was approached.

## Provenance

`~/overnight/2026-08-14-night/long-arms-drift/` on the deployment host: per-arm `*-mainthread.jsonl` at
493 readings each, `*-cpu.txt`, node-metrics snapshots either side of every arm, and whole-surface
diffs. Run unattended by `overnight-chain.sh`, which recorded both sittings `ok`.
