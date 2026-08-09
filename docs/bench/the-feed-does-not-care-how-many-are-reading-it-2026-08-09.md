# The feed does not care how many viewers are reading it

**2026-08-09.** Task #23, the last measurable item before Phase 3. Two sittings, 20 arms, **54,400
feed slot reads**. No broadcast, no encoder, no publisher, no postage. Attributed cost: **one cheque of
77,000,000,000 wei**, which is 0.0000077 BZZ, on the gateway chequebook.

## The gap

Every concurrency figure this project has, from 16 viewers up to 512, came from a probe that replays a
fixed list of chunk references. **That probe never reads a feed.** So the whole scale story above eight
viewers was measured with **zero feed reads in it**, while LAT-11 put feed staleness at 1.30x at eight
viewers and nothing had looked since.

The feed is where a viewer learns that media exists. If it degrades under load, viewers stop
discovering segments before they stop retrieving them, and no reference-list sweep can see it.

## Measured

Alternating arms, one reader either side of each pair, so drift separates from concurrency. `spread`
means N readers want N different slots. `same` means every reader wants the same slot at the same
time, which is what a live audience **is**.

| arm | hit median | **miss median** | miss p90 | miss p99 |
| --- | ---: | ---: | ---: | ---: |
| 1 reader | 9ms | **476ms** | 593 | 649 |
| 8 spread | 2ms | **461ms** | 558 | 685 |
| 8 same | 2ms | **448ms** | 548 | 767 |
| **1 reader** | 2ms | **426ms** | 606 | 917 |
| 32 spread | 1ms | **428ms** | 524 | 631 |
| 32 same | 1ms | **432ms** | 528 | 666 |
| **1 reader** | 2ms | **445ms** | 546 | 598 |
| 128 spread | 1ms | **463ms** | 579 | 753 |
| 128 same | 1ms | **471ms** | 609 | 920 |
| **1 reader** | 2ms | **480ms** | 630 | 666 |

⭐⭐ **A feed read at 128 concurrent readers costs what it costs at one.** The four interleaved
single-reader references span **426 to 480ms with nothing happening**, and every loaded arm from 8 to
128 sits **inside** that spread. Hits are 1-2ms throughout. Every read returned the right code:
5,120 of 5,120 per arm, 200 for hits and 404 for misses, with no errors at any concurrency.

⭐ **So the walk rate barely moves.** At the live-edge mix the announcement floor measured (45% miss,
55% hit), a reader sustains **4.81 reads a second at one reader and 4.69 at 128**. A 2.5% loss for
128x the audience.

## ⛔ The only thing that moves is the tail, and only for a synchronised audience

Medians and p90s say nothing. The rate of reads crossing one second says something:

| | reads | **≥1s** | events |
| --- | ---: | ---: | ---: |
| 128 **spread**, three arms | 15,360 | **0.065%** | 10 |
| 128 **same**, three arms | 15,360 | **0.42%** | 64 |

⭐ **6.4x, and it is invisible to every statistic that is not a crossing rate.** The medians for those
same arms are 462-482ms against 463-482ms. This is the same lesson the unfunded-gateway work paid for:
what decides whether a viewer stalls is not how long a typical read takes but how many reads miss the
budget.

⚠️ **Replicated, and the ordering held in all three pairs.** A second sitting ran `spread, same,
spread, same` at 128 only: 0.04%, 0.16%, 0.14%, 0.39%. Both adjacent pairs order the same way, and so
does the first sitting. ⚠️ The rate also **drifts upward across that sitting**, which alternation is
what separates from the effect — but the single-reader references are n=40 and cannot resolve a 0.4%
rate, so the absolute size of the difference is weaker evidence than its direction.

⭐ **The `same` arms really did share.** Their hit p90 is **1-2ms against 3-9ms for spread**, which is
bee serving concurrent requests for one chunk from a single fetch, exactly as the sixteen-viewers
result predicted. That is what makes the mode a measured condition rather than an assumed one.

✅ **And the size is not viewer-visible at 128.** A viewer doing ~1.6 misses a second at 0.42% meets a
one-second feed read about once every 150 seconds. A 6 second buffer absorbs that without noticing.

## ⛔⛔ What this does to LAT-11, which is more than filling its gap

LAT-11 reported eight viewers leaving the stream **1.30x staler** than one, direction holding in 12 of
14 paired comparisons. Its own register row already says the measurement went through the reader that
resolves `/feeds/{owner}/{topic}`, and that reader was later shown to be **50-57% frozen on its own**.
The client no longer uses it: it walks explicit slot addresses, which is the path measured here.

⭐ **On the path the client actually uses, the effect is absent at 8, at 32 and at 128.** The 8-reader
arms measured 461 and 448ms against references of 476 and 426.

⚠️ **This does not say LAT-11 was wrong about its own reader.** Two endpoints, two mechanisms. It says
the open question "does feed staleness scale with viewers" has an answer for the deployment as it
ships, and the answer is no.

## What it cannot say

⛔ **There is no live publisher here, so this is what a feed read COSTS, not how far behind live a
viewer ends up.** Deriving the second from the first assumes the walk is read-bound. That assumption is
reasonable and it is stated rather than hidden: a walk is a sequence of reads and a poll interval, and
only the reads were measured.

⛔ **128 is the ceiling reached, not a ceiling found.** The box carries forty other bee nodes, the
runnable count at 128 readers averaged 28 with peaks of 47 against a ceiling of 48, and going higher
would be measuring the host rather than the feed.

⚠️ **The whole-run chequebook delta is not the cost and is not quoted as one.** Per-block attribution
with an idle control after every arm gives one 77 gwei cheque and zero everywhere else. bee's spending
is lumpy and quantised, so a start-to-end balance difference cannot attribute anything.

## For the scale-up

⭐ **The feed is not the thing that breaks first.** The byte-rate ceiling still is: throughput plateaus
at 43-44 MB/s, which is ~123 viewers at 2.83 Mbps. At that same concurrency the feed costs 2.5% more
per read than it does for one viewer.

⭐ **Pool viewers behind gateways anyway, and now for a second reason.** Feed reads for the same slot
are served from one fetch, which is why the `same` arms have the tighter hit distribution.

⛔ **If you instrument one thing on the feed, instrument the rate of reads crossing your segment
budget, not the median.** The median was flat across a 128x range while the crossing rate moved 6.4x.
