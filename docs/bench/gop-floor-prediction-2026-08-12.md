# Pre-registration: does the GOP win continue below 0.5s?

**Registered 2026-08-12, before spending anything.** Extends `gop-sustain-2026-08-12.md`, which
measured GOP 2.0 / 1.0 / 0.5 and found latency falling monotonically with no sign of a floor.

## Why this is worth broadcast minutes

The open product decision is `DEFAULT_KNOBS.gopSeconds`, currently 2. Today's sweep says 0.5 beats it
on every axis a viewer feels. But **0.5 was the smallest value swept, not a measured optimum**, and
the engine allows smaller: `hls_fragment` is 0.25 and `hls_aof_ratio` is 10, so the valid GOP range
read off the running SRS is **[0.25, 2.5]**.

Changing a shipped default to the lowest value that happened to be in a sweep is the same mistake as
quoting a range's endpoint as a limit. **Either 0.25 wins and the default should be 0.25, or it does
not and 0.5 is confirmed as an operating point rather than an artefact of where the sweep stopped.**
Both outcomes change what gets shipped, which is what makes this worth funding.

⚠️ **The requested 0.25 is really 0.267.** `-g` takes frames, so 0.25s at 30 fps is 7.5 frames and
rounds to 8. `gop-vs-fragment-2026-08-12.md` already measured that pair for free and got 0.267s
segments, replicated to three decimals. Every prediction below is stated against **0.267**.

## Design

Identical to `gop-sustain-2026-08-12` in every respect except the GOP values, **including the
8-minute arm length**, so the two sittings describe one curve rather than two experiments.

| | |
| --- | --- |
| arms | GOP **0.25** and **0.50** at 1280x720, 30 fps, 2500k video + 128k audio |
| arm length | 8 minutes |
| round 0 | `0.5, 0.25` — **discarded by design**, see below |
| round 1 | `0.25, 0.5` |
| round 2 | `0.5, 0.25` |
| counted n | **2 per GOP** |

**Round 0 is warm-up and is thrown away before it is looked at.** The first two arms of the previous
sitting read 48% and 16% low on frame rate for reasons that are still unknown, and the deficit
tracked position in the sitting rather than the GOP. Round 0 runs one arm at each value so neither
gets the contaminated slot, and rounds 1 and 2 reverse order so a residual gradient cannot align with
the axis.

⛔ **n=2, and that is stated up front rather than discovered in the summary.** Latency replicated
within 1% across rounds last time, so 2 is defensible for a two-point comparison on this instrument.
If the two GOPs land inside that 1% of each other, **the honest answer is "no measurable difference"
and not a winner picked from noise.**

## H1 sustain, and this is where it can break

**Both GOPs sustain: media carried per wall second ≥ 0.99.**

⚠️ **The risk is concentrated at 0.25.** Predicted segment size is **125 to 140 KB**, and 90 KB
segments were measured to fill the chunk concurrency window only 4.5%. Nine of nine arms sustained
last time down to 231 KB, so this extends a curve into the region where underfill starts to matter.
**If H1 fails it fails at 0.25, and that alone would settle the product question against it.**

## H2 latency, the decisive one

**Capture to fetchable at GOP 0.267 is 1.19s**, against 1.55s measured at 0.5.

Both available models agree on that number, which is why it is worth registering rather than
hand-waving a direction:

| model | fit | predicts at 0.267 |
| --- | --- | ---: |
| successive halvings | drops of 1.58 then 0.75, so the next is ~0.36 | **1.19s** |
| linear in GOP | `latency = 0.78 + 1.55 x GOP`, from all three points | **1.19s** |

⭐⭐ **The intercept is the more useful number than the slope.** If latency really is `0.78 + 1.55 x
GOP`, then **0.78s is a floor that no GOP reduction can touch**, and it is where the remaining
latency budget lives: upload, feed propagation and fetch. A measured 0.267 arm is what turns that
intercept from a two-point extrapolation into something with a third anchor.

**Refutation condition, stated in advance:** a measured 0.267 latency at or above **1.53s** (inside
the instrument's 1% replication spread of the 0.5 arm) refutes H2 and says the curve has flattened.

## H3 cost: more keyframes, no per-byte premium

**BZZ per MB stays flat**, in the 0.00059 to 0.00068 band measured across the last nine arms. Total
spend rises because the byte rate rises, not because small segments are penalised per byte.

| | predicted at 0.267 | measured at 0.5 |
| --- | ---: | ---: |
| uplink | 4.0 to 4.2 Mbps | 3.77 Mbps |
| BZZ per 8-minute arm | **0.15 to 0.17** | 0.1461 |

## H4 stalls: cannot improve, can only break

**0 of 2 confirmed feed stalls at both GOPs.** The 0.5 arm already reached zero, so this hypothesis
has no upside and exists to catch a regression: if 0.25 stalls where 0.5 did not, underfill is
biting and H1 is failing quietly.

## What this sitting costs, and why the balance decides the design

Priced off the measured 0.000646 BZZ/MB and the predicted uplinks, **not** off summed sample bytes:

| arms | | BZZ |
| --- | --- | ---: |
| 3 x GOP 0.25 | at ~0.16 each | 0.48 |
| 3 x GOP 0.50 | at ~0.146 each | 0.44 |
| | **total** | **~0.92** |

⛔ **That does not fit the 0.8353 BZZ available**, which is why the sitting is not launched on the
chequebook as it stands. Depositing the uploader's own idle **0.532 BZZ** raises headroom to
**1.3673** and leaves roughly **0.45 BZZ of margin** after the sitting, which is enough to absorb a
lost arm. That deposit moves the node's own money and is not new funding.

## ⛔ The floor guard, which did not exist before

The previous sweep read the chequebook around every arm but **never refused to start one**. A sitting
that ran the balance to zero would have kept going and measured credit exhaustion instead of the GOP:
at zero, 64 of 247 uploader peers sat past -9.0e6 debt, and a node that cannot pay is refused service.
That has already cost one sweep 7 of its 12 runs.

`gop-floor-sweep.sh` now refuses to start an arm unless the balance can cover it **and still clear a
0.15 BZZ floor**, using the largest burn measured so far in the sitting as the estimate rather than a
constant. Arms already completed stay valid and the ledger is written as it goes, so stopping early
costs the remaining arms and nothing else.
