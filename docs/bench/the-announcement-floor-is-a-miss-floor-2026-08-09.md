# The announcement floor is a miss floor, and it only exists at the live edge

**2026-08-09.** No run at all. **78,482 feed slot reads** taken from the 70 archived request logs in
`docs/bench/*.requests.json`, which are a free record of every URL a real viewer fetched. **Cost:
nothing, and nothing was measured that had not already been paid for.**

Roadmap step 7 asks whether a segment can be fetched without being announced, and says to **measure the
announcement floor first**. The floor on record is that a reader sustains about **3.8 feed slot reads a
second**, because a slot read costs roughly 260ms. What that 260ms is made of was never asked.

## ⛔⛔ First, the answer that pooling gives, which is wrong

Pooled across all 78,482 reads:

| status         |  count | median |   p90 |
| -------------- | -----: | -----: | ----: |
| 200, a hit     | 61,273 |  213ms | 373ms |
| 404, a miss    | 17,192 |  465ms | 637ms |

That reads as **"a miss costs 2.2x a hit"**, and it is composition rather than effect. Per log the ratio
runs **0.03x to 11.19x with a median of 0.94x**, and a miss is slower than a hit in only **23 of 49**
logs. A coin flip.

⛔ **The pooled number is an artifact of which logs contributed how many reads.** It had to be thrown
away.

## ⭐⭐ Regrouped by where the viewer sits, the effect is real and it reverses

**Miss rate is the grouping variable**, chosen because it says where a viewer sits rather than because it
sorts the outcome: a walk finds the head of a feed by reading until it 404s, so a viewer at the live edge
misses about half the time and a viewer catching up almost never does.

| regime, by miss rate       | logs | hit, median of medians | miss, median of medians | miss/hit per log |         slower in |
| -------------------------- | ---: | ---------------------: | ----------------------: | ---------------: | ----------------: |
| **behind the edge**, <10%  |   29 |              **244ms** |               **215ms** |        **0.87x** |       8 of 29     |
| near it, 10 to 30%         |    3 |                  245ms |                   199ms |            0.81x |       1 of 3      |
| **at the edge**, >30%      |   14 |              **118ms** |               **496ms** |        **4.51x** | **14 of 14**      |

⭐⭐ **At the live edge a miss costs 4.5x a hit, in every one of the fourteen logs. Behind the edge it
costs slightly less than a hit.** The sign of the effect depends on where the viewer is standing, which
is why no single number describes it.

⭐ **Both halves move.** At the edge hits get **faster** (244 to 118ms, and as low as 43ms) because the
chunk was written moments ago, while misses get **slower** (215 to 496ms) because nothing anywhere has
the chunk and the lookup has to give up rather than find.

⛔ Three crash-scenario logs were excluded, where a 404 came back in **8ms**. That is the gateway
refusing locally rather than looking anything up, and it is a different thing wearing the same status
code.

## ⭐ The not-found cost is a bounded search, not a timeout

Pooling the at-the-edge logs, **13,600 misses against 16,350 hits**:

| miss duration | share |
| ------------- | ----: |
| under 300ms   |  6.8% |
| 300 to 399ms  | 10.2% |
| **400-599ms** | **66.4%** |
| 600 to 999ms  | 13.6% |
| 1000ms+       |  3.1% |

p25 **428ms**, median **493ms**, p75 **562ms**. ⭐ **A single mode holding two thirds of the
distribution, with modest spread.** A fixed timeout would be a spike at one value and an unbounded
network search would have a heavy tail. This is neither, so **not-found has a characteristic cost of
about 490ms** on this path.

⚠️ It is not the 1.0 to 1.1 second retry timer seen elsewhere in this project. It is about half of it.

## ⭐⭐ Which reconstructs the floor

At the edge, misses are **45.4%** of reads. So the average read costs
`0.454 x 496 + 0.546 x 118 =` **about 289ms**, or **3.5 reads a second**, which brackets the **3.62 to
3.77 slots a second** the bench measured directly.

⭐ **So the announcement floor is not the price of reading a feed. It is mostly the price of asking for
a slot that has not been written yet**, and a walk at the live edge does that roughly every other read.

## ⛔⛔ What this means for the proposal in roadmap step 7

The proposal is to write segments as single-owner chunks at computed addresses, exactly as manifests
already are, so a client walks a **segment** feed and skips the manifest at the live edge.

⛔ **That does not remove the dominant cost, because predictable addresses are what make it possible to
ask for something that does not exist.** A client walking a computed-address segment feed at the live
edge is doing exactly the thing that costs ~490ms, and it would do it at least as often. **The floor
moves to the new feed unchanged.**

⭐ **The saving the proposal does buy is a hop, not a rate**: the manifest read disappears from the
critical path. That is worth having and it is not what the floor is made of.

⭐⭐ **The way past a miss floor is not a cheaper poll, it is not polling.** A push primitive lets a
publisher say "slot N exists now" rather than having every viewer discover it by failing to find slot
N+1. ⚠️ Swarm has one in GSOC, and **nothing here has measured it**, so that is a direction rather than a
finding.

⚠️ **And it sharpens what to expect from LL-HLS**, which is roadmap step 9. If the read side's floor is
set by the cost of speculative misses at the edge, then cutting segments into smaller parts **increases
the number of speculative reads**. ⬅ Whether that is a wash or a loss is unmeasured, and it is the thing
to measure before anyone builds it.

## ⭐⭐ Replicated on the direct path, where the effect is far larger

**2026-08-09, 05:21 to 05:29 UTC.** Four alternating blocks of 100 reads straight at the gateway, no
browser and no proxy, against real slot identifiers from the corpus and random ones under the same
owner. **A single-owner chunk's address is a hash of its identifier and its owner**, so consecutive
slots land at unrelated addresses and a random identifier is the same kind of request as the next
unwritten slot. There is no locality and no notion of distance.

| run | miss median | hit median | ratio |
| --- | ----------: | ---------: | ----: |
| first  | **459ms** (p10 339, p90 599) | **7ms** (p10 4, p90 33) | **66x** |
| second | **483ms** (p10 381, p90 593) | **4ms** (p10 3, p90 9)  | **121x** |

⭐⭐ **The miss cost is the same on both paths, 483ms direct against 496ms through the browser, while
the hit cost is 17 to 30 times apart.** So the archive's hit figures are mostly client-side and its
miss figures are almost entirely the gateway's lookup. **The floor is a gateway-side cost and nothing
a client does will move it.**

⭐ Every one of the 400 misses returned 404 and every one of the 400 hits returned 200.

## ⛔⛔ And a miss costs no BZZ at all, which is the opposite of what a whole-run delta said

The first run's spendable balance fell by **1,044,000,000,200 wei** across 400 reads. Dividing that by
the bytes the hits transferred suggested the hits could only account for about 0.5% of it, and therefore
that **misses dominated the bill**. ⛔ **That was wrong, and only per-block attribution caught it.**

| block                              |                spent |
| ---------------------------------- | -------------------: |
| 100 hits                           | **615,000,000,000 wei** |
| 100 misses                         |                **0** |
| 100 hits                           |                **0** |
| 100 misses                         |                **0** |
| every 20s idle control between them |               **0** |
| a standalone 115s idle control      |               **0** |

⭐⭐ **Misses spent nothing, in both miss blocks.** And the second hit block spent nothing either, so the
one charge is a **cheque being written when a peer's debt crossed a threshold**, not a per-read price.
**Spending is lumpy and quantised, so dividing a run total by a request count produces a number that
describes nothing.**

⭐ It makes sense once seen: a not-found delivers no bytes, so no peer is owed for bandwidth.

⭐⭐ **Which sharpens the design consequence rather than softening it. Speculative reads are free in
money and expensive in time.** What bounds read-ahead is latency and the lookup load on the gateway, not
the wallet, and ⚠️ the throughput ceiling measured elsewhere is a **byte** rate, so it cannot see
speculative reads at all: they move no bytes.

## ⚠️ What this does not show

⚠️ **Absolute milliseconds here are not comparable to the retrieval probe's.** These reads go from a
browser through the client dev server at `127.0.0.1:10074/bee/soc/...`, so they carry a proxy hop the
probe's direct `/bytes/` fetches do not. **Within-corpus comparisons are sound. Cross-corpus ones are
not**, and the segment figures elsewhere in this repo must not be set beside these.

⚠️ **The 30% miss-rate boundary is a choice**, and three logs sit between 10 and 30%. The effect is
large and one-sided at the extremes, which is what carries it, not the exact cut.

✅ **Whether the cost depends on how far past the head you ask is now answered, and it does not.** A
single-owner chunk's address is a hash of its identifier and its owner, so slot N+1 and slot N+100 sit
at unrelated addresses and neither is nearer to anything. The direct-path run asked for 400 addresses
nobody has ever written and got the same ~480ms every time. ⭐ **So reading ahead by N costs N misses,
linearly, and there is no cheaper distance to read at.**

⚠️ These are archived runs spanning 2026-08-05 to 2026-08-08 and several code changes, pooled by regime
rather than held constant.

## Artifacts

The archive half: `docs/bench/*.requests.json`, 70 logs, unchanged, no gateway touched and nothing
spent. The direct-path half: `/home/solarpunk/soc-miss2/`, instrument
[`deploy/scripts/soc-miss-cost.sh`](../../deploy/scripts/soc-miss-cost.sh), **0.0000615 BZZ total**,
which was one cheque written during the first block and nothing at all across the other three.
