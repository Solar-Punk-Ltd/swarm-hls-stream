# ⭐⭐⭐ `HLS_FRAGMENT` is not the knob that sets our segment length. The GOP is.

**2026-08-12, free and local.** Twenty arms, two rounds, arm order reversed in the second. Stock
`ossrs/srs:6` against a minimal config, so a result here implicates SRS rather than our template.
Predictions registered in `gop-vs-fragment-prediction-2026-08-12.md` before any arm ran. Rows in
`gop-vs-fragment-2026-08-12.json`.

**Every paced arm replicated to three decimals, and every one was rigid at min = max.**

| `hls_fragment` | GOP | round 1 | round 2 | ratio to fragment | segments are |
| ---: | ---: | ---: | ---: | ---: | --- |
| 0.25 | 0.25 | 0.267s | 0.267s | 1.07x | 1 GOP |
| 0.25 | 0.5 | 0.500s | 0.500s | 2.00x | 1 GOP |
| 0.25 | 1.0 | 1.000s | 1.000s | 4.00x | 1 GOP |
| **0.25** | **2.0** | **2.000s** | **2.000s** | **8.00x** | **1 GOP, the pair we ship** |
| 1.0 | 0.5 | 1.000s | 1.000s | 1.00x | 2 GOPs |
| 1.0 | 1.0 | 1.000s | 1.000s | 1.00x | 1 GOP |
| 1.0 | 2.0 | 2.000s | 2.000s | 2.00x | 1 GOP |
| 2.0 | 1.0 | 2.000s | 2.000s | 1.00x | 2 GOPs |

## The rule, confirmed on all sixteen paced readings

**`median = ceil(fragment / GOP) * GOP`.** SRS cuts at the first keyframe **at or after** the fragment
boundary. Where the GOP is longer than the fragment, one GOP is already past the boundary and the GOP
alone decides. Where it is shorter, the fragment rounds up to a whole number of GOPs.

The 0.267s row is the same rule, not an exception: `-g` takes **frames**, so a 0.25s GOP at 30 fps
rounds to 8 frames and 8/30 = 0.267.

⛔⛔ **This kills "a GOP equal to the fragment doubles the segment"**, recorded in
`swarm-hls-srs-fragment-rule` and repeated in `live-shipping-profile-prediction-2026-08-11.md`. Three
separate equal pairs were run here and none doubled: 0.25/0.25 gave one GOP, 1.0/1.0 gave one GOP, and
2.0/1.0 gave exactly two. That claim came from a single live configuration and it does not survive a
bracket.

## ⭐⭐⭐ The product consequence

At the pair we ship, **the delivered segment is 8x the configured fragment, and it is 8x precisely
because the GOP is 8x.** `HLS_FRAGMENT` is doing nothing at 0.25 and has not been doing anything for
as long as `DEFAULT_KNOBS` has set `gopSeconds: 2`.

`c4-across-sizes-2026-08-12.md` concluded that a live viewer wants **small** segments, because across
an 8.3x size range throughput varies 1.26x while per-segment latency varies 7.2x. **The knob that
delivers that is `gopSeconds`. Lowering `HLS_FRAGMENT` will not do it.**

⛔ And there is a ceiling on the other side. SRS force-closes a segment at
`hls_fragment * hls_aof_ratio` whether a keyframe arrived or not, so the GOP has a valid range of
`[fragment, fragment * ratio]`. The deployment's 0.25 and 10 put that at **[0.25, 2.5]**. A GOP above
2.5 there yields segments mostly carrying no keyframe. See the correction in
`gop-sustain-prediction-2026-08-12.md`, where a 4.0s arm was queued and stopped after one arm.

## ⛔ H3 was refuted, and the refutation was mine rather than the finding's

**Registered claim:** the wallclock-stamped recipe would collapse toward the fragment locally, because
`segment-stretch-2026-08-12.md` records that stamping defeats ffmpeg's `realtime` filter and the
encode runs flat out.

**Measured:** the stamped arm paced at a true **30.0 fps** and returned **2.000s twice**, identical to
the paced arm on the same pair.

| recipe | output | achieved fps | n |
| --- | --- | ---: | ---: |
| generated stamps | null sink | 30, 30, 30, 30 | 4 |
| **wallclock stamps** | **null sink** | **882, 427, 568, 418** | 4 |
| wallclock stamps | SRT into SRS, loopback | **30.0, 30.0** | 2 |

⭐⭐ **Both are true, and together they say something sharper than either alone.** The `realtime`
filter really does fail to brake the stamped recipe. What paces it in practice is **the downstream
socket**. On loopback that socket drains fast enough to hold exactly 30 fps, which is why the stamped
arm here is indistinguishable from the paced one.

⭐⭐⭐ **So the publisher's frame rate is the network path's rate, by construction.** Across the
internet the socket is slower, the publisher slows with it, and because the timestamps are wall time
the slowdown is written straight into the media timeline. That is exactly the contrast
`segment-stretch-2026-08-12.md` measured: unstamped returned 1.052s three times over the internet
while stamped returned six values from 1.356 to 2.674.

**Nothing in that document changes. My prediction was wrong, not its finding**, and the error was
forgetting that loopback drains fast enough to sustain the nominal rate.

## Transport is not the story

`bench-nostamp`, which is SRT and MPEG-TS with a generated timeline, returned **2.059s and 2.056s**
against the paced RTMP arm's 2.000s on the same pair. So SRT adds a little jitter, visible as a
2-2.133 spread against a rigid 2-2, and changes nothing about which knob binds.

## What this does not say

⛔ **Loopback only.** `swarm-hls-gate-lesson` AGX: a local reproduction of a distributed fault is a
different experiment. The paced arms should be immune, since pacing is what makes the timeline
independent of the socket, but that is an argument rather than a measurement.

⛔ Nothing here measures delivery, retrieval, cost or what a viewer experiences. It reads `#EXTINF`
out of a playlist. Whether the small GOP this recommends actually sustains a broadcast is
`gop-sustain-prediction-2026-08-12.md`, which spends.

⚠️ One frame rate, one resolution, one bitrate. The rule is arithmetic on frames and should not care,
but it was not varied.
