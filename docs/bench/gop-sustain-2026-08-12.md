# ✅✅✅ A small GOP wins a live broadcast, and the price of it is 19% more BZZ

**2026-08-12, funded.** Nine `bench:longrun` arms on the deployment, GOP 0.5 / 1.0 / 2.0, three
rounds with the arm order rotated each round, 8 minutes each at 720p30 / 2500k. Bitrate, size and
frame rate held constant, so only the segment boundary moved. Predictions registered in
`gop-sustain-prediction-2026-08-12.md` before spending. **Total 1.0123 BZZ.**

⛔ **Arms 1 and 2 are excluded from every figure below.** They are the first two arms of the sitting
and they are contaminated. See the warm-up section, which is the most transferable thing here.

| GOP | segment | capture to fetchable | behind live | uplink | BZZ per 8 min | confirmed stalls |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **0.5** | **231 KB** | **1.55, 1.54s** | **6.47, 5.69s** | 3.77 Mbps | 0.1461 | **0 of 3** |
| 1.0 | 406 KB | 2.31, 2.29s | 6.60, 6.93s | 3.31 Mbps | 0.1147 | 1 of 3 |
| **2.0** | **819 KB** | **3.89, 3.87, 3.88s** | 9.76, 9.16, 10.55s | 3.36 Mbps | 0.1224 | **3 of 3** |

⭐⭐ **Latency replicates within 1% at every point**, across rounds run in different orders. That is
the tightest replication this instrument has produced.

## The decision, quantified

Going from a 2.0s GOP to a 0.5s GOP:

| | |
| --- | ---: |
| capture to fetchable | **2.34s better** (3.88 → 1.55) |
| behind live | **3.74s better** (9.82 → 6.08) |
| confirmed feed stalls | **3 of 3 → 0 of 3** |
| uplink bandwidth | 12% more (3.36 → 3.77 Mbps) |
| **BZZ** | **19% more** (0.1224 → 0.1461 per 8 min) |

The extra bytes are keyframes: four times as many of them, and a keyframe is far larger than a
predicted frame. So **a small GOP is not free, it is cheap.** 19% more spend buys 2.34s of latency,
3.74s of live delay, and the difference between three stalls and none.

⭐⭐⭐ **This confirms `c4-across-sizes-2026-08-12.md`'s "prefer small" from the other direction.** That
one measured fetching content that already existed and could not see the publish side at all. This one
publishes, and small still wins.

⭐ **And `gop-vs-fragment-2026-08-12.md` is what makes it actionable**: the segment length is
`ceil(fragment / GOP) * GOP`, so **the knob is `gopSeconds`**. At the deployment's `hls_fragment 0.25`,
lowering `HLS_FRAGMENT` does nothing at all.

## ⛔⛔⛔ The warm-up, which impersonated the effect being measured

Round 1 ran ascending GOP and produced a clean monotonic curve: frame rate **15.69 → 25.26 → 30.01**
and bitrate **1.59 → 2.56 → 3.65 Mbps**, exactly the shape a "small segments throttle the publisher"
story predicts. It is not real.

| GOP | fps across the three rounds |
| ---: | --- |
| 0.5 | **15.69**, 29.97, 30.05 |
| 1.0 | **25.26**, 30.00, 29.98 |
| 2.0 | 30.01, 29.98, 30.01 |

**The only sub-nominal readings in nine arms are arms 1 and 2.** The deficit tracks position in the
sitting, not the GOP: arm 1 was 48% short, arm 2 was 16% short, and every arm from the third onward
sits at 30 fps whatever its GOP. GOP 2.0 never ran inside the contaminated window, which is why its
three readings are identical.

⭐⭐⭐ **The rotation is the only reason this was caught.** Round 1 alone would have produced a
publishable curve with a plausible mechanism attached. Two mechanisms were in fact proposed and both
were withdrawn: the uploader's `on_hls` path, and encoder CPU. The uploader logged **zero** errors,
warnings, retries or timeouts across the contaminated arm, and the CPU sampler that appeared to
support the second one had started three arms too late and was reading a different arm entirely.

⚠️ **The cause of the warm-up is unknown and is not claimed here.** The nearest candidate is that an
earlier arm was killed mid-publish about a minute before arm 1 started, leaving the uploader mid-stream.
That is an association, not a mechanism. **The operational remedy does not need the cause: discard the
first two arms of a sitting, or rotate the order so a warm-up gradient cannot align with the swept
axis.** See `swarm-hls-gate-lesson` AGS and AHB.

## H1 confirmed: every arm sustains

Media carried per second of wall clock ranged **0.9967 to 1.0071** across all nine, and timeline
travel **0.9993 to 1.0034**. Small segments do not break sustain, which was the specific risk: they
underfill the chunk semaphore that binds, at roughly 56 chunks against 200 for the 2.0s arm.

## H2 confirmed, and it is the whole result

Latency falls monotonically and replicates within 1%. ⭐ Note that **it is not simply one segment's
worth**: the gap from 2.0 to 0.5 is 2.34s where the segment duration differs by 1.5s, so there is
about 0.8s of additional benefit beyond the segment itself.

## H3 confirmed: cost is per byte, with no GOP premium

| | BZZ/MB |
| --- | ---: |
| across all nine arms, 1,470 MB published | **0.000589** |
| the recorded cost model | 0.000678 |

The model is 13% conservative. ⚠️ **The apparent 3x outlier in one arm was an instrument artefact**: the
bench measures a subset of segments, so summed bytes are *fetched* bytes rather than *published* ones,
and that arm covered only 33% of its run. Cost per byte must be computed against published bytes,
which is bitrate multiplied by run duration.

## Planning figures this establishes

| | |
| --- | --- |
| uplink | **1.29x (video + audio) kbps**, measured 3.39 Mbps mean for a 2500k + 128k request |
| segment size | `uplink_Mbps × 125 × GOP_seconds` KB |
| total bytes | `uplink_Mbps × 60 × minutes / 8` MB |
| chequebook | `total_MB × 0.0006` BZZ |
| postage | ~1 utilization unit per 370 MB on a depth-24 batch |

At 720p/2500k that is **0.90 BZZ per broadcast hour**. At 1080p/6000k, **2.10 BZZ per hour**, which
cross-checks against the independently recorded 0.037 BZZ/min at n=3.

## What this does not say

⛔ **One deployment, one bitrate, one resolution, one gateway-fed viewer.** The 1080p figures above are
extrapolated by bitrate ratio, not measured.

⛔ **Segment duration and segment bytes are confounded.** At fixed bitrate they move together, so
nothing here separates them. Doing that needs a bitrate sweep crossed with a GOP sweep.

⚠️ **The 61.05s stall in one 2.0s arm began 0.1 minutes into the run**, so it is a startup event rather
than a steady-state one, and it is n=1. The stall *ordering* rests on the confirmed counts, 0 of 3
against 3 of 3, not on that one number.

⚠️ The GOP range is capped at 2.0 by `hls_fragment * hls_aof_ratio` = 2.5s. Larger segments need a
redeploy, and the sweep now refuses arms outside that range before spending.
