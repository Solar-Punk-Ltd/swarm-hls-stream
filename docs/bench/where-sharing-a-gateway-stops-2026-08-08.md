# Where sharing a gateway stops working

> ## ⚠️ THE PER-HOST VIEWER FIGURE IS AN EXTRAPOLATION FIVE TIMES PAST THE DATA
>
> The `fixed + marginal` CPU model is fitted on **five concurrency points from one sweep with no
> replicate**, the largest being 128 viewers. Inverting it to `(48 - 1.5 x gateways) / 0.07` gives
> roughly **640 to 685 viewers per host**, which is about **5x beyond anything measured**, and the
> model already overshoots at the low end by 20% (2.6 cores predicted at 16 viewers against 2.17
> measured).
>
> ⛔ **CPU was later shown not to be the binding constraint anyway.** See
> `the-ceiling-is-bytes-not-viewers-2026-08-08.md`: the knee is a **byte rate**, with a plateau at
> 43-44 MB/s, and 128 viewers hold where 192 fail.
>
> ⭐ Treat the capacity line below as a shape, not a planning number.

**2026-08-08, 11:14 to 11:18 UTC.** Six arms on an unfunded gateway, concurrency alternated
**1, 32, 1, 64, 1, 128**, every viewer walking the same 100 references at the same moment. **Cost:
nothing**, because a node with no chequebook cannot spend.

[The 1-to-16 sweep](sixteen-viewers-cost-what-one-costs-2026-08-08.md) found viewers sharing a
gateway's fetches almost completely and asked where that stops. This is where.

## ⭐⭐ The knee is at 128, and it is the segment budget that finds it

| viewers | fetches | MB | seconds | median | p90 | **over 267ms** | **MB/s** |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 100 | 9 | 15 | **78ms** | 239ms | **7.0%** | 0.6 |
| **32** | 3,200 | 300 | 24 | **118ms** | 544ms | **24.4%** | **12.5** |
| 1 | 100 | 9 | 15 | **71ms** | 247ms | **5.0%** | 0.6 |
| **64** | 6,400 | 600 | 25 | **141ms** | 445ms | **17.8%** | **24.0** |
| 1 | 100 | 9 | 13 | **80ms** | 233ms | **2.0%** | 0.7 |
| **128** | 12,800 | 1,201 | 36 | **248ms** | 685ms | **45.1%** | **33.4** |

⛔ **At 128 viewers the median segment transfer is 248ms against a 267ms budget.** The typical segment
now barely fits, which is the definition of the ceiling for the shipping profile.

⭐ **Throughput keeps scaling but sublinearly past 64**: 20.8x at 32 viewers, then 1.92x from 32 to 64
(96% efficient), then **1.39x from 64 to 128 (70%)**.

⚠️ **32 and 64 cannot be ranked against each other.** 24.4% late at 32 against 17.8% at 64 is backwards,
and it is well inside the spread an unfunded node shows on identical work (1.9% to 19.5% across eleven
arms in an earlier sweep). **What is not inside that spread is 45.1%.**

✅ **The reference arms held at 78, 71 and 80ms throughout**, so the loaded arms' degradation is the
load and not drift across the sitting.

## ⭐ Sharing holds all the way to 128

| viewers | retrieval operations | **network peer contacts** | **first-peer service** |
| ---: | ---: | ---: | ---: |
| 1 | 2,638 | **3,234** | 17.1% |
| 32 | 70,978 | **4,565** | **95.0%** |
| 1 | 2,638 | **3,214** | 17.0% |
| 64 | 130,853 | **4,584** | **96.3%** |
| 1 | 2,638 | **3,207** | 17.5% |
| 128 | 157,349 | **5,972** | **95.0%** |

⭐ **128 viewers cost the network 1.85x what one viewer costs.** The dedup that made sixteen viewers
free does not break at 128, it only softens.

⭐⭐ **And first-peer service goes UP with concurrency, from 17% to 95%.** An unfunded gateway serving
32 or more concurrent viewers reaches the peer-selection loop for so few of its requests that it looks
better on that metric than a **funded** node serving one (91-93%). The penalty is per distinct chunk,
and sharing spreads it across everyone.

⚠️ **But the per-distinct-chunk skip cost rises under contention**: 21.2 at one viewer, 24.4 at 32,
**48.2 at 64 and 72.8 at 128**. More concurrent requests means more peers hitting their overdraft at
the same moment. That is the mechanism behind the latency curve above.

## ⛔ The CPU model, which corrects the earlier one

The 1-to-16 sweep found bee's CPU roughly flat at 1.4 to 2.2 cores and concluded CPU is a per-node
cost. **That is true only up to about 16 viewers.**

| viewers | bee CPU-cores |
| ---: | ---: |
| 1 | 1.4 - 1.5 |
| 16 | 2.17 |
| 32 | **2.27** |
| 64 | **4.54** |
| 128 | **6.82** |

⭐ **The model is `fixed + marginal`: about 1.5 cores of fixed cost plus about 0.07 cores per viewer.**
That predicts 2.6 cores at 16 against 2.17 measured, and 6.5 at 128 against 6.82. Below 16 the fixed
term dominates, which is why it looked flat.

**So per 48-core host, on CPU alone:** roughly **(48 - 1.5 x gateways) / 0.07** viewers, which for a
handful of gateways is several hundred.

## What this means for a high-scale event

⭐ **Pool 32 to 64 viewers per gateway.** Below that the fixed CPU cost is wasted. Above 64 the
throughput efficiency falls and at 128 the median segment no longer fits the budget.

⚠️ **This is one unfunded gateway at the 0.25s profile.** A **1.0s** GOP has a 1000ms budget, so a
248ms median would sit at a quarter of it rather than at the edge. **The knee is a property of the
budget, not of the node**, and a longer segment moves it.

## ⛔ What this run cannot say

⚠️ **The host was not saturated** (load 13.9 of 48 cores), so the ceiling is not the harness. But 1,201
MB in 36 seconds is **267 Mbps**, and nothing here measured the host's network capacity. **The 128-arm
may be bandwidth-limited rather than bee-limited**, and that is the first thing to check before
treating 128 as a property of bee.

⚠️ **Nothing above 128 was tested**, and the arms are 13 to 36 seconds.

⚠️ **`bee_accounting_accounting_blocks_count` is not retrieval-only.** Bee increments it in exactly one
place, `PrepareCredit`, once per call on overdraft, and **pushsync also calls `PrepareCredit`**
(confirmed in `pkg/pushsync`). A gateway that is not uploading should contribute little from that path,
but the skip figures above include whatever it does contribute.

## Artifacts

`/home/solarpunk/retrieval-probe/conc3/`. Probe: `deploy/scripts/retrieval-debt-probe.sh`. The gateway
was restored to `--swap-enable=true` and `--cache-capacity=0` and confirmed on the node.
