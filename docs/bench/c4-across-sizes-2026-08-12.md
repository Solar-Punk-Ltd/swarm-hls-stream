# ⭐⭐⭐ At the concurrency a player uses, segment size buys almost nothing

**2026-08-12.** Free: unfunded in-browser node, references already published, no broadcast. Four
sittings, one per segment size, each carrying its own c1 and c4 arms so the contrast lives inside one
sitting. Canaries from abel-1, whose content nobody is questioning.

**Every sitting: control valid, rounds trusted 2, degraded [], and 100% of fetches inside budget.**

| segment | c1 KB/s | **c4 KB/s** | speedup | c1 p50 | **c4 p50** | in budget |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **405 KB** | 331 | **996** | **3.01x** | 1,193ms | **1,582ms** | 180/180 |
| 794 KB | 463 | **1,251** | 2.70x | 1,703ms | 2,472ms | 180/180 |
| 1,681 KB | 782 | **1,219** | 1.56x | 2,139ms | 5,758ms | 90/90 |
| **3,369 KB** | 1,089 | **1,210** | **1.11x** | 3,073ms | **11,462ms** | 48/48 |

## ⭐⭐⭐ The size penalty is a one-at-a-time artefact

| | smallest to largest |
| --- | ---: |
| spread at **c1** | **3.29x** (331 to 1,089) |
| spread at **c4** | **1.26x** (996 to 1,251) |

**Fetching one segment at a time, a 3.4 MB segment delivers 3.3x what a 405 KB one does. Fetching
four at a time, which is what hls.js does, the whole advantage collapses to 26%.** Four small requests
fill the same pipe one large request fills.

⛔⛔ **So "bigger fragments are strictly better, 4.1x" is withdrawn as a product statement.** It was
measured one fetch at a time and it is true of that. It is not true of a player.

## ⭐⭐ And the latency it costs is brutal, and monotonic

c4 p50 climbs **1,582 → 2,472 → 5,758 → 11,462ms** across the same four sizes. The largest segment
costs **7.2x the per-segment latency of the smallest** and returns **21% more throughput**.

⭐⭐⭐ **The recommendation therefore inverts: prefer small segments.** At player concurrency they
deliver within a quarter of the best throughput available and a fraction of the latency, and latency
is the thing a live viewer feels.

## The ceiling is ~1,200 KB/s and every size reaches it

c4 returns 996, 1,251, 1,219, 1,210. Flat from 794 KB upward, and only 18% below at 405 KB.

⭐ **This replicates yesterday's separate sitting**, which put c4 at **1,134 KB/s** on 787 KB
segments against **1,251** here on 794 KB. Two sittings a day apart, 10% apart, on a live public
network. That is the strongest cross-check available for free.

## What this does and does not settle

⭐ It confirms the standing advice not to raise segment concurrency: c4 already reaches the ceiling at
every size, and the earlier c16 arm bought 4.9% for 3.1x the latency.

⚠️ **The two large sizes ran fewer fetches** (90 and 48 against 180) because their corpora hold fewer
references and the sweep needs untouched ones. Every fetch landed in budget, so nothing was dropped,
but those two rows rest on less data than the small ones.

⚠️ **The c1 column is not directly comparable to the 2026-08-11 size sweep** (244 / 335 / 593 /
1,007 KB/s), which ran on a different day through a different instrument. The within-sitting c1
against c4 contrast is what carries the argument here.

⛔ Nothing here measures **delivery**, only rate. All four sizes delivered everything asked of them, on
content roughly a day old, which is also a decay datapoint: **48/48 at 3.4 MB** is the size that used
to fail 0/5 when the corpus was decaying.
