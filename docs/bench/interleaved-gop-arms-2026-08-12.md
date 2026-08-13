# The 0.5s GOP fails 2.6x more chunk retrievals, and not one of them reaches the viewer

**2026-08-12 16:00 to 16:43, task #91.** Eight arms of six minutes, one broadcast each, 720p 2500 kbps,
alternating the OBS default 2.0s GOP against the shipping 0.5s. **Both bee nodes snapshotted either
side of every arm**, sixteen readings, plus a full browser report per arm.

⭐⭐⭐ **This is the only drift-controlled comparison of the two GOPs in the whole series.** The soaks
in `long-broadcast-2026-08-12.md` ran sequentially, 0.5s from 18:31 and 2.0s from 20:36, so every
between-run difference there is confounded with time of night. Here the arms interleave inside
43 minutes.

## The design

| round | first arm | second arm | |
| ---: | --- | --- | --- |
| 1 | 2.0s | 0.5s | **discarded**, warm-up |
| 2 | 0.5s | 2.0s | counted |
| 3 | 2.0s | 0.5s | counted |
| 4 | 0.5s | 2.0s | counted |

Counterbalanced, so a linear drift across the sitting cannot line up with the axis. Round 1 is
discarded under the rule that the first arms of a sitting are not comparable to the rest.

⚠️ **Each arm restarts the publisher**, because the GOP is an encoder setting rather than a runtime
one. That is what makes a GOP comparison cost more than any other axis, and it is why the buffer
target and the gateway URL, which are runtime switches, should be swept against a single broadcast
instead.

## The result: one metric separates, and it is not the one being swept

| | R2 | R3 | R4 | **2.0s** | **0.5s** | rounds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **retrieval failed outright** | 1.80 / 5.00 | 1.80 / 5.10 | 2.20 / 5.10 | **1.93%** | **5.07%** | **3/3** |
| peers asked per request | 1.41 / 1.61 | 1.42 / 1.66 | 1.41 / 1.64 | 1.41 | 1.64 | 3/3 |
| mean retrieval | 39.1 / 32.4 | 30.9 / 29.3 | 37.6 / 31.0 | 35.9 ms | 30.9 ms | 0/3 |
| mean push-sync | 18.5 / 11.8 | 14.2 / 11.3 | 12.8 / 11.8 | 15.2 ms | 11.6 ms | 0/3 |
| segment transfer | 257 / 92 | 214 / 86 | 254 / 89 | 242 ms | 89 ms | 0/3 |
| uploader | 0.62 / 0.76 | 0.65 / 0.77 | 0.67 / 0.81 | 0.65 BZZ/hr | 0.78 | 3/3 |

Cells read `2.0s / 0.5s`. The last column counts rounds in which the 2.0s arm's value was lower.

⭐⭐⭐ **The retrieval failure gap replicates the soaks almost exactly.** They said 1.7% against 4.9%
running sequentially. These arms say **1.93% against 5.07%** running interleaved. Two independent
designs, and the one that could be explained by time of night has been replaced by one that cannot.

**The warm-up round agrees** at 1.80% against 5.20%, so the direction holds in 4 of 4 rounds rather
than 3 of 3.

⚠️ **A sign test at n=3 is worth p=0.25 and settles nothing on its own.** What carries this is that
the within-condition spread is 0.4 points and 0.1 points against a between-condition gap of 3.1, each
rate is computed over roughly 30,000 retrievals, and it replicates a separate sitting.

## ⭐⭐ Not one of those failures reached the viewer

| | 2.0s arms | 0.5s arms |
| --- | ---: | ---: |
| segments the viewer never got served | **0** | **0** |
| viewer-side refusals | 0 | 0, except 3 in one discarded arm |
| buffer stalls | **0** | **0** |
| player's target | **held** | **held** |
| rebuffers, fatal errors | 0, 0 | 0, 0 |
| advance ratio | 1.0037 | 1.0034 |

**A 2.6x difference in outright chunk-retrieval failure produced no difference a viewer could
perceive.** bee retried inside the gateway and served every segment, both ways.

⭐ This is the same shape as the light-versus-ultra-light finding, where an unfunded node's extra
attempts never left the machine. **A node-side rate is not a viewer-side rate**, and the two must not
be quoted for one another.

## Why the small GOP might fail more, which this sitting does not establish

The segments are **173 KB at 0.5s against 688 KB at 2.0s**, exactly the 4x the GOP arithmetic demands.
But chunk retrievals barely move, 31,900 against 29,500, because the total bytes are nearly the same.
**So this is a genuinely higher per-request failure rate, not more requests.**

The leading candidate is the publish race already established in #90: the uploader writes the feed
slot with `deferred:false` and the segment bytes with `deferred:true`, so the reference beats the
bytes by about 100 ms. A 0.5s GOP publishes four times a second where 2.0s publishes once, giving
four times the windows in which a gateway can ask for bytes that have not landed.

⚠️ **The arithmetic is only suggestive.** Four times the publishes produced 2.6x the failures, which
is sub-proportional. Nothing here locates the failures in time, and the viewer's request log cannot
show them because they happen inside the gateway rather than at its edge.

## ⚠️ A neighbour spike landed on one condition, and it did not move the result

Host load on this 48-core box reached **47.22** at the end of round 2's 2.0s arm and was still 43.76
at the start of round 3's 2.0s arm. Roughly four of those were ours.

⛔ **This is a weakness of ABBA counterbalancing that is worth naming.** Alternating `AB / BA / AB / BA`
controls a linear drift, but at every seam between rounds it places two arms of the **same** condition
back to back. A transient event landing on a seam lands entirely on one condition.

**It did not move the headline.** Retrieval failure across the three 2.0s arms was 1.80, 1.80, 2.20,
and the highest reading is the arm with the *lowest* load. Push-sync did move: 18.5 ms in the loaded
arm against 12.8 and 14.2. ⭐ So the instrument separates a load-sensitive metric from a
load-insensitive one, which is a small piece of evidence that the failure rate is real.

The fix for the next sitting is to break the seam, either by randomising within rounds or by running
`AB / BA / BA / AB`.

## ⭐⭐ Zero stalls in eight arms, which is the case for long exposure

Every arm held its latency target, raised it by 0.00s, and recorded no stall. The two soaks caught
**one stall in six hours**, and that one cost a permanent second.

**Six-minute arms cannot answer a question about stalls.** They have the statistical power to separate
a 5% rate from a 2% one over 30,000 events, and none at all to separate one rare event from zero. Any
claim about stalling, buffer cushions or the ratchet needs hours of exposure, and no amount of arm
count substitutes for it.

⭐ The end-of-arm target is still the right readout when the exposure is there. It read `held, raised
by 0` in all eight arms, so it is not noisy. It integrates every stall that ever happened and never
falls back.

## What this does not answer

- **Duration and size are changed together.** A 0.5s GOP means 173 KB segments here. This sitting
  cannot say which of the two the failure rate follows, which is exactly task #84.
- **Where the failures are.** Nothing locates them at the live edge rather than spread through the
  window, so the publish-race explanation is a hypothesis with supporting arithmetic.
- **Whether it ever matters.** It did not here, on a funded light gateway with caching on. An
  unfunded gateway has less retry headroom, and that is the sitting to run next.

## Ledger

| | |
| --- | ---: |
| arms | 8 of 6 min, 6 counted |
| broadcast | 48.1 min |
| uploader | **0.5650 BZZ** |
| gateway | **0.4651 BZZ** |
| postage | 199 → 205 of 512 |
| node-metric readings | **16**, plus one pair for the sitting |
| instrument | sound in 8 of 8 arms |
