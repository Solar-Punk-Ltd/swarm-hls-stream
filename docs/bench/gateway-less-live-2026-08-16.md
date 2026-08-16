# A viewer with no gateway at all, on a live broadcast

**2026-08-16, one broadcast of 88 minutes at 1280x720 / 2500 kbps / 0.5s GOP.** Eight arms of eleven
minutes, alternating two viewers, round one discarded, **three counted per condition**. Artefacts at
`/home/solarpunk/byte-source-arms/gatewayless-20260816-095727`, driver
`ARM_PAIR=gateway-less bash deploy/scripts/byte-source-arms.sh`.

**Cost 1.267 BZZ** against a gate model of 2.962, because the model prices a gateway that half the
arms never ask.

## What the two conditions are

| | |
| --- | --- |
| **native** | weeb-3's own published page. Feed, manifest and segments all from the Swarm node in the tab. |
| **weeb3** | our client. Segments from the in-tab node, feed and manifest from a bee gateway. |

⚠️ **The contrast moves two things**, whose page and player, and whether a gateway serves the
manifest. It bounds what going fully gateway-less costs. It does not isolate either one.

⭐ The gateway ran **funded, warm and at 134 peers throughout both conditions**, deliberately. A
broke bee node answers `/health` in 1.1ms with 134 peers while viewers go 0.1% to 10.6% late, so a
zero read against a dead gateway would be an alibi rather than a result.

## Result 1: it works, and the gateway is provably untouched

| arm | condition | **gateway retrieval requests** | drift over 11 min | realtime |
| ---: | --- | ---: | ---: | ---: |
| 3 | native | **0** | +0.44s | 1.00 |
| 6 | native | **0** | +0.54s | 1.00 |
| 8 | native | **0** | +0.79s | 1.00 |
| 4 | weeb3 | 2,346 | −1.03s | 1.00 |
| 5 | weeb3 | 2,452 | −0.60s | 1.00 |
| 7 | weeb3 | 2,563 | −0.56s | 1.00 |

**Zero overlap, read off the gateway's own counters.** Gateway spend across the whole sitting,
including four hybrid arms, was **0.0070 BZZ**.

⭐ **Drift is the honest column here, and it is the same statistic on both viewers**: wall seconds
elapsed minus media seconds played. It needs no agreement about where the live edge is, and the
origin offset cancels, which matters because the two players do not share one.

## Result 2: ⛔⛔⛔ IT DOES NOT JOIN AT THE LIVE EDGE, IT STARTS AT THE BEGINNING

| arm joined, into the broadcast | measured lag behind production | difference |
| ---: | ---: | ---: |
| 86.2s | 64.5s | 21.7 |
| 1,555.7s | 1,532.8s | 22.9 |
| 3,788.8s | 3,765.9s | 22.9 |
| 5,313.3s | 5,290.7s | 22.6 |

**A constant 22.5 ± 0.6 seconds across a 62-fold range of elapsed broadcast.** The lag is simply how
late the viewer joined. The constant is the offset between the catalog announce and media position
zero, which nothing here measures and which cancels in every comparison below.

Our own client, running **the same hls.js** against the same broadcast, sat **2.02s behind live**
(median across three counted arms, 1.79 to 2.04).

⭐ The mechanism is bounded by one fact from our own source: the uploader's live manifest is a
**byte-budgeted trailing window**, so it cannot contain the start of an 88-minute broadcast. A viewer
that begins at media position zero is therefore **not positioning from that manifest**. ⚠️ What it
does instead is an inference, not a measurement: reading the feed as an ordered sequence from index 0
would produce exactly this. Confirming it means reading weeb-3's bundle, which is free and not done.

⛔ **So "can a gateway-less viewer hold a live edge" has two answers.** It sustains live-rate delivery
indefinitely with no gateway. It does not currently start at the edge, so as shipped it is a
from-the-beginning viewer. On a three-hour broadcast a viewer opening it is three hours behind.

## Result 3: ⭐⭐⭐ THE MAIN THREAD COST GROWS WITH THE BROADCAST, AND THE CONTROL DOES NOT

The ceiling that matters for weeb-3 is a single JS thread.

| arm | joined at | **native main thread** | | weeb3 main thread |
| ---: | ---: | ---: | --- | ---: |
| 1 | 86s | mean 0.435, peak 0.781 | | 0.220 / 0.590 |
| 3 | 1,556s | mean 0.670, peak 0.851 | | 0.225 / 0.605 |
| 6 | 3,789s | mean 0.723, peak 0.879 | | 0.217 / 0.455 |
| 8 | 5,313s | mean **0.746**, peak **0.899** | | 0.215 / 0.514 |

**The native arm climbs 72% across the sitting. The hybrid arm sits at 0.220 ± 0.005 over the same
window.** That flat control is what makes this readable: host drift, thermal effects and neighbour
load would move both, and they moved one.

⛔⛔ **By 88 minutes in, a 720p gateway-less viewer peaks at 0.899 of one thread.** For comparison,
our hybrid client peaked at 0.707 of one thread at **1080p** (`1080p-main-thread-2026-08-15`). The
gateway-less path is closer to its ceiling at 720p than the hybrid is at 1080p.

⚠️ **Four points, and join lag is confounded with position in the sitting** for the native arms,
which ran 1st, 3rd, 6th and 8th. Counterbalancing does not break that particular confound. The flat
control is the argument, not the sample size.

⭐ A mechanism that fits and is already documented: a viewer that keeps the whole broadcast pays per
segment **count**, and hls.js re-parses the entire playlist on every refresh
(`swarm-hls-viewer-manifest-growth`). A player starting at index 0 of a never-trimmed sequence would
grow exactly this way.

## Container CPU, for completeness and not as the ceiling

Native 3.01 to 3.12 cores, hybrid 1.68 to 1.75. ⛔ The process-tree total flattered the in-tab node
by 2x once before (`main-thread-saturation-2026-08-14`), which is why the thread column above is the
one that carries the argument.

## ⛔ An instrument defect found in this sitting, not fixed in it

**The segment tally is a rolling window of weeb-3's own log panel, not a total.** It reads about 24
in every arm, and 24 segments at 0.5s is twelve seconds of media against a 660-second window. It
cannot be quoted as throughput, and the label in `weeb3-native.ts` is being corrected to say so.

## What this changes

- ✅ **KEEP: a fully gateway-less viewer sustains a live broadcast at realtime**, three counted arms,
  zero gateway retrievals each, drift under a second in eleven minutes.
- ✅ **KEEP: it costs the gateway nothing.** 0.0000 BZZ on every native arm.
- ⛔ **DO NOT CLAIM a gateway-less live viewer.** It starts at the broadcast's beginning.
- ⛔ **DO NOT extrapolate the main thread past 88 minutes or past 720p** from this. What is measured
  is that it climbs and that the control does not.
- ⚠️ **Nothing here speaks to the multi-hour thread creep** measured over three hours in
  `drift-holds-and-bends-2026-08-15`. These arms are eleven minutes each.
