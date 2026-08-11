# ⭐⭐⭐ A browser node is already at its ceiling at concurrency 4, which is what a player uses

**2026-08-11 evening.** Free: unfunded in-browser node, references already published, no broadcast.
Predictions written first in `concurrency-on-healthy-content-prediction-2026-08-11.md`.

360 references from the shipping-profile broadcast (787 KB segments), arms alternated over 2 rounds,
block 90, canaries from abel-1. **No round was degraded**, and the analysis confirms the control
separated warm from cold (2ms against a 3,800ms cold p50), so the sweep measured network fetches.

| arm | achieved | in budget | **KB/s** | p50 | p90 | occupancy |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **c4** | 3.94 | 180/180 | **1,134** | 2,746ms | 3,413ms | 38.5% |
| **c16** | 15.49 | 177/180 | **1,189** | 8,483ms | 14,737ms | 154% |

## ⭐⭐⭐ Four times the concurrency buys 5%

Going from 4 segments in flight to 16 raises throughput by **4.9%** and costs **3.1x the per-segment
latency**. c16 also starts missing its budget (177/180 against 180/180).

**For a player this settles a design question: do not raise segment concurrency.** hls.js already
fetches four at a time, and four is where the ceiling already is. Everything above it is latency with
no delivery behind it.

## ⭐⭐ The ceiling is about 1,150 KB/s, and it is NOT the chunk semaphore

At c16 the 2,048-chunk semaphore is oversubscribed 1.54x and delivers 4.9% more than c4 at 38.5%.
A semaphore that is 61% idle and a semaphore that is oversubscribed produce the same throughput, so
**the binding constraint is somewhere else**.

⭐ **Two completely different routes to ~40% occupancy agree.** Today's size sweep reached 41% with a
single 3.4 MB fetch and got **1,007 KB/s**. This sweep reached 38.5% with four 787 KB fetches and got
**1,134 KB/s**. Same neighbourhood by two unrelated means, which is the strongest cross-validation
available for free.

## What the pre-registration got right and wrong

| model, written before | predicted c4 | predicted c16 | verdict |
| --- | ---: | ---: | --- |
| occupancy sets throughput, read off the 3.4 MB point | ~1,007 | ~ceiling | ✅ **c4 within 13%** |
| requests are independent | ~1,340 | ~5,360 | ⛔ **refuted**, c16 is 4.5x under |
| the ceiling is already reached at c1 | ~335 | ~335 | ⛔ **refuted**, both over 1,100 |

⛔ **The linear occupancy model is refuted again and harder.** `235 + 8.16 x (occupancy - 4.5)`
predicts **512 KB/s** at 38.5%. Measured **1,134**. The curve saturates near 40% and is flat above it,
which was the competing shape named in this morning's pre-registration.

⚠️ **Reading the c4 prediction off a measured point is not the same as the model working.** What
survives is the empirical curve, not the arithmetic behind it.

## ⛔ The old c16 figure was a floor, and the scoping was right

**410-467 KB/s (n=3)** was recorded for c16 on a starved node and a decaying corpus. On healthy
content the same arm returns **1,189 KB/s**, between **2.55x and 2.90x** higher. The decision to
re-scope those figures as floors rather than delete them was correct.

## What a viewer gets

The shipping profile needs **411 KB/s** (787 KB every 1.917s). A browser node at player concurrency
delivers **1,134 KB/s**, so **2.76x headroom**.

⚠️ **Corrected the same evening: that 411 KB/s is what the deployment host produced, not what the
profile asks for.** It delivered 3.44 Mbps against 6000 kbps requested, where the same encoder
settings locally deliver 6.35. Against a **full-rate** 1080p/6000k stream the requirement is ~775 KB/s
and the headroom is about **1.4x, not 2.76x**. It still sustains, with a much thinner margin. See
`srs-fragment-bracket-2026-08-11.md`. ⭐ The 1,134 KB/s itself is unaffected: it was measured by
fetching real segments and never divided by a duration. That is an independent route to this morning's sustain
result (ratio 0.9996, zero stalls) and it explains the 90-second buffer lead: the node fills far
faster than the stream drains.

⚠️ **This is a bulk fetch sweep, not playback.** It measures what the node can pull, not what a player
experiences, and it says nothing about a funded node. It has no buffer, so the fill-versus-steady
contamination that ruined the earlier 461 and 1,014 KB/s figures cannot arise here.

⭐ **The gateway-less qualifier still applies.** This is the research path, not the shipped product.
