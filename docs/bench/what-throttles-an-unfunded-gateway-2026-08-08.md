# What actually throttles an unfunded gateway

**2026-08-08, 05:54 to 06:07 UTC.** Six arms on `latbench`, interleaved L/U/L/U/L/U, each retrieving
the **same 800 segments in the same order** through the same node, differing only in whether that node
could pay for them.

This is the term [the shipping-profile report](ultra-light-at-the-shipping-profile-2026-08-08.md)
closed on. It found an unfunded gateway 2 to 4x slower with no mechanism, and ruled out three
candidates from the node's own samples: 134 peers and a 135-node neighbourhood in every arm funded or
not, `/health` in 1ms throughout, and host load that moved the wrong way.

**It cost 0.184 BZZ and thirteen minutes**, against roughly 1.3 BZZ and two and a half hours for a
sitting, because it needs no broadcast at all. See [what it does not measure](#what-this-cannot-say).

## The mechanism, and it is unanimous

| round | arm | median | p90 | wall clock | debt carried, before → after |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | L funded | 39ms | 58ms | 66s | -344.6M → -436.0M, **grew 91M** |
| 1 | U unfunded | 102ms | **522ms** | 192s | -375.8M → -979.8M, **grew 604M** |
| 2 | L funded | 36ms | 49ms | 69s | -945.7M → -679.8M, ✅ **settled 266M** |
| 2 | U unfunded | 117ms | 243ms | 159s | -647.0M → -1367.8M, **grew 721M** |
| 3 | L funded | 37ms | 56ms | 64s | -1267.1M → -849.6M, ✅ **settled 417M** |
| 3 | U unfunded | 106ms | **493ms** | 188s | -849.6M → -1328.1M, **grew 479M** |

All figures in PLUR. Every arm moved 74.4 MB.

⭐ **A funded node settles what it owes and an unfunded one cannot.** Across three unfunded arms doing
identical work the debt grew every time, by 604, 721 and 479 million. Across three funded arms it
**fell** in two of them and grew in the third by a sixth as much. Nothing else in the six arms differs.

⭐ **The tail is far worse than the median, and no live sitting has ever reported it.** The median is
**2.9x** (37.3 against 108.3ms) and p90 is **7.7x** (54.3 against 419.3ms). A player's buffer is
drained by the slow segment, not by the typical one, so the figure that matters for a stall is the one
that had never been looked at.

## ⭐ Re-read: the median was the wrong statistic all along

The per-segment timings say something the medians hide. **What decides a stall is not how long a
typical segment takes, it is how many segments miss the budget**, and against the 267ms an eight-frame
GOP at 30fps allows:

| arm | median | p90 | **segments over 267ms** |
| --- | ---: | ---: | ---: |
| 1 funded | 39ms | 58ms | **0.0%** |
| 1 unfunded | 102ms | 522ms | **19.5%** |
| 2 funded | 36ms | 49ms | **1.0%** |
| 2 unfunded | 116ms | 243ms | **8.4%** |
| 3 funded | 37ms | 56ms | **0.0%** |
| 3 unfunded | 106ms | 493ms | **17.0%** |

⛔ **The median penalty is 2.9x and the late-segment penalty is 45x**, 0.3% against 15.0%. Every
figure this project has published about ultra-light is a median, so **every one of them understates
the effect by more than an order of magnitude**. One segment in five arriving late is not a slower
stream, it is a draining buffer.

⭐ **It also reframes the open term.** The three unfunded arms differ by 15% at the median and by
**2.3x** in late share (8.4% against 19.5%). Whatever moves between unfunded runs moves the tail, not
the body, so a run-to-run comparison built on medians was never going to see it. The 24% between-night
gap and this within-sitting spread are plausibly the same thing measured badly.

⚠️ **This is a re-read of the same six arms, not a new run.** It costs nothing and it changes no
measurement, only which column is the headline.

## ⛔ An artifact of this probe, found in its own output

**Segment 1 of every arm took 8.2 to 9.9 seconds**, funded arms included. An arm begins with a
container recreate, and bee answers `/health` well before its retrieval path has peers again, so the
first retrieval waits for them. It is present in both arms and is a property of flipping the arm
rather than of either one.

Left in, it moves every maximum, every p99 and every elapsed figure. The median and p90 above are
unaffected, one sample in eight hundred, so the headline results stand. Every table in this report now
excludes it, and the probe discards a warm-up retrieval before it times anything.

⚠️ The **wall clock** column below is my loop rather than the transfer: it carries a `curl` process per
segment, about 40ms each, in both arms equally. Summed transfer time is 33.7s against 143.6s, a
**4.27x** ratio rather than the 2.7x the elapsed column implies.

## The unfunded node saturates in forty seconds and then holds

Sampled every fifty segments through the third unfunded arm:

| segments in | elapsed | debt carried |
| ---: | ---: | ---: |
| 50 | 17s | -829M |
| 100 | 25s | -993M |
| 150 | 33s | -1168M |
| 200 | 43s | **-1247M** |
| 400 | 89s | -1367M |
| 600 | 142s | -1275M |
| 800 | 188s | -1328M |

⛔ **The debt does not grow without bound, it plateaus.** It climbs steeply for about forty seconds and
then oscillates around -1.3 billion for the remaining two and a half minutes. That is the shape of an
allowance being consumed to its limit and then spent at the rate it refills. An unfunded node is not
slowly degrading, it is running against a ceiling it reaches quickly and then stays at.

That has a direct consequence for how any future arm is read: **the first forty seconds of an unfunded
arm are not the same regime as the rest of it**, and a short arm measures the approach rather than the
steady state.

✅ **The transfer times confirm it independently.** Retrievals over a second are essentially absent
from the funded arms (one each, and that one is the warm-up) and in the unfunded arms they **cluster
after about segment 300**, which is roughly a minute in: positions 414 onward in round 1, 296 onward in
round 2, 303 onward in round 3. The debt series and the timings are two views of the same saturation.

## What this does not settle

⚠️ **The 24% between-night difference is still open.** If the throttle follows the debt carried in,
unfunded arms starting deeper should be slower. They are not, in this range: starting at -376M, -647M
and -850M gave medians of 102, 117 and 106ms, with no ordering. Whatever sets the rate is not the
aggregate debt at the start of an arm, so the term the deployment decision turns on survives this run.

⚠️ **The old `pinnedPeers` metric was refuted here and removed.** It counted peers within a tenth of
the deepest debt, on the theory that a ceiling looks like clustering. The deepest debt on this node is
one peer at about -12.5M PLUR that barely moves across arms, with a smooth tail below it, so the metric
was calibrated against a stale outlier. The sum and the median replaced it and both separate the arms
cleanly.

## <a id="what-this-cannot-say"></a>What this cannot say

**These are archived segments, not the live edge.** The 1884 references come from the request log of
the 2026-08-08 unfunded arm and were uploaded hours earlier, so the absolute times here are **not**
viewer latency and must not be quoted as it: funded retrieval ran 37ms here against 57-63ms live.
What is comparable is arm against arm, on identical references in identical order.

**It is retrieval only.** No encoder, no publisher, no upload, no manifest, no player. A viewer's
experience depends on more than the transfer, and nothing here speaks to the rest.

## What it cost, and why so little

| | before | after | spent |
| --- | ---: | ---: | ---: |
| gateway chequebook | 6.8073 | 6.6229 | **0.1844 BZZ** |
| uploader chequebook | 2.3238 | 2.3238 | **nothing, untouched** |
| postage | — | — | **nothing, no uploads** |

The three unfunded arms cost nothing at all, because a node with no chequebook cannot spend. The whole
bill is the three funded control arms reading 223 MB at roughly 0.00085 BZZ per MB.

**This is the cheapest useful measurement this project has made**, and the reason is that it dropped
everything the question did not need. The gateway was restored to `--swap-enable=true` by the EXIT trap
and confirmed on the node afterwards.

## Artifacts

`deploy/scripts/retrieval-debt-probe.sh`, and on the host
`/home/solarpunk/retrieval-probe/run1/` holding `probe.log`, `probe-state.tsv`, `probe-series.tsv` and
the per-arm timing files. References in `/home/solarpunk/phase06/refs.txt`.
