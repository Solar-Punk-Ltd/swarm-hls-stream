# Running a high-scale streaming event on Swarm

**A handover from `swarm-hls-stream` to whoever is building the load simulation. 2026-08-08.**

This document exists so that a second repository can run thousands of viewers against a live Swarm
stream without paying again for the lessons this one already paid for. It is written for a reader with
no context on this codebase.

---

## 0. Read this before anything else

### ⛔⛔⛔ CORRECTED 2026-08-15: THE SHIPPING PROFILE IS A 0.5s GOP, AND THIS DOCUMENT SAYS 0.25s

Written 2026-08-08, when this project believed a 0.25s GOP was the product. It was not. **0.25s was
the bench rig.** What ships is a **0.5s GOP against `HLS_FRAGMENT=0.5`**, which makes the segment
budget **500ms and not the 267ms every table below is scored against**.

⭐⭐ **Which way it bends the results, because that decides whether you can still use them. The
answer is: barely, and the tables below can be read roughly as they stand.**

⛔ **This paragraph first said the shares were "upper bounds" and overstated the gap by about six
times.** A 0.5s GOP does not only double the budget, it **doubles the segment**, 94 kB to 188 kB, and
a bigger segment takes longer to retrieve. Scoring 764,340 timings already on disk at the threshold
each case implies:

|  threshold | over budget |                                            |
| ---------: | ----------: | ------------------------------------------ |
| **267 ms** |   **20.6%** | as published below                         |
|     272 ms |       19.8% | shipped profile, pessimistic size exponent |
|     346 ms |       15.1% | shipped profile, optimistic size exponent  |
| ~~500 ms~~ |   ~~11.3%~~ | ⛔ ignores the bigger segment, do not use  |

See `../bench/rig-budget-vs-shipped-budget-2026-08-15.md`.

⛔ **Do NOT carry 267ms into a new simulation, and do NOT simply swap in 500ms either.** Score the
shipped profile against 500ms **with 188 kB segments**. Re-deriving the old numbers means re-running,
not rescaling: an over-budget share is a count against a threshold and does not convert, and per-arm
the shift here ranges from 0.0 to 26.3 points.

⛔ Two further corrections that arrived after this was written, both detailed in section 2z:
the funding multiplier is **13%, not 38x**, and every pre-2026-08-11 in-browser throughput figure is
a **floor rather than a ceiling**, because the corpus it was measured on was decaying.

### ⛔ This repository has never exceeded eight viewers actually watching video

**One** gateway, throughout. Nothing here has run a hundred nodes, let alone a thousand. Where this
document talks about a fleet it is reasoning from a measured mechanism to a predicted consequence, and
it says so every time.

⛔ **Two different things are called a viewer below and they are not interchangeable:**

|                    |                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **a real viewer**  | a browser running hls.js, decoding and displaying. **Never more than 8**, and every latency, stall and quality figure comes from these                           |
| **a probe viewer** | a paced fetcher walking a list of already-published segment references. **Up to 128**, and every concurrency, CPU, throughput and cohort figure comes from these |

⚠️ **A probe viewer is a good model of retrieval load and no model at all of playback.** It has no
decoder, no buffer and no player state machine, so it cannot stall, cannot rebuffer and cannot tell you
what a picture looked like. The lag it reports is what a buffer _would_ have absorbed, not what a
viewer saw.

⛔⛔ **There is a THIRD kind, and it behaves like neither of the above.** A **browser node** viewer runs
a Swarm node inside the tab (weeb-3) and fetches from the network directly, with no gateway between it
and the swarm. **Every figure in this document assumes a gateway.** None of them transfer. The three
things that make it a different animal:

|                                                                                                                  |                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⚠️ it delivered **0.59x of realtime** for a 2.86 Mbps stream **on our harness**, which is not the node's ceiling | 203 KB/s against the 357 KB/s needed, but see the note below                                                                                                                                                                                                   |
| it is **demand only**: it never serves, caches or announces for anyone else                                      | so an audience of them adds load and no capacity                                                                                                                                                                                                               |
| ⛔ ~~fragments above roughly **1 MB stop arriving at all**~~ **WITHDRAWN 2026-08-11, it was corpus decay**       | on content of known health, 3,361 KB delivered **8/8 at 1,007 KB/s** and abel-1's 4,262 KB delivered **8/8**. Re-confirmed 2026-08-16: Abel's live page pulls **4.32 to 4.40 MB** segments to completion. See `../bench/size-on-healthy-content-2026-08-11.md` |

> ## ⛔⛔⛔ AND OUR OWN `weeb3` CLIENT IS A **FOURTH** KIND, NOT THE THIRD ONE ABOVE
>
> Everything this project measured under the name "in-tab node" ran a **hybrid**: segment bytes from
> the node, **feed and manifest still from a bee gateway**. It is not gateway-less. Do not model our
> published in-tab figures as the third kind described above.
>
> ⛔ The saving figures we published (24.4x, 25.3x, 20.3x, 21.6x, 44.5x fewer gateway retrievals) are
> therefore **lower bounds**. A genuinely gateway-less viewer exists, and on 2026-08-16 Abel's own
> live page was observed making **5 network requests in a whole session, all of them app shell**, with
> every feed read and every segment answered in-node.
>
> ⚠️ It also did not reach playback in that window: 2 of 5 segments failed and the video held
> `readyState` 1. ⭐ **That is his content, not his architecture.** 2560x1600 at ~8.5 Mbps needs
> 1.6x what any measured retrieval path delivers, a public gateway included, and this document's own
> section on his link says so. **Gateway-less and working are two claims, do not merge them in
> either direction.**
>
> See [`../bench/abel-gateway-less-live-2026-08-16.md`](../bench/abel-gateway-less-live-2026-08-16.md).

⛔ **The 203 KB/s in that first row is a fact about our client, not about weeb-3.** The run that
produced it offered far less work than we believed: `RETRIEVE_DATA_GROUP_CONCURRENCY = 8` bounds
Merkle-node expansions, each carrying up to 128 chunk requests, so the node was never saturated.
**Do not plan against 0.59x as a ceiling and do not quote it as one.** What a browser node can actually
sustain is open, and it is task #60. The second and third rows are unaffected.

**Everything about browser nodes lives in [in-browser-phase-1.md](./in-browser-phase-1.md)**, including
what to feed a simulator, in its section 7b. Do not model a browser-node audience from this document.

**Three labels are used throughout and they are not decoration:**

| label           | means                                                                       |
| --------------- | --------------------------------------------------------------------------- |
| ✅ **measured** | a number came off an instrument in a run that is named, with its cost       |
| ⚠️ **derived**  | arithmetic or reasoning on measured numbers, not itself observed            |
| ⬅ **open**      | nobody has answered this, and guessing is how the last four errors happened |

If you take one thing from this document, take the fact that **most of the expensive mistakes here were
not wrong measurements. They were correct measurements of the wrong quantity**, which no amount of
care in running the test would have caught.

### The three findings that would change your design most

1. **The median is the wrong statistic.** Between a night a viewer collapsed and a night it held, the
   median moved **1.18x** and the rate of one-second stalls moved **10 to 40x**. Section 3.1.
2. **Viewers sharing a gateway are nearly free, and what limits it is how many arrive at the same
   instant.** bee fetches each distinct chunk once and serves every concurrent viewer from it. **128
   viewers in cohorts of 8 run comfortably on one unfunded gateway** at 57-68ms median with 1.7% late
   and no buffer drain at all. **The same 128 viewers firing on the same tick drain 12.8 seconds of
   buffer.** ⛔ **What you cannot do is jitter the client out of it**: 60ms of per-request jitter was
   measured and does nothing, because the constraint is chunk diversity rather than arrival instant.
   ⭐ **Turn the gateway cache on and pool viewers.** Sections 2.4b, 2.4c and **2.4f**.
3. **Funding is a switch that flips at zero.** 0.05 BZZ performs exactly like 6.4 BZZ, and an empty
   chequebook performs exactly like no chequebook. So **fund each node for its burn times the event
   duration and no more**, and **alarm on the balance**, because a node that runs dry reports nothing.
   Section 2.1b.
4. **An unfunded node's ~23 skips per distinct chunk are local, not on the wire**, so a fleet of them
   is bounded by host CPU rather than network capacity. Section 2.2.

---

## 1. The system being tested

A publisher sends video to a media engine (SRS), which cuts HLS segments. An uploader pushes each
segment to Swarm and publishes a rolling manifest into a **feed**, which is a sequence of
single-owner chunks at computed addresses. A browser client walks that feed, assembles an HLS playlist
and hands it to hls.js, fetching segments through a **bee gateway** of its own.

The parts that matter for load:

|                          |                                                                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The viewer's gateway** | a bee node. This is the component under test. Every question in this document is really a question about it                                                                                                                                                 |
| **The feed**             | one single-owner chunk per publish, **4096 bytes**. Crossing that turns one round trip into three                                                                                                                                                           |
| **The manifest window**  | about **36-50** segment lines per chunk, depending on whether segment lines carry a gateway URL                                                                                                                                                             |
| **The segment budget**   | segment duration in milliseconds. ⛔ **At the shipping profile it is 500ms** (0.5s GOP against `HLS_FRAGMENT=0.5`). Every table below scores against **267ms**, the bench rig, which is stricter. A retrieval slower than the budget puts the player behind |

### The profiles

⛔ **This section said "0.25s GOP ships" and that is wrong.** A **0.5s GOP ships**, at 720p / 2500k,
with 1080p / 6000k also shipping at about 2.3x the BZZ. 0.25s was the latbench rig. What survives
unchanged is the finding it was making: latency across a 2.4x bitrate range differs by **70ms**, so
picture quality costs bandwidth rather than seconds.

⚠️ **1.0s is still the resilient profile**, and if your simulation is about survival rather than
latency you should test at 1.0s too. A one-second stall costs a **500ms**-budget player **two**
segments and a 1000ms-budget player **one**. ⛔ The ratio below reads "four" against a 267ms budget,
which is the rig, not the product. The mitigation is the same and its size is halved: a longer
segment is still the most reliable answer this project found to every retrieval problem below.

---

## 2. What we know about retrieval

### 2.1 A funded gateway and an unfunded one are different machines

Swarm peers charge each other for bandwidth. A node with a funded chequebook settles what it owes. A
node without one (`--swap-enable=false`, or a light node whose balance is committed to outstanding
cheques) **cannot settle**, so it accumulates debt with every peer until it sits at their disconnect
thresholds, and bee then skips those peers rather than be disconnected.

✅ **Measured, 2026-08-08, four arms retrieving the same 800 references in the same order:**

|                                     |           funded |                              unfunded |
| ----------------------------------- | ---------------: | ------------------------------------: |
| debt across an arm                  |      **settled** | grew by 604, 721 and 479 million PLUR |
| `accounting_blocks_count`           | **5** and **22** |           **799,072** and **773,898** |
| peer-selection iterations per chunk |         **1.14** |               **39.41** and **38.22** |
| pseudo-settlements sent             |       909, 1,005 |                    **10,512, 10,332** |
| request failure rate                |             7.1% |                                  7.4% |
| median segment transfer             |          37-39ms |                             104-110ms |
| **share over the 267ms budget**     |     **0.0-0.3%** |                        **11.6-15.0%** |

⭐ **It is not failing more often. It is doing 34x the work to fail at the same rate.**

### ⭐⭐ 2.1b The funding cliff is a switch, and it flips at exactly zero

✅ **Measured 2026-08-08**, the chequebook drained to a known balance and sampled every five seconds
beside the retrieval counters. [Full report.](../bench/the-funding-cliff-is-at-zero-2026-08-08.md)

| chequebook available |    median | over 267ms | **first-peer service** | **skips per chunk** |
| -------------------: | --------: | ---------: | ---------------------: | ------------------: |
|         **0.05 BZZ** |  **43ms** |   **0.1%** |              **87.6%** |            **1.56** |
|    **0.0000004 BZZ** | **109ms** |  **10.6%** |              **12.5%** |            **39.8** |

⭐ **0.05 BZZ performs exactly like 6.4 BZZ.** A hundred-and-twenty-eighth of the balance buys the same
retrieval.

⭐ **A chequebook with nothing in it is worth nothing.** The drained arm is indistinguishable from a
node with no chequebook at all. `--swap-enable=true` plus an empty balance is not a partly-funded node.

⭐⭐ **So balance level buys nothing except time, and sizing is arithmetic:**

```
BZZ per node = burn rate x event duration
```

At the measured **0.0102 BZZ/min** for 720p / 2500 kbps, a two-hour event is **1.22 BZZ per gateway**.
Combined with 2.4b, a thousand viewers at sixteen per gateway is 63 gateways, so about **77 BZZ** for
the event against **1,220 BZZ** for one node per viewer.

⚠️ **That 77 BZZ is a deliberately conservative ceiling, and 2.4e says by how much.** Sixteen per
gateway is the concurrency at which sharing was measured, not a limit. **The measured limit is ~123
viewers per gateway**, and because bee fetches each distinct chunk once no matter how many local viewers
want it, **a gateway's burn barely moves with the viewers behind it**. Pooling at a sane 60% of the
measured capacity is roughly 14 gateways and **about 17 BZZ**, four to five times cheaper.

⛔ **Do not budget against the 17.** It is arithmetic on two measured numbers and has never been run,
whereas the 77 is the figure that has slack in it. Size the wallet with the 77 and treat the difference
as headroom until somebody measures a pooled fleet.

⛔ **This is the failure mode with no alarm.** A gateway that runs dry does not error, does not
disconnect and reports nothing: on 2026-08-07 one was found at 0.0000007 BZZ spendable with `/health`
answering in 1.1ms, 134 peers and reachability Public. Every viewer behind it goes from 0.1% late
segments to 10.6%. **Alarm on `chequebookAvailableBzz` approaching zero, because no other signal
moves.**

⛔ **Two hypotheses that sound right and are refuted:**

- **Idle does not refill anything.** Debt read -1,357,400,000 PLUR at the end of one arm and
  -1,357,270,000 at the start of the next, **fifteen minutes of idle later**. Bee settles when it needs
  headroom with a peer, not on a timer, so an idle node settles nothing because an idle node needs
  nothing.
- **Debt level is not the dial.** Debt saturates near **-1.4 billion PLUR**, and the three arms
  **pegged at that ceiling were the best of eleven** at 1.9-3.4% late.

⚠️ **Across eleven unfunded arms of identical work on one node in under two hours, the late share
ranged 1.9% to 19.5%.** A tenfold spread that none of idle, debt level or arm order accounts for. This
is the single most important fact for a simulation: **the variance between identical unfunded runs is
larger than most effects you will try to measure.**

### 2.2 ⛔ The correction: those 38 attempts never leave the node

This was reported first as a 34x increase in network work. **That was wrong**, and it is worth
understanding exactly why, because the same trap is waiting in any Prometheus counter you read.

Bee's retrieval loop:

```go
totalRetrieveAttempts++
s.metrics.PeerRequestCounter.Inc()      // incremented HERE
...
action, err := s.prepareCredit(ctx, peer, chunkAddr, origin)
if err != nil {
    skip.Add(chunkAddr, peer, overDraftRefresh)
    retry()
    continue                            // peer never contacted
}
```

`bee_retrieval_peer_request_count` and `bee_retrieval_request_attempts` are incremented **before** the
accounting call that decides whether to contact the peer at all. **A skipped peer is counted and never
asked.** Requests that actually left the node are `attempts − accounting_blocks`:

| arm        | attempts | − skips | **real peer contacts** | per chunk |
| ---------- | -------: | ------: | ---------------------: | --------: |
| 1 funded   |   23,924 |       5 |                 23,919 | **1.142** |
| 2 funded   |   23,950 |      22 |                 23,928 | **1.142** |
| 1 unfunded |  825,931 | 799,072 |             **26,859** | **1.281** |
| 2 unfunded |  801,062 | 773,898 |             **27,164** | **1.296** |

⭐ **An unfunded node adds about 13% network load, not 34x.** Corroborated independently by rate:
825,931 requests in 151 seconds would be **5,470 per second** from a light node whose median only moved
from 37ms to 110ms.

**What this means for your simulation, and it is mostly good news:**

- ✅ **You can run thousands of unfunded nodes without poisoning the network.** They generate roughly
  the traffic a funded fleet would.
- ✅ **The failure is per-node and independent.** It should not compound with fleet size. ⬅ Untested
  above eight.
- ⛔ **But the cost is host CPU**, and it is now measured.

✅ **Measured 2026-08-08.** An unfunded node burns **2.6 to 2.9x the CPU** of a funded one for
byte-identical work: 3.32 and 3.75 CPU-seconds per MB against 1.26 and 1.31. The plainest form of the
same fact: **a funded node is served by the first peer it considers 9 times in 10, an unfunded node
fewer than 1 time in 10** (92.9% and 91.0% against 8.6% and 9.6%).

⛔ **SUPERSEDED THE SAME DAY, and the table below is wrong for any pooled topology.** These figures come
from **single-viewer** arms, where each retrieval is a distinct chunk and per-chunk arithmetic means
what it says. [A concurrency sweep hours later](../bench/sixteen-viewers-cost-what-one-costs-2026-08-08.md)
found bee's CPU is roughly **flat at 1.4 to 2.2 cores from 1 to 16 concurrent viewers**, so CPU is a
per-**node** cost, not a per-viewer one, and dividing it by one viewer overstates a pooled deployment
by up to 16x. Read section 2.4 before sizing anything. Kept because the funded-against-unfunded ratio
within it still holds.

⚠️ **Derived.** At 720p / 2500 kbps a viewer pulls 0.3125 MB/s:

|                        | CPU-cores per viewer | viewers on a 48-core host |
| ---------------------- | -------------------: | ------------------------: |
| unfunded, cache off    |             **1.11** |                   **~43** |
| funded, cache off      |                 0.39 |                      ~120 |
| unfunded, **cache on** |             **0.33** |                  **~145** |
| funded, cache on       |                 0.17 |                      ~280 |

⛔ **That table is a per-node cost divided by one viewer. Do not size anything on it.** It is left
standing because it is quoted elsewhere and because the funded-against-unfunded ratio inside it holds.
The number you want is in section 2.4d.

### ✅ The duty-cycle caveat, now answered

Every arm above fetched flat out, which is a load generator rather than a viewer. A player asks for one
segment per segment duration because that is the rate the encoder makes them at.
[Paced arms measured the same day](../bench/what-a-paced-viewer-costs-2026-08-08.md) settle it, and the
answer splits in two:

- ✅ **Per-MB survives.** Paced and flat-out CPU per MB agree within 20% with no consistent sign, at 1,
  16, 64 and 128 viewers. CPU tracks bytes, and a paced viewer just moves fewer of them per second.
  **Every per-MB figure in this document stands.**
- ⛔ **Per-viewer does not.** A paced fleet costs about **half** the cores of a flat-out one at every
  concurrency below saturation: 0.70 against 1.75 at one viewer, 1.34 against 2.84 at sixteen, 3.62
  against 5.97 at sixty-four. **Any cores-per-viewer or viewers-per-host figure taken from a flat-out
  arm is about 2x pessimistic.**

⭐ The control that makes that credible: the same sitting's own flat-out arms **reproduce the published
flat-out model exactly** (fitted slope 0.067 and intercept 1.68 against the published 0.07 and 1.5), so
the gap is pacing rather than a re-measurement.

⭐ **If you pack one node per viewer onto a host, you will saturate CPU long before the network notices,
because the ~0.67 core fixed cost is paid per node rather than once.** Pooled, the opposite is true and
section 2.4d gives the chain.

⚠️ **The source was read, and it half-settles an assumption underneath this subsection.**
`bee_accounting_accounting_blocks_count` increments in exactly one place, `PrepareCredit`, once per call
on overdraft. ✅ **So it is event-driven and not time-driven**, which was the worry. ⚠️ **But pushsync
calls `PrepareCredit` too**, so the counter is not retrieval-only and a skip figure derived from it is
an upper bound rather than a measurement. Across a 15x change in workload it behaved like a **fixed
rate** (4,715 to 6,317 per second) rather than a per-chunk cost. Section 5.2 is about exactly this class
of mistake, and this document made it twice in one day.

### 2.3 Caching, which nothing had ever turned on

⚠️ **Every arm this project ever ran set `--cache-capacity=0`.** Nothing cached, every chunk was
re-fetched. It was excluded deliberately while the funding question was open.

✅ **Measured 2026-08-08**, twelve arms, 400 references fetched **twice** per arm, funded and unfunded
interleaved. [Full report.](../bench/what-a-viewer-node-costs-in-cpu-2026-08-08.md)

|                        | pass 1 median | **pass 2 median** | chunk retrievals |   **CPU per MB** |
| ---------------------- | ------------: | ----------------: | ---------------: | ---------------: |
| funded, cache off      |       28-44ms |           13-14ms |           10,544 |     1.257, 1.310 |
| funded, cache on       |       28-44ms |         **2-3ms** |        **5,630** | **0.539, 0.583** |
| unfunded, cache off    |      87-119ms |         118-128ms |           10,544 |     2.962, 4.117 |
| **unfunded, cache on** |     101-115ms |           **3ms** |        **5,630** | **1.006, 1.095** |

⭐ **A cache halves the chunk retrievals and cuts CPU 2.3x funded, 3.4x unfunded.** Pass 1 is
unaffected in every arm, which is the check that the cache arms are honest: the first fetch of a
reference is a real network retrieval either way.

⭐⭐ **An unfunded node with a cache (1.05 CPU-s/MB) costs less CPU than a funded node without one
(1.28).** On the hosting axis, turning the cache on is worth more than funding the chequebook.

⛔ **It does not make an unfunded gateway shippable.** Pass 1 still runs 2 to 3x slower, the late share
still swung 0.2% to 11.8% across four arms of identical work, and a cache only ever helps a chunk
somebody already fetched. **It changes what a fleet costs to host, not what a first viewer sees.**

### ⭐⭐ 2.3b Caching and pooling are orthogonal, and they compose

The obvious worry: if sixteen concurrent viewers already collapse to one network fetch (2.4b), does a
cache add anything? ✅ **Measured 2026-08-08**, four arms at **16 viewers each**, cache alternated, two
passes per arm, free. [Full report.](../bench/pooling-and-caching-are-orthogonal-2026-08-08.md)

| cache  | pass 1 median | **pass 2 median** | retrieval ops | **network contacts** |   **CPU per MB** | arm seconds |
| ------ | ------------: | ----------------: | ------------: | -------------------: | ---------------: | ----------: |
| off    |    116, 106ms |        122, 113ms |       ~79,000 |     **7,301, 6,744** |     0.309, 0.281 |      28, 35 |
| **on** |    102, 110ms |        **5, 4ms** |   **~40,000** |     **2,664, 3,340** | **0.176, 0.192** |  **17, 16** |

⭐⭐ **Pooling collapses requests across VIEWERS. Caching collapses requests across TIME.**

- **Pooling** merges the sixteen viewers asking for chunk X **at the same instant** into one fetch.
- **Caching** merges the request for chunk X **now** with the request for chunk X **later**. No amount
  of concurrency helps that, which is exactly what pass 2 measures.

A live event has both: many viewers watching together is the pooling case, and a viewer who joins late,
re-fetches after a stall or scrubs the DVR window is the caching case. **Take both.**

|                          | CPU per MB | against a lone unfunded viewer |
| ------------------------ | ---------: | -----------------------------: |
| 1 viewer, no cache       |       ~3.5 |                             1x |
| 16 viewers pooled        |      0.295 |              **11.9x cheaper** |
| **16 pooled and cached** |  **0.184** |                **19x cheaper** |

⚠️ **It does not show the cache reducing the late share** (1.0% and 10.7% off, 1.2% and 0.0% on), which
with two arms each and an unfunded node's tenfold spread carries no weight. **Retrievals, contacts, CPU
and wall clock all moved consistently in both rounds, and those are the claim.**

⬅ **The working set here is 100 references fetched twice inside a minute.** A real broadcast's working
set is the whole live window across the whole event, and **nothing has measured what happens when it
exceeds `--cache-capacity`.**

⭐ **This matters most in exactly the topology a large event uses**: many viewers behind few gateways,
all fetching the same segments.

⛔ **Two design traps, both of which produced a wrong answer here before being caught.**

1. **The natural probe fetches each reference once, so a cache can never hit.** A cache-on arm then
   comes out identical to a cache-off one for a reason that has nothing to do with caching. **The arm
   must fetch the same list twice.** A cache question is always a question about the second fetch.
2. **The bee data directory is a volume, so the cache survives a container recreate.** Once caching is
   on, arms are **not independent**: each inherits whatever its predecessor cached. The first unfunded
   cache arm here ran straight after a funded one and reported 2ms medians and 0% late, which were
   local disk reads of chunks the funded node had just fetched. The giveaway was `req=737` with
   `reqFail=737`: every network retrieval failed and it did not matter. **Order arms so a cache arm
   can only inherit from a cache-off arm, or clear the store between them.**

### ⭐⭐ 2.3c Size it above the working set, or it does nothing at all

✅ **Measured 2026-08-08**, thirty-six arms in two sittings sweeping `--cache-capacity` against a fixed
working set of 10,489 chunks, read off the node's own retrieval counter.
[First report](../bench/a-cache-that-does-not-fit-does-nothing-2026-08-08.md),
[the bisect that located the cliff](../bench/the-cache-cliff-is-at-one-hundred-percent-2026-08-08.md).

|      capacity | share of the working set | retrieval operations | vs cache off | pass 2 median |
| ------------: | -----------------------: | -------------------: | -----------: | ------------: |
|             0 |                          |      20,978 / 20,978 |              |     106-119ms |
|         1,000 |                     9.5% |      20,953 / 20,953 |     **0.1%** |   126 / 104ms |
|         4,800 |                **45.8%** |      20,978 / 20,978 |     **0.1%** |   100 / 117ms |
|     **8,000** |                **76.3%** |  **20,978 / 20,978** |     **0.0%** | **114/111ms** |
|    **10,500** |               **100.1%** |  **11,224 / 11,248** |    **46.5%** |     **3/4ms** |
| 13,000-20,000 |                 124-191% |      11,234 - 11,248 |        46.5% |         3-4ms |

⛔⛔ **A cache holding 76% of the working set is byte-identical to no cache at all.** The same 20,978
operations, both rounds. Not reduced, not slightly reduced.

⭐⭐ **10,500 chunks is eleven chunks above the working set and it buys the entire benefit**, taking the
second pass from ~110ms to 3ms. ⭐ **Everything at or above the working set is indistinguishable**, a
0.2% spread across four capacities and two rounds, so **over-provisioning buys nothing on top**.

⭐ **The shape identifies the policy and the bisect confirms it.** A cyclic scan larger than the cache is
the worst case for LRU, because the walk returns to each reference exactly when it has just been
evicted, and the pathology is **total rather than proportional**. Random eviction at 76% would have
given roughly a 76% hit rate. **The hit rate is not a function of capacity at all, only of whether
capacity clears the working set.**

⚠️ **The margin that worked was 0.1%, which is not a margin to design against.** A live working set is
not a fixed number the way this probe's is, so **size above the largest working set the deployment can
produce**, not above its typical one.

⚠️ **A cache does not raise the throughput ceiling.** Cache-off and cache-warm both cap at 43 to 44 MB/s
(2.4e), so this is a cost and latency lever rather than a capacity one.

### ⭐ How much to size it, and live is nothing like DVR

⚠️ **`--cache-capacity` is in CHUNKS, not bytes.** A gigabyte is roughly 280,000 of them. Sizing it as
if it were megabytes is off by three orders of magnitude, in the direction that silently does nothing.

⛔ **That 280,000 works out to ~3.6 KB of video per chunk, and this document previously called 3.6 KB
"the chunk size". It is not.** A Swarm chunk is **4096 bytes**, as the feed row in 1.2 already says.
94.4 KB of segment is **23.05 chunks of payload**, and **26.2 chunks are actually fetched**, so there is
about **14% overhead** in merkle-tree nodes and upload wrappers. ⚠️ Which of the two accounts for how
much has not been itemised. **Use 4096 to size bytes and 26.2 per segment to count requests**, and do
not treat the ratio between them as a chunk size.

|                                       | what has to fit | at 26.2 chunks per 267ms segment |
| ------------------------------------- | --------------- | -------------------------------: |
| **live edge**, viewers within ~10s    | the live window |         **~980 chunks, ~3.5 MB** |
| **live edge**, viewers within ~60s    | the live window |            ~5,900 chunks, ~21 MB |
| **DVR or VOD**, one re-watchable hour | the whole span  |    **~353,000 chunks, ~1.26 GB** |

⭐ **A live audience needs almost nothing**, because it only ever wants the newest segments. Any
non-zero capacity worth setting clears it.

⛔ **An audience that scrubs needs the whole re-watchable span**, and that is where the cliff bites.

### ⭐⭐ Skew removes the cliff entirely: the cache is a dial, not a gate

✅ **Measured 2026-08-09**, eighteen arms running three access patterns over an identical working set,
interleaved inside one sitting.
[Full report.](../bench/the-cache-cliff-belongs-to-the-access-pattern-2026-08-09.md) **This qualifies
everything above.**

The cliff was measured with a **cyclic scan**, which is the worst case LRU can be given. Give the same
capacity a skewed pattern instead, 80% of re-reads landing on a fifth of the references, and the step
becomes partial credit:

| lap-two pattern, all at 8,000 chunks = **76.3%** | retrievals removed, r1 / r2 | lap-two median |
| ------------------------------------------------ | --------------------------: | -------------: |
| **cyclic**, every reference equally popular      |              **0.0 / 0.0%** |    104 / 115ms |
| **recent**, hot fifth is the newest              |            **36.8 / 36.8%** |    **4 / 3ms** |
| **oldest**, hot fifth is the oldest              |            **31.2 / 31.1%** |    **4 / 4ms** |
| cyclic at 10,500 = 100.1%, for reference         |                46.4 / 46.6% |        3 / 4ms |

⭐⭐ **A cache at 76% of the working set removes 37% of retrievals under a realistic pattern and 0% under
a cyclic one**, and its median second-lap fetch is **3 to 4ms, which is what a correctly sized cache
does**. Since 46.5% is everything a cache can collect here (lap one must miss), **76% of the capacity
collects 79% of the available benefit**.

⭐ **The `oldest` arm is why this generalises.** Its hot fifth is placed where LRU is worst, on the
entries an undersized cache evicted during lap one, and it still collects 31% and the same 4ms median.
**So what matters is that a skew exists, not that it points at recent content.** LRU re-warms a hot set
on its first re-touch and holds it, provided the hot set fits.

⛔⛔ **"Size for the hot set" was published here on 2026-08-09 and measured wrong the same day.** It
rested on one capacity, 3.8x the hot set. A bisect below it found **no step at the hot set and no step
anywhere**.
[Full report.](../bench/the-cache-has-no-cliff-under-skew-2026-08-09.md)

|  capacity | × hot set | % of working set | retrievals removed, r1 / r2 | share of what a full cache achieves |
| --------: | --------: | ---------------: | --------------------------: | ----------------------------------: |
|       500 |     0.24x |             4.8% |                  4.1 / 4.5% |                             9 / 10% |
|     1,000 |     0.48x |             9.5% |                  8.2 / 8.1% |                            18 / 17% |
| **2,100** | **1.00x** |        **20.0%** |            **17.7 / 17.5%** |                        **38 / 38%** |
|     3,200 |     1.53x |            30.5% |                22.1 / 21.8% |                            47 / 47% |
|     5,000 |     2.39x |            47.7% |                28.7 / 29.2% |                            62 / 63% |
|     8,000 |     3.82x |            76.3% |                36.8 / 36.8% |                            79 / 79% |

⭐⭐ **A smooth concave curve, both rounds within 0.5 percentage points.** At exactly the hot set a cache
collects **38%** of what a full one collects, not all of it, and it keeps buying past that. **The hot set
is a scale, not a threshold.**

⭐ **Early capacity is worth about twice its share**: 4.8% of the working set buys 9 to 10% of the
benefit, 9.5% buys 17 to 18%, 20% buys 38%. The premium decays and is gone by 76%.

⛔ **So under a realistic pattern a cache is a dial, not a gate, and no capacity is wasted.** Pick a point
on the curve. For DVR, where a re-watchable hour is ~353,000 chunks, **5% of that buys a tenth of the
benefit and 20% buys nearly four tenths**, which is a very different procurement conversation from "clear
the working set or get nothing".

⚠️ **The cyclic result stands unchanged.** Below 100% a cyclic scan still collects exactly nothing,
reproduced twice. **Every cliff measured here belongs to that pattern.**

⚠️ 80/20 is a chosen shape, so the curve's heights are a property of this skew. What generalises is that
skew removes the discontinuity. ⬅ Nothing between 5,000 and 8,000 was run, and nothing below 500.

### 2.4 Concurrency: a viewer adds load rather than sharing it

✅ **Measured (LAT-11), 1 viewer against 8 on one gateway, across two 34-minute broadcasts:**

| per second       | 1 viewer | 8 viewers |                  ratio |
| ---------------- | -------: | --------: | ---------------------: |
| chunks retrieved |     87.7 |      96.0 |              **1.09x** |
| gateway CPU      |    16.6% |     30.6% |              **1.84x** |
| feed staleness   |      n/a |       n/a | **1.30x** (p = 0.0129) |

⭐ **Eight viewers cause nine percent more chunk retrieval than one**, because the gateway already
holds what the extra seven ask for. **The cost of a viewer is serving requests.**

⛔ **The staleness row is retired, 2026-08-09.** It was measured through `/feeds/{owner}/{topic}`, the
head lookup, which was later shown to be 50-57% frozen on its own and which the client no longer uses.
On the explicit-address path a client actually walks, a feed read at **128** concurrent readers costs
what it costs at one. See 2.4h. The first two rows stand.

⭐ **The loaded arm sat at 30.6% CPU on a 48-core host, nowhere near saturation, so the ceiling is
inside bee.** More BZZ will not help. The levers are **horizontal gateways** and bee's request-handling
limits.

### ⭐⭐ 2.4b Sixteen viewers cost the network what one viewer costs

✅ **Measured 2026-08-08**, concurrency alternated 1, 2, 1, 4, 1, 8, 1, 16 against an unfunded gateway,
every viewer walking the same reference list at the same moment.
[Full report.](../bench/sixteen-viewers-cost-what-one-costs-2026-08-08.md) It cost nothing.

| viewers | retrieval operations | **network peer contacts** | bee CPU-cores |
| ------: | -------------------: | ------------------------: | ------------: |
|       1 |                2,638 |         **3,189 - 3,260** |   1.37 - 2.21 |
|       2 |                5,028 |                 **3,167** |          1.48 |
|       4 |               10,028 |                 **3,287** |          1.58 |
|       8 |               20,078 |                 **3,227** |          1.90 |
|  **16** |           **38,968** |                 **3,250** |      **2.17** |

⭐ **Network peer contacts vary 3.7% while the workload moves 15x.** That figure is one viewer's worth
of distinct chunks. **bee fetches each distinct chunk once and serves every concurrent viewer from that
fetch.**

✅ **Throughput scaled 16.7x** (9 MB in 15s at one viewer, 150 MB in 15s at sixteen) and **the median
did not degrade** (reference arms 88, 82, 75, 72ms against loaded arms 66, 72, 70, 80ms).

⚠️ **The late share roughly doubles**, 4.0% mean across the reference arms against 8.9% at sixteen.
That is the real cost and it is modest.

⭐⭐ **So the design rule is: pool viewers behind gateways, do not run one bee node per viewer.**

| topology            | network contacts            | bee CPU                | viewers per 48-core host |
| ------------------- | --------------------------- | ---------------------- | -----------------------: |
| one node per viewer | ~1 viewer's worth **each**  | ~1.5-2 cores **each**  |            **~25 to 30** |
| 16 viewers per node | ~1 viewer's worth **total** | ~1.5-2 cores **total** |                 **~400** |

⭐ **It also amortises the unfunded penalty**, since the skip rate is fixed per node and sixteen
viewers each carry a sixteenth of it.

⚠️ **Derived from a four-minute sweep.** Arms were 13 to 15 seconds, the concurrent `curl` processes
consume host CPU that is not counted (only bee's PID is), and nothing was tested above 16.

### ⭐⭐ 2.4c Where sharing stops: the knee is at 128, and the budget finds it

✅ **Measured 2026-08-08**, concurrency alternated 1, 32, 1, 64, 1, 128 on an unfunded gateway. It cost
nothing. [Full report.](../bench/where-sharing-a-gateway-stops-2026-08-08.md)

| viewers |    median |   p90 | **over 267ms** | **MB/s** | **network contacts** | first-peer |
| ------: | --------: | ----: | -------------: | -------: | -------------------: | ---------: |
|       1 |  **78ms** | 239ms |       **2-7%** |      0.6 |      **3,207-3,234** |        17% |
|  **32** | **118ms** | 544ms |      **24.4%** | **12.5** |            **4,565** |  **95.0%** |
|  **64** | **141ms** | 445ms |      **17.8%** | **24.0** |            **4,584** |  **96.3%** |
| **128** | **248ms** | 685ms |      **45.1%** | **33.4** |            **5,972** |  **95.0%** |

⛔ **At 128 the median segment transfer is 248ms against a 267ms budget.** The typical segment barely
fits, and that is the ceiling.

⭐ **Sharing does not break, it only softens: 128 viewers cost the network 1.85x what one costs.**

⭐⭐ **First-peer service goes UP with concurrency, 17% to 95%.** An unfunded gateway serving 32+
concurrent viewers reaches the peer-selection loop for so few requests that it beats a **funded** node
serving one (91-93%). The penalty is per distinct chunk and sharing spreads it across everyone.

⚠️ **32 and 64 cannot be ranked** (24.4% against 17.8% is backwards, and well inside the spread an
unfunded node shows on identical work). **45.1% is not inside that spread.**

⭐ **Pool 32 to 64 viewers per gateway.** Below that the fixed CPU cost is wasted, above 64 throughput
efficiency falls to 70%.

⛔ **Superseded twice.** That rule came from arms where every viewer fired on the same tick. **128
viewers in cohorts of 8 are comfortable on one unfunded gateway** (2.4f), and 2.4e now measures the
actual limit directly: **~123 viewers at 2.83 Mbps, bracketed by 128 holding and 192 not**. So 32-64 is
conservative by roughly 2 to 4x, and the binding constraint is **aggregate byte rate**, with cohort size
deciding how efficiently that rate is spent.

⚠️ **The knee is a property of the BUDGET, not the node.** At a 1.0s GOP a 248ms median sits at a
quarter of the budget rather than at its edge, so a longer segment moves the knee out.

### ⛔ 2.4d The CPU model, which corrects 2.2

| viewers | bee CPU-cores |
| ------: | ------------: |
|       1 |     1.4 - 1.5 |
|      16 |          2.17 |
|      32 |          2.27 |
|      64 |      **4.54** |
|     128 |      **6.82** |

⭐ **`fixed + marginal`: about 1.5 cores fixed plus about 0.07 cores per viewer.** It predicts 2.6 at
16 against 2.17 measured and 6.5 at 128 against 6.82. **Below 16 the fixed term dominates, which is why
2.4b looked flat and why the per-viewer figures in 2.2 are wrong for a pooled topology.**

⛔ **Those are flat-out arms. For a paced fleet halve them:** about **0.67 cores fixed plus 0.046 per
viewer**, fitted on paced arms the same day and predicting 1.41 at 16 against 1.34 measured and 3.61 at
64 against 3.62. See 2.2's duty-cycle subsection for why the correction is real.

### ⭐⭐ 2.4e A gateway's capacity is a byte rate, and it is 43 to 44 MB/s

✅ **Measured directly 2026-08-08**, sixteen arms scaling 128 to 512 viewers with the cohort size held
constant at 8. `docs/bench/the-ceiling-is-bytes-not-viewers-2026-08-08.md`.

⭐⭐ **Throughput plateaus at 43 to 44 MB/s.** Four concurrencies, both rounds, while demand at those
concurrencies runs 59 to 88 MB/s. Every arm above the plateau falls behind by roughly the amount it
exceeds it, so they are not failing at different points, they are failing against one wall.

⛔ **The earlier 32 MB/s figure in this section was measured with every viewer firing on the same tick**,
which is the worst case rather than the normal one. It was a burst limit. **The sustained figure is
43 to 44 MB/s.**

At this sitting's 94.4 KB per 267ms segment, one viewer needs **0.354 MB/s (2.83 Mbps)**, which puts the
wall at about **123 viewers** and brackets it exactly: 128 held at zero buffer drain in all seven of its
clean arms, 192 drained in both rounds.

| bound, one gateway, 720p, 0.25s |  viewers |                                                       |
| ------------------------------- | -------: | ----------------------------------------------------- |
| **bee throughput, cache off**   | **~123** | ✅ **measured**, bracketed by 128 holding and 192 not |
| bee throughput, cache warm      |     ~122 | ✅ measured warm, at the same 43 MB/s                 |
| host NIC, 1 Gbps                |     ~355 | ⚠️ derived, never tested                              |
| host CPU, 48 cores, pooled      |    ~1000 | ⚠️ extrapolated far past measurement                  |

⭐⭐ **The first two rows agreeing is the finding.** A warm cache does not raise the ceiling, it reduces
the work done under it. **43 to 44 MB/s is bee's ceiling wherever the bytes come from**, which is why a
cache is worth having for cost and for buffer depth and not for capacity.

✅ **It is not host CPU, not host load, and not the local link.** At **512** viewers bee used ~6 of 48
cores, host load peaked at 31.6 to 35.9 of 48, and 43 MB/s is 344 Mbps of a gigabit NIC. All three have
headroom, so the ceiling is internal to bee and **is not a capacity that can be bought**.

⭐⭐ **So a gateway's capacity is a bitrate, not a viewer count.** ⚠️ **1080p at 6000k ships and would
land near 60 viewers per gateway on the same arithmetic**, which is division rather than a measurement.

⛔ **Holding the cohort at 8 did not save any arm above 128.** 2.4f is still true and is now bounded:
cohort size decides whether an audience is served efficiently, **aggregate byte rate decides how large
it can be**, and a deployment has to clear both.

### ⛔⛔ 2.4e-bis A gateway restarted mid-event is out of service for minutes

✅ **Seen 2026-08-08** incidentally, then **replicated deliberately** with a measured decay curve
([full report](../bench/a-cold-gateway-needs-a-minute-2026-08-08.md)), and its mechanism narrowed
2026-08-09 ([full report](../bench/a-cold-gateway-is-idle-long-before-it-is-cheap-2026-08-09.md)).

Five identical 128-viewer arms after a recreate, two rounds:

| arm          | CPU per MB, r1 / r2 |       vs settled | over budget      | ended behind      |
| ------------ | ------------------: | ---------------: | ---------------- | ----------------- |
| **W1, cold** |   **0.231 / 0.220** | **2.16 / 2.06x** | **32.3 / 40.4%** | **6045 / 6785ms** |
| W2           |       0.126 / 0.128 |     1.18 / 1.20x | 0.6 / 0.5%       | 29 / 0ms          |
| W3           |       0.119 / 0.120 |     1.11 / 1.12x | 0.0 / 1.1%       | 0 / 0ms           |
| W4           |       0.101 / 0.112 |     0.94 / 1.05x | 0.0 / 0.0%       | 0 / 0ms           |
| W5           |       0.106 / 0.107 |     0.99 / 1.00x | 0.0 / 0.0%       | 0 / 0ms           |

⭐⭐ **CPU and the viewer recover on different timescales.** CPU takes three to four arms. **The viewer
is fine after one.** So a gateway is **unfit to serve for about a minute and quietly expensive for about
three**.

⚠️ The incidental observation gave 2.8x and the deliberate replication 2.1x. The difference is that the
first recreate also changed the node's funding, so **2 to 3x is the honest range** and 2.1x is the figure
measured with only the recreate varying.

### ⛔⛔ And there is no readiness signal that goes green late enough

✅ **Measured 2026-08-09** by sampling a settled node and a freshly recreated one on the same arm with
**no retrieval at all**, which separates "the retrieval path is more expensive cold" from "the node is
busy with startup work".

**Background work is not the mechanism.** Non-retrieval CPU runs at **14x for thirty seconds** and then
sits between 0.53x and 1.06x of warm for the next four and a half minutes. It does not decay, it stops.

| signal                                     | green after     |
| ------------------------------------------ | --------------- |
| `/health` answers                          | milliseconds    |
| bee's own warmup completes                 | **1.4 seconds** |
| peer count reaches its steady value        | **5 seconds**   |
| background CPU reaches its floor           | **25 seconds**  |
| **retrieval costs what it normally costs** | **minutes**     |

⛔ **Every cheap check says ready long before the node is cheap to serve from**, so a load balancer
cannot wait for a signal, because there is not one. ⭐ **The only thing that warms a gateway is retrieval
traffic.** Walk a few hundred references through a new node before admitting viewers, and count that walk
as part of provisioning.

⛔ **Treat a restart during a live event as taking that gateway out for minutes rather than seconds.**

⚠️ What the remaining cost actually is stays open. Bee's own `--warmup-time` is ruled out (it defaults to
five minutes but is a maximum, and the node logs 1.4 seconds), and so is peer discovery (381 peers on the
first sample). ⬅ Per-peer stream setup, unlearned peer selection and first-contact accounting are all
still candidates.

### ⭐⭐ 2.4f What actually limits a gateway is how many viewers arrive at once

✅ **Measured 2026-08-08**, eighteen arms sweeping how far apart paced viewers sit in playback position.
[Full report.](../bench/a-synchronised-audience-is-the-failure-2026-08-08.md) **This is the most
important subsection in section 2 and it corrects 2.4c and 2.4e.**

The prediction going in was that scattering viewers would be **worse**, since bee merges simultaneous
requests for one chunk and that merging is what pooling rests on. It was wrong in every direction.

| 128 viewers           | spread |     over 267ms |   **ended behind** |  network contacts |
| --------------------- | -----: | -------------: | -----------------: | ----------------: |
| synchronised          |      1 |   43.3 / 32.1% | **25652 / 5618ms** |   17,140 / 10,757 |
| **scattered**         | **16** | **1.7 / 1.7%** |        **0 / 0ms** | **7,956 / 6,688** |
| **scattered + cache** | **16** | **0.0 / 0.0%** |        **0 / 0ms** | **2,451 / 1,691** |

⭐⭐ **What decides it is the cohort size, meaning how many viewers land in the same instant**, not how
far the audience is spread in time:

| viewers arriving together | verdict                                                    |
| ------------------------: | ---------------------------------------------------------- |
|                     **8** | ✅ works at both 64 and 128 total viewers, zero ending lag |
|                        32 | ⚠️ unstable, 3133ms in one round and 502ms in the other    |
|                        64 | ⛔ drains 7 to 13 seconds                                  |
|                   **128** | ⛔ **failed in all six arms ever run that way**            |

⭐ **Scattering costs about HALF the network contacts, not more.** Firing 64 requests for one chunk at
the same instant does not get them merged, it gets them raced: **47 retrieval operations per distinct
chunk synchronised, against 8.4 for eight cohorts**, which is one fetch per cohort exactly as intended.

⭐⭐ **Scattered plus cached reaches the floor**: 1,691 to 2,451 contacts against ~2,300 distinct chunks
is **one network fetch per chunk serving 128 viewers.** That is what pooling promised, and it needs a
cache and a scattered audience together.

### ⛔ Which case is real, and what to do about it

**A real audience is scattered.** Players join at different moments, hold different buffer depths and
poll on timers that started whenever they started. Nothing lines them up.

⛔ **So synchronisation is a failure mode rather than a baseline, and it forms after a common shock:**
an upstream outage clearing, an encoder restart, a manifest gap every player recovers from at once.
**The recovery path is where the herd forms.** This is what one looks like: 40% of segments late and a
buffer 12.8 seconds down, on a node that carries the same viewers comfortably when they are 4 seconds
apart.

### ⛔ 2.4g Jitter does not fix it, and this document said it would

✅ **Measured 2026-08-08**, eight arms at 128 paced viewers.
[Full report.](../bench/jitter-is-not-what-breaks-a-herd-2026-08-08.md) This section originally
recommended jittering the client's request schedule. **That was wrong and it was implemented before it
was measured.**

| 128 viewers                       |     over 267ms |               **ended behind** |
| --------------------------------- | -------------: | -----------------------------: |
| no jitter, one tick               |   41.5 / 32.7% |                  9437 / 9711ms |
| **60ms of per-request jitter**    |   28.9 / 31.0% |             **8041 / 10826ms** |
| a whole segment of jitter         |    28.4 / 0.0% | 6774 / 9ms, ⚠️ rounds disagree |
| **positional spread, 16 cohorts** | **1.3 / 0.1%** |                    **0 / 0ms** |

⭐⭐ **The mechanism is chunk diversity, not arrival instant.** Viewers at sixteen playback positions
want sixteen different chunks, so the gateway has work to spread. Viewers moved sixty milliseconds are
still at one position wanting one chunk. Jitter only starts to help where it approaches a whole
segment duration and stops meaning "the same chunk, later", and that arm disagreed between its rounds.

⛔ **So do not plan on client-side jitter.** A bound large enough to matter is a latency cost at the
live edge, and it was not reliable even then. **Turn the cache on and pool viewers**, which is 2.4f's
last row and needs no client change at all.

⚠️ **Cohorts of 8 are what was proven, not 4.3 seconds of spread specifically**, and the cohorts here
are exact and evenly sized where a real audience is random and will throw up larger ones by chance.

✅ **Three of the four questions this section used to leave open have since been answered**, all on
2026-08-08, and section 2.4e carries the detail.

- **Where the knee is.** It is **between 128 and 192 viewers, and it is a byte rate**: throughput
  plateaus at **43 to 44 MB/s** across four concurrencies and both rounds. At 2.83 Mbps per viewer that
  is **~123 viewers**, and at 1080p roughly half of it.
- **Whether the limit is bee or the harness.** It is **bee**. At the top arm bee used ~6 of 48 cores,
  host load peaked at 36 of 48 leaving about twelve idle cores, and 43 MB/s is 344 of 1000 Mbps. All
  three have headroom, so **it is not a capacity you can buy**.
- **What a randomly distributed audience does** rather than an evenly cohorted one.

### ✅ 2.4h The feed does not care how many are reading it, and that retires LAT-11's row

**The one no reference-list probe could see is measured, 2026-08-09, and it is a null.**
[Report.](../bench/the-feed-does-not-care-how-many-are-reading-it-2026-08-09.md) 54,400 slot reads
across 20 alternating arms, for one cheque of 77 gwei.

⭐⭐ **A feed read at 128 concurrent readers costs what it costs at one.** Four interleaved
single-reader references span **426 to 480ms** for a miss with nothing happening, and every loaded arm
from 8 to 128 sits inside that spread. Hits are 1-2ms throughout, no errors at any concurrency. **A
reader sustains 4.81 slot reads a second at one and 4.69 at 128**, a 2.5% loss for 128x the audience.

⛔ **LAT-11's 1.30x went through the `/feeds/` head lookup**, which was later shown to be 50-57% frozen
on its own and which the client no longer uses. On the explicit-address path a client actually walks,
the effect is absent at 8, at 32 and at 128. **Retrieval scales, and so does the feed.**

⛔ **What does move is the tail, and only for a synchronised audience**: reads crossing one second run
**0.42% for a cohort all wanting the same slot against 0.065% for readers wanting different ones**,
6.4x, while the medians of those same arms are indistinguishable. ⭐ **Instrument the crossing rate,
not the median** — this is 5.1 again, on a different subsystem.

⚠️ **It measures what a read COSTS, not how far behind live a viewer ends up**, because there was no
live publisher. Closing that gap is a job for a simulation that has one.

---

### ⭐⭐ 2.5 Reading the feed is a different cost from reading a segment, and it is a MISS cost

✅ **Measured 2026-08-09**, two halves. 78,482 slot reads mined from 70 archived browser request logs,
which cost nothing at all, and 800 reads straight at the gateway, which cost **0.0000615 BZZ**.
[Full report.](../bench/the-announcement-floor-is-a-miss-floor-2026-08-09.md)

A client finds the head of a feed by reading slots until one comes back 404. So **a viewer at the live
edge misses about 45% of the time**, and that turns out to be where the time goes.

| direct at the gateway |  miss | hit | ratio |
| --------------------- | ----: | --: | ----: |
| run 1                 | 459ms | 7ms |   66x |
| run 2                 | 483ms | 4ms |  121x |

⭐⭐ **A not-found slot read costs about 480ms and a successful one costs single-digit milliseconds.**
The miss figure is the same measured through a browser (496ms) and measured directly (483ms), while the
hit figure is 17 to 30x apart, so **the floor is a gateway-side lookup and no client change moves it.**

⭐ Not-found has a characteristic cost, not a timeout: **66.4% of misses land in one 400-599ms band.**

⭐⭐ **A miss costs no BZZ.** Per-block attribution across 400 reads: the hit blocks wrote one cheque and
**both miss blocks spent nothing**, as did every idle control. A not-found delivers no bytes, so no peer
is owed. ⛔ **So speculative reads are free in money and expensive in time**, and ⚠️ **the 43 to 44 MB/s
ceiling in 2.4e cannot see them at all**, because they move no bytes. If your simulation reasons about
gateway load in bytes it will under-count feed traffic entirely.

⭐ **Reading ahead is linear and there is no cheaper distance.** A single-owner chunk's address is a hash
of its identifier and its owner, so slot N+1 and slot N+100 sit at unrelated addresses. Read-ahead by N
costs N misses.

⛔⛔ **The design consequence: the way past a miss floor is not a cheaper poll, it is not polling.** A
push primitive lets a publisher say "slot N exists" instead of every viewer discovering it by failing to
find slot N+1. ⚠️ Swarm has GSOC and **nothing here has measured it**, so treat that as a direction
rather than a finding.

⚠️ **And it is what to check before believing anything about LL-HLS.** Smaller parts mean more
speculative reads, so the floor gets asked more often, not less. ⬅ Wash or loss is unmeasured.

## 2z. What the NETWORK sees: a load model for a multi-stage event

**Written 2026-08-10 for the Devcon question.** Everything above characterises **our gateway**. This
section is the only place that turns those measurements outward and asks what load the **swarm** sees,
because that is the question an event actually poses.

⛔⛔ **Read the boundary first. We cannot tell you the network's capacity.** Nothing in this repository
measured the swarm's aggregate headroom, and no amount of single-gateway work can. **What this section
does is bound OUR demand and identify which decisions move it by orders of magnitude.** That is a
different claim and a weaker one, and it is still the useful one, because our demand is the only term
we control.

### 2z.1 The unit the network actually feels is a CHUNK REQUEST, not a viewer and not a byte

At 720p / 2500 kbps / 0.25s, per stream:

|                                                          |                                          |
| -------------------------------------------------------- | ---------------------------------------: |
| segment                                                  |                                    94 kB |
| Swarm chunk                                              |                               **4096 B** |
| chunks of payload                                        |                                    23.05 |
| **chunks actually fetched per segment**                  | **26.2**, ~14% tree and wrapper overhead |
| segments per second                                      |                                     3.75 |
| **chunk retrievals per second, per stream, per gateway** |                                  **~98** |
| real peer contacts per chunk, funded                     |                                **1.142** |
| **peer requests per second, per stream, per gateway**    |                                 **~112** |

⚠️ **Derived**, by dividing measured segment sizes by the measured chunk size and multiplying by the
measured per-chunk contact count. Every input is measured, the multiplication is not.

### 2z.2 ⭐⭐⭐ Pooling is worth about 100x. It is the single decision that decides the whole question.

A gateway fetches each distinct chunk **once** and serves every viewer behind it from that fetch, so
network demand scales with **gateway-stream pairs**, not with people. Twelve stages, 200 viewers each,
2,400 viewers total:

| topology                                                          | peer requests per second at the swarm |  relative |
| ----------------------------------------------------------------- | ------------------------------------: | --------: |
| **pooled behind gateways** (24 gateway-stream pairs)              |                            **~2,700** |    **1x** |
| every viewer its own light node                                   |                              ~269,000 |  **100x** |
| every viewer a browser node, IF its 6-peer constant means 6 sends |                            ~1,600,000 | **~600x** |

⭐⭐⭐ **So the architecture question is not "can the network take Devcon". It is "does Devcon arrive
pooled or unpooled", and those two differ by two orders of magnitude on identical content.** A pooled
event is a rounding error against normal network traffic. An unpooled one is a load test nobody agreed
to run.

### 2z.3 ⛔⛔ The funding multiplier is 13%, NOT 38x, and this document said 38x for weeks

The unfunded arm shows **39.41 peer-selection iterations per chunk** against 1.14 funded. **Those are
not requests.** `bee_retrieval_request_attempts` increments **before** the accounting call that decides
whether to contact the peer at all, so a skipped peer is counted and never asked. Subtracting skips:

| arm      | attempts | − skips | **real contacts** | per chunk |
| -------- | -------: | ------: | ----------------: | --------: |
| funded   |   23,924 |       5 |            23,919 | **1.142** |
| unfunded |  825,931 | 799,072 |        **26,859** | **1.281** |

⭐ **An unfunded node sends about 13% more RETRIEVAL requests. It does 34x the bookkeeping and 1.13x the
retrieval traffic.**

⛔⛔ **But 13% counts retrievals only, and this document said "13% network load" without that
qualification.** An unfunded node cannot write cheques, so its only way to clear debt is pseudosettle,
and it sends **10.9x more settlement messages**:

|                     | funded | unfunded |     ratio |
| ------------------- | -----: | -------: | --------: |
| retrieval requests  | 23,924 |   27,012 |     1.13x |
| settlement messages |    957 |   10,422 | **10.9x** |
| **total messages**  | 24,881 |   37,434 | **1.50x** |

⭐ **So which number is right depends on what is scarce.** A settlement message is tiny and a retrieval
drags a 4 kB chunk back with it, so **in bytes the penalty is ~13%** and **in messages and connections it
is ~50%**. Quote whichever the constraint is, and say which one you meant.

⚠️ **Operationally this is what a dry chequebook means:** the node does not simply slow down, it becomes
**noisier and less useful at the same time**, generating half again as many messages while serving its
viewers worse, and reporting itself perfectly healthy throughout.

⛔ **What funding actually decides is the VIEWER's experience, not the network's load**: 0.0-0.3% of
segments over budget funded, against **11.6-15.0% unfunded**. Fund nodes because unfunded viewers get a
bad stream, not because they hurt anyone else.

⚠️ **And apply the same suspicion to weeb-3's `RETRIEVE_CHECK_CONFIRMATION_PEERS = 6`.** That constant
was read from source and **never verified to be six sends rather than six candidates**. bee taught us
that exact lesson at a cost of a wrong figure carried for weeks. **The browser row in 2z.2 is the least
trustworthy number in this document.**

### 2z.4 ⭐⭐ Chunks spread. Feeds concentrate. That is the only structural hot spot.

**Segment chunks are content-addressed**, so a stream's chunks scatter uniformly across the address
space and their load lands on the whole network rather than on any neighbourhood. Nothing to manage.

⛔ **A feed is one address.** Every viewer of a stage polls the same single-owner-chunk address, which
lives in **one neighbourhood**. That neighbourhood is the only place an event concentrates load.

| topology                        | pollers on one feed address |
| ------------------------------- | --------------------------: |
| pooled, 2 gateways per stage    |                       **2** |
| unpooled, 200 viewers per stage |                     **200** |

✅ **Measured, and it is why pooling matters twice**: a feed read at 128 concurrent readers costs what
it costs at one, through a gateway. That result was taken **through gateways**, so it says pooled feed
traffic is free. **It says nothing about 200 independent nodes polling one neighbourhood**, which is
exactly the unpooled case and is unmeasured.

⛔ **And about 45% of live-edge feed reads are not-founds**, each costing about 480ms and zero BZZ.
Speculative reads are **free in money and expensive in time**, and the 43-44 MB/s ceiling **cannot see
them at all** because they move no bytes. A load model that reasons in bytes will under-count feed
traffic entirely.

### 2z.5 The write side, which nothing here has ever tested

Twelve stages publishing simultaneously, derived from the same per-stream arithmetic:

|                                                               |                                   |
| ------------------------------------------------------------- | --------------------------------: |
| chunks written per second, all stages                         |                        **~1,180** |
| feed updates per second (one SOC write per segment per stage) |                           **~45** |
| before neighbourhood replication                              | multiply by the redundancy factor |

⛔⛔ **Every measurement in this repository is ONE stream.** Concurrent publishing has never been run,
so the table above is arithmetic with no experimental support whatsoever, and the uploader's behaviour
under fifteen simultaneous broadcasts is genuinely unknown. **This is the largest gap between what we
know and what an event requires.**

### 2z.6 What we can say, and what we refuse to say

✅ **We can say**, with measurement behind it:

- A pooled event's swarm-facing demand is **~2,700 peer requests per second** for twelve stages and
  2,400 viewers, and that is small.
- **Pooling changes that by ~100x**, unpooling by the same factor in the other direction.
- **Funding changes network load by ~13%** and viewer experience by **50x** in late-segment share.
- **Feeds are the only hot spot**, and pooling keeps them cold.
- **A cache does not raise any ceiling**, it reduces work under one.

⬅ **We refuse to say**, because nobody measured it:

- Whether the swarm has headroom for this on top of its normal traffic. **Out of scope for this repo
  and not answerable from here.**
- How a fleet of gateways behaves. Every fleet number is a single node divided.
- What fifteen concurrent publishers do to an uploader, a bee node, or a postage batch.
- Whether 200 independent light nodes polling one feed neighbourhood is fine or is a hot spot.
- Whether weeb-3 really sends six requests per chunk.

⭐⭐⭐ **The single most useful thing this analysis produces is not a capacity number. It is that the
three decisions which matter most (pool or not, fund or not, feed design) are all OURS, and two of them
are free.** The network's capacity is the term we cannot control and, if the event is pooled, the term
we probably do not need.

## 3. How to measure: the statistics

### 3.1 ⛔ Rate of crossing, not central tendency

**This is the most important section in this document.**

The failure mode is a buffer draining. A buffer drains on **late** segments, not on typical ones. So
the statistic that predicts failure is the **share of retrievals that cross a threshold**, not the
middle of the distribution.

✅ **Measured, from archived request logs of two sittings:**

| arm              | median | over the 267ms budget | **≥1s per 1000** | outcome             |
| ---------------- | -----: | --------------------: | ---------------: | ------------------- |
| 08-06 funded     |   91ms |                  0.4% |          **0.0** | ✅ clean            |
| 08-06 unfunded 1 |  156ms |                 31.9% |         **17.4** | ⛔ 3 rebuffers      |
| 08-06 unfunded 2 |  172ms |                 33.3% |         **21.7** | ⛔ **17 rebuffers** |
| 08-08 unfunded 1 |  132ms |                 23.1% |          **0.5** | ✅ clean            |
| 08-08 unfunded 2 |  146ms |                 24.0% |          **1.6** | ✅ clean            |

⭐ **Between the night that collapsed and the night that held, the median moved 1.18x and the
one-second rate moved 10 to 40x.**

⭐ **Twelve stall events in 689 requests is 1.7% of them.** They cannot move a median and they are the
entire failure.

**So report, per node and as a fleet distribution, never pooled into one average:**

1. **share of retrievals over the segment budget** (budget = segment duration in ms)
2. **retrievals ≥1s per 1000**
3. the median, if you like, but never as the headline

### 3.2 Why one second, and why it bursts

⚠️ **Every stall measured is 1.0 to 1.1 seconds.** Not a spread, a value. That is a **retry timer**: a
retrieval finds no peer it is allowed to pay, waits out a fixed timeout and tries again.

⚠️ **They arrive in bursts.** In the worst arm, six of twelve landed inside a 3% window. One
one-second stall against a 267ms budget puts a player four segments behind, which a 4.8s buffer
absorbs without a mark. **Six in a row is a rebuffer.**

### 3.3 Node-side counters: what a browser cannot see

A browser can see that a retrieval took a second. It cannot see whether that second was a peer
refusing, a retry timer, or a route being rebuilt. Bee's `/metrics` can. It is 1068 lines and about a
dozen answer anything:

| counter                                                 | what it tells you                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `bee_accounting_accounting_blocks_count`                | peers skipped to avoid crossing their disconnect thresholds. **The starvation signal** |
| `bee_retrieval_request_attempts_{sum,count}`            | peer-selection **iterations**, see 2.2                                                 |
| `bee_retrieval_peer_request_count`                      | same thing. **Not** requests on the wire                                               |
| `bee_retrieval_request_duration_time_bucket{le="1"}`    | `count − this` = **retrievals that took ≥1s**. The retry timer, counted at the node    |
| `bee_retrieval_request_duration_time_bucket{le="0.25"}` | the budget crossing, counted at the node                                               |
| `bee_retrieval_request_attempts_bucket{le="1"}`         | chunks served by the **first** candidate peer                                          |
| `bee_pseudosettle_sent_pseudosettlements`               | how hard it is trying to settle                                                        |
| `bee_retrieval_request_failure_count`                   | genuine failures. Nearly identical across funded and unfunded                          |
| `bee_accounting_disconnects_*`                          | peers that actually dropped it                                                         |

⭐ **Reduce on the host, not over the wire.** At a thousand nodes, shipping `/metrics` and `/balances`
whole is its own load. `/balances` is ~45kB per node. Reduce to a line of `name=value` pairs at the
source. Section 6.

⭐ **Reach for `/metrics` as soon as service time, host load and peer count fail to explain something.**
That is what separated "ultra-light is slower" from "ultra-light is starved", and it cost 0.11 BZZ.

### 3.4 Cost, in bytes and never in minutes

### The per-MB figure, and why an earlier one was wrong

| source                                       |    BZZ | network MB | **BZZ per MB** |
| -------------------------------------------- | -----: | ---------: | -------------: |
| funding-cliff arm, cache off, all network    | 0.0500 |         74 |    **0.00068** |
| cache sitting, 4 funded arms, network bytes  | 0.0848 |       ~111 |    **0.00076** |
| **the figure this project quoted for weeks** |        |            |    **0.00085** |

⭐ **Use ~0.0007 BZZ per MB.** The long-quoted 0.00085 is about 40% high. The cliff arm is the cleanest
single measurement available: 0.05 BZZ bought exactly 74 MB with caching off, watched drain to zero.

### ⭐⭐ The rate is the bitrate, and every profile is now measured

✅ **Measured 2026-08-09**, eight arms on a funded gateway, four profiles alternating, two rounds, 30 MB
apiece. **0.1633 BZZ and zero broadcast minutes**, because the archive holds thousands of segment
references at each profile size and they all still resolve.
[Full report.](../bench/what-a-gateway-burns-at-each-profile-2026-08-09.md)

```
BZZ/min  =  MB/min x 0.000678
```

⭐⭐ **The per-MB rate is flat across an 8.5x range of segment size.** All eight arms landed between
0.000644 and 0.000708 BZZ per MB, a spread of 9.4%, with no ordering by size. **Mean 0.000678.** Use that.
The 0.00085 quoted for weeks is 25% too high.

| profile                                       |    segment |   MB/min | **BZZ/min** | **BZZ/hour** |
| --------------------------------------------- | ---------: | -------: | ----------: | -----------: |
| 2500 kbps @ 0.25s                             |      94 kB |     21.1 |  **0.0143** |    **0.857** |
| **6000 kbps @ 0.25s**, ⛔ not the shipped GOP | **213 kB** | **47.9** |  **0.0325** |    **1.948** |
| 2500 kbps @ 1.0s                              |     346 kB |     20.8 |  **0.0141** |    **0.844** |
| 6000 kbps @ 1.0s                              |     792 kB |     47.5 |  **0.0322** |    **1.931** |

⭐⭐ **1080p at 6000 kbps costs a viewer's gateway 0.0325 BZZ a minute, 1.95 BZZ an hour.** It shipped
without that number existing. The figure derived before it was measured was 0.0315, **right to within
3%**.

⛔⛔ **There is no GOP premium, and this document previously said there was.** It claimed a 0.25s GOP was
"roughly 15% dearer per minute" off two hand-read samples. Measured, at the same bitrate, the two GOPs
cost **0.0143 against 0.0141** and **0.0325 against 0.0322**, because the encoder delivers the same byte
rate either way. **The resilient profile is free.**

⭐ **Feed reads add nothing to the bill.** A not-found slot read costs about 480ms and **zero BZZ**, so a
viewer's gateway burn is segment bytes and nothing else. See 2.5.

⭐ **Price is per byte, not per second.** One round ran with a far heavier tail, p90 rising from 67 to
654ms while medians barely moved, and **the BZZ per MB did not change**. A gateway pays for bytes, not
for how long they took.

⚠️ ⬅ **Archived segments, not the live edge.** The rate is per byte and should not care, but whether a
live-edge read costs more than an archived one is unmeasured. **That is now a validation rather than a
discovery**, and it is the only part of this a live broadcast would still add.

### ⛔ Three honesty notes on cost

1. **An earlier gateway figure of 0.123 BZZ per 30 minutes was 2.5x too low**, because it came from two
   readings taken by hand at different times. **Sample continuously or do not quote a burn rate.**
2. **The uploader side is inconsistent.** Four different per-minute figures appear in this project's
   record for what looks like the same thing (0.0134, 0.0170, 0.0179, 0.0214 BZZ/min). Nobody has
   reconciled them. **Do not quote an uploader burn rate without naming its measurement.**
3. **Price runs in bytes, not minutes.** A 1080p arm costs 2.4x a 720p arm of the same duration.

### ⭐ An unfunded-only sweep is free

**A node with no chequebook cannot spend.** Eight of the eleven unfunded arms in the definitive sweep,
and every arm of the concurrency sweep, cost nothing at all. If your simulation is about unfunded
viewers, **the viewers are free** and only the publisher and any funded controls cost anything.

### ⭐⭐ What an event costs, with 2.1b and 2.4b applied

Funding is a switch at zero, so `BZZ per node = burn x duration` and any more is idle capital. Sixteen
viewers share one gateway's fetches, so gateways is roughly viewers over sixteen.

**1,000 viewers, two hours, 720p:** 63 gateways x 0.0102 x 120 = **about 77 BZZ**, against about
**1,220 BZZ** for one node per viewer.

---

## 4. How to design the load test

### 4.1 ⭐ Split retrieval capacity from playback quality

**Do not run a browser per node.** They answer different questions and only one of them needs scale.

|       | question                                    | instrument                                            | N         |
| ----- | ------------------------------------------- | ----------------------------------------------------- | --------- |
| **A** | can the network serve this many retrievers? | **headless reference-list probe** plus bee `/metrics` | thousands |
| **B** | does the picture actually hold?             | a real browser                                        | a handful |

Arm A is how the entire funding mechanism was found, for **0.184 BZZ and thirteen minutes**: fetch a
**fixed list of references in a fixed order**, with no encoder, no publisher, no upload and no postage,
because the segments are already on Swarm from a previous run. It scales trivially and it produces the
statistics in 3.1.

Arm B is expensive, fragile and irreplaceable: it is the only thing that sees a rebuffer. A handful of
real browsers is enough.

⭐ **You already have a free corpus for arm A.** Every browser run in this repository wrote a
`.requests.json` companion holding **every URL a real viewer fetched**, with status, bytes and
timings. Two published results were derived from those files for nothing. Replaying a real viewer's
request sequence is more faithful than any synthetic pattern you will write.

### 4.2 The arms worth spending on, in order

1. **The funding cliff.** ✅ **Answered 2026-08-08, see 2.1b.** It is a switch at zero. Fund each node
   for its burn times the event duration and no more.
2. **Cache on against off**, in the pooled topology. Section 2.3.
3. **Fleet size**, to find the knee. Section 2.4.
4. **Thundering herd against staggered join.** ⬅ Entirely open. A thousand nodes joining at once ask
   for the same chunks at the same moment.
5. **Node density per host**, which 2.2 says is the real constraint.

**GOP is already answered**: 1.0s absorbs the failure, 0.25s does not.

### 4.3 ⛔ Warm up, or you will measure peer discovery

✅ **Measured.** The first retrieval after a container recreate took **8.5 to 10.4 seconds** in every
arm, funded and unfunded alike. The same fetch after ninety seconds of idle took **0.03s**.

⚠️ **And the disturbance outlives that one fetch.** Every arm above 8% late followed a recreate, and
the three arms measured on a continuously running node were the three best of eleven.

**A thousand nodes spun up at once are all cold.** Spin up, warm, then start the clock. Discard the
warm-up fetch explicitly rather than hoping it averages out: left in, it moved every maximum, every
p99 and every elapsed figure.

### 4.4 ⛔ Never compare arms across sittings

✅ **Two sittings of one identical configuration differed by 1.05 seconds**, which is larger than most
effects worth chasing. **Interleave arms within one sitting**, so drift subtracts out.

### 4.5 ⛔ Establish your noise floor by mislabelling data where nothing happened

**This is the check that saves you from a confident wrong answer.**

The obvious concurrency design is a ladder: 1 → 2 → 4 → 8 viewers, six minutes each. Before reading any
result, the same analysis was run on **eight past runs where the viewer count never changed**, slicing
each into quarters and labelling the quarters as if load had varied. **The metric moved by up to 1.95x,
median 1.41x, with nothing changing at all.**

A ladder reads exactly one such quarter per level, so it could not resolve anything under ~2x, and the
effect being chased was ~2.6x. **It would have produced a confident number either way.**

What worked instead: **short alternating blocks**, each loaded block paired against the quiet block
beside it. Two load-bearing details: the **block length must not be a multiple of any periodic
artifact** in the system, and the **reference reader must be unchanged across phases** so each phase is
its own control. Validated at **zero false positives across seven unchanged runs**, resolution ±15%
against the ladder's ±95%.

### 4.6 A run that cannot prove its instrument is valid must report VOID

Not a number. This project spent a week on a 578-second latency reading produced by a browser pane that
was never foregrounded. The fix was a ten-second self-check that answers "is this browser a usable
instrument" with no broadcast and no BZZ, plus per-sample validity checks (`visibilityState`, timer
fidelity, codec support) that make a run report **VOID** rather than a plausible number.

⭐ **It earned its keep immediately by catching a clock overlay that silently never rendered.**

---

## 5. Traps, each with the evidence that it is real

Every one of these cost real time or real money here.

### 5.1 ⛔ A metric can be correct and still be the wrong statistic

Medians passed every control, every consistency check and every sanity read, and understated the
effect by **15x**. **No check catches this.** The only defence is asking, before you measure, "what
shape of failure am I predicting?" If the answer is "a threshold being crossed", your headline must be
a rate of crossing.

### 5.2 ⛔ A counter can mean something other than its name

Section 2.2. `peer_request_count` sounds like requests to peers. It is loop iterations. **Read the
source of any counter a conclusion rests on.**

### 5.3 ⛔ One non-fatal stall permanently re-tiers a node

hls.js **raises its latency target after a non-fatal stall and never lowers it.** A node that took one
stall has a different target for the rest of the run and is no longer comparable to one that did not.

⚠️ **At a thousand nodes this silently splits your fleet into two populations**, and any fleet-wide
latency average mixes them. **Record each node's latency target alongside its latency and stratify by
it.** This voided a 1080p control here and made every instrument read zero.

### 5.4 ⛔ An engine's declared segment duration can be wrong

SRS reports `#EXTINF` values **20-25% longer than the media actually is**, on healthy streams, at every
GOP length tested. Verified by reading the transport packets' own presentation timestamps: media was
0.2667s per segment dead constant, declared 0.3205s jittering.

**Any figure derived from a manifest inherits that factor**, including advertised duration, target
duration and any latency computed from a playlist. **Derive segment duration from the bytes.**

### 5.5 ⛔ A cache test that fetches each item once tests nothing

Section 2.3. It will pass cleanly and tell you caching does not help.

### 5.6 ⛔ A discarded warm-up can still poison your counters

Found in this repo **today**, while writing the instrument for this document. The probe discarded the
warm-up fetch's _timing_ but read the node's counters _before_ it, so the warm-up's 8-10 second chunks
landed in the ≥1s bucket. That would have given **every arm a fake 11.6% one-second-stall rate, in the
exact counter added to measure the real one.**

**Whatever you discard, discard it from every instrument, not just the obvious one.**

### 5.7 ⛔ CPU measured from a fresh container bills startup to your workload

Two identical funded arms came out **0.57s and 0.91s** on startup noise alone. Measure the node's idle
CPU rate first and subtract it. Idle is **0.011 to 0.019 CPU-seconds per second** for a bee gateway
doing nothing.

### 5.8 ⛔ Four ways a check reported nothing and it read as a pass

Collected here over months: a zsh pipeline whose exit status came from the wrong element, an empty glob
that matched no files, a CI conclusion of `""` treated as success, and a wrapper that swallowed its
child's exit code. **A check that cannot fail is worse than no check**, because it is counted as
evidence.

### 5.9 ⛔ A clean result at one point on an axis is not a result about the axis

Testing at one bitrate and concluding about bitrate. Testing at one fleet size and concluding about
scale. Name the axis, then test at least two points on it.

### 5.10 ⚠️ Making a timing test stable can make it unfalsifiable

Injecting the clock is right. Reporting alongside the thing under test rather than gating on it is
how a test stops being able to fail.

### 5.11 ⛔⛔ A check whose answer sits at the value it starts from

Three of these turned up in one hour while building the recovery scenarios, and **none of them could
have failed against a completely broken system**:

- waiting for `activeStreams == 0` after a reboot, which is **already true in the first poll**, before
  the recovery pass has registered anything
- reading a log window stamped **after** the process started, so the boot lines being asserted on were
  written before the window opened
- a helper that read the last 1000 log lines for a value that is only re-logged when a broadcast runs,
  which worked **only because every scenario publishes just before the next one looks**

⭐ **The move: before asserting a state, assert that the transition into it happened.** One extra wait
for "the recovery pass said what it found" turns _nothing is active_ from a tautology into a result.

⭐ **And run a new test alone at least once, deliberately.** The third one had been in the repo the
whole time and no run could have exposed it, because nothing had ever run one scenario on its own. **A
suite whose members quietly prepare each other's preconditions only works as a whole, and nothing says
so until you take one out.**

### 5.12 ⛔ Error text is not the discriminator, the outcome is

Three playback runs of a ~200 second recording: one failed every seek, two passed every seek. **All
three log the same family of `bufferAppendError` and `InvalidStateError` warnings**, and the healthy
runs throw them while seeking perfectly. A check written against the error text would have condemned
every arm and found nothing.

⭐ What separated them was one structural fact, visible only by asking the player what it had **built**
rather than what it complained about: the failing run had **three audio SourceBuffers and no video
SourceBuffer at all**, and appended 208 KB where the healthy runs appended 27 MB. **Ask a component
what state it is in, not what it is saying.**

✅ **Followed to the end, that one fact gave the whole cause, for nothing.** The failing run's
recording opens with four segments holding **41 AAC packets and zero video packets**; video appears
from the fifth. The player fixes its codec set from the first fragment it parses and never revises it,
so it built an audio-only buffer set and then refused every later video sample. The structural
question was answerable from the archive; the error text never would have been.

### 5.13 ⛔⛔ A matched control is not a replicate

The same three runs produced a finished, wrong write-up. Runs one and two were a clean matched pair:
same producer, same harness, same seek targets, lengths within 7%, **one variable** (a discontinuity in
the recording), and the result was **0 of 3 seeks against 3 of 3**. The document said "a recording
containing a discontinuity cannot be seeked." Run three had the discontinuity and seeked perfectly.

⭐ **A control removes the variable you are thinking about. It cannot tell you the failing arm
reproduces.** Those are different questions and only the second one licenses a causal claim.

⛔ **The effect being total is what made publishing off one pair feel safe, and that instinct is
backwards.** A 0-of-3 against 3-of-3 is exactly as capable of being a single bad run as a marginal
effect is. **Budget a replicate of the failing arm, not just a control for it** — here each run was a
few hundredths of a BZZ, so the replicate cost less than the retraction would have.

### 5.14 ⛔⛔ An instrument that produces an artifact has to check the artifact is usable

The script that made those recordings checked its variable carefully in **both** directions: it refuses
if the arm armed no discontinuity, and refuses if the control armed one on its own. It never checked
that the media it produced had a picture in it. So it handed back a recording that could not play,
reported success, and the playback run against it read as an intermittent player defect for a day.

⛔ **This matters far more at scale than it did here.** A load test that spins up hundreds of encoders
will have some of them throttled at startup, and a stream whose **first** segment carries no video
becomes a recording that plays as sound over a blank picture **for its entire length**, complaining
only with a warning the player marks non-fatal. At one stream you notice. At three hundred you compute
an average over a population that quietly includes broken ones.

⭐ **The check is nearly free and it is upstream of everything.** The producer already knows: the
uploader's own duration parser answers `it holds no video packets, so the media never reached the far
end` for exactly these segments, and counts them in `segment_durations_unread_total`. Alarm on that
counter and refuse the artifact, rather than discovering it in a player three steps later.

⚠️ **Anchor the check on the reason, not on the warning.** The same warning fires for a segment whose
timestamps are unusable, which costs no picture. A check matching the warning refuses good artifacts
and sends someone hunting a video problem that is not there.

✅ **The uploader now fixes this at the source rather than only reporting it**, which is what makes it
survivable at three hundred encoders: a video stream's opening segments are **withheld** until one
carries a frame, so the first fragment every player parses has a picture in it. See 5.15 for the part
that is harder than the withholding.

### 5.15 ⛔⛔ A guard that cannot be wrong is a guard that can take you off the air

Withholding the videoless opening is four lines. The bounds around it are the design, and every one of
them exists because the guard's own failure mode is worse than the fault it prevents.

| bound                                                             | what it stops the guard doing                                                                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **never for an audio stream**                                     | every segment of one carries no video, so the guard would publish **nothing at all**, for the whole broadcast                                              |
| **give up at 10 seconds of media** and publish anyway, loudly     | a publisher that never sends a frame under a video mediatype would otherwise be silenced by the guard rather than by its own fault                         |
| **publish bytes that are not a transport stream**, and stay armed | zero video packets is equally what any container you cannot parse looks like. Withhold on that and an engine you do not understand loses **every** segment |

⭐ **The third one is the transferable lesson and it is not about video.** "I could not find X" and
"there is no X" are the same return value from most parsers, and a guard that acts on the second while
reading the first will fire hardest exactly where you understand the input least. Make the parser
answer both questions separately before you act on either: here that meant counting audio packets as
well as video ones, so **media with no picture** and **bytes that are not media** stopped being the
same reading.

⭐ **Pair the counter with a second one before you alarm on it.** Withheld segments climbing and then
stopping is the guard working. Withheld climbing while uploads stay flat is a publisher sending no
frames. Neither number says which on its own, and a scale run wants the difference.

---

## 6. The toolkit

All paths are relative to the `swarm-hls-stream` repository. These are meant to be **read and ported**,
not imported.

| file                                          | what it does                                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/scripts/retrieval-debt-probe.sh`      | the reference-list probe. Fixed refs, fixed order, arms as `label:swap:idle[:cache]`, N passes per arm, per-arm bee counters, per-arm gateway CPU, restores the node by EXIT trap and confirms the restore **against the node** |
| `deploy/scripts/gateway-retrieval-metrics.sh` | bee's 1068-line `/metrics` reduced to ~18 `name=value` pairs, on the host                                                                                                                                                       |
| `e2e/src/browser/gatewayHealth.ts`            | the peer-accounting sampler. Reduces a 45kB `/balances` **on the host** to five numbers so it never crosses the wire                                                                                                            |
| `docs/bench/*.requests.json`                  | every URL a real viewer fetched, with status, bytes and timings. A free replay corpus                                                                                                                                           |
| `e2e/src/browser/playerProbe.ts`              | source buffers, appends, media events, per-track buffered ranges, and every media element on the page                                                                                                                           |

### The probe's shape, if you port nothing else

```
for each arm:
    set the node's configuration and CONFIRM IT AGAINST THE NODE, not the config file
    warm up, discard the fetch, and read counters AFTER the warm-up
    measure the node's idle CPU rate over a fixed window
    for each pass:
        fetch every reference in the list, in order, timing each
        report that pass on its own
    read counters and CPU again
    report: share over budget, >=1s rate, CPU per MB, and the accounting deltas
restore the node by EXIT trap on every path, and confirm the restore against the node
```

⭐ **"Confirm against the node" is not ceremony.** An env file says what was asked for. A running
container says what is true. The probe reads the arm back from `/chequebook/balance` and from the
container's own arguments.

---

## 7. What we could not answer here

✅ **The funding cliff. Answered 2026-08-08**, see 2.1b. It is a switch and it flips at zero.

✅ **Concurrency to 512. Answered 2026-08-08**, see 2.4b through 2.4f. The wall is **43 to 44 MB/s
sustained**, which is ~123 viewers at 2.83 Mbps, and it is internal to bee rather than host or link.
⬅ **Still open: the same plateau on a FUNDED gateway.** Saturating arms means bytes, and N256 plus N384
at two rounds is about 7,250 MB, roughly **5.1 BZZ**, which is most of a 6.32 BZZ chequebook. Probably
not worth buying.

⬅ **The retry timer's wall-clock shape at the node.** It is inferred from the client side. Bee's
`bee_retrieval_request_duration_time` histogram now reaches the sampler here but has not been read
during an unfunded arm.

⚠️ **What varies between identical unfunded runs. The strongest lead is now confirmed.** Eleven arms
spanned 1.9% to 19.5% late and neither idle, debt level nor arm order accounted for it, with a container
recreate named as the likeliest cause. **2.4e-bis measures it: the arm after a recreate cost 2.1x the CPU
per MB and put 32 to 40% of segments over budget against 0.0% warm**, reproducibly across two rounds, and
the mechanism is narrowed to the retrieval path rather than to startup housekeeping. ⬅ It still does not
explain every arm, so treat it as the largest known term rather than the whole answer.

✅ **How the CPU cost behaves under a realistic duty cycle. Answered 2026-08-08**, see 2.2 and 2.4d.
Per-MB holds within 20%, per-viewer halves. What replaces it is narrower: ⬅ **whether a
time-scattered audience behaves like the synchronised one measured here**, since scattered viewers lose
the pooling that carried these arms and should lean on the cache instead.

✅ **Whether cache eviction bites at event scale. Answered 2026-08-08**, see 2.3c. It is a cliff, and
the cliff has since been located: **a cache at 76% of the working set is byte-identical to no cache, one
at 100.1% buys the entire benefit, and anything above that buys nothing more.** ✅ **And how much a real
re-read pattern beats that cyclic scan is now measured too, 2026-08-09**: the same 76% capacity removes
**37% of retrievals** under a skewed pattern and serves its median second-lap fetch in **4ms**.
⛔⛔ **And the sweep that went looking for the new cliff found there is none**: under skew the cache is
a **dial, not a gate**, a smooth curve from 4% of retrievals removed at 0.24x the hot set to 37% at
3.8x, with **no step anywhere, including at the hot set itself**. Early capacity is worth about **2x
its share**, so buy what you can afford and stop looking for a threshold to clear. ⚠️ The 100% step is
real **only for a cyclic scan**, which has no hot set because every reference is equally popular, and
capacity is counted in **chunks, not bytes** (1 GB ≈ 280,000).

⬅ **Whether ultra-light's ~0.5s higher median latency is real.** Not established: the one comparable
funded arm took a non-fatal stall, so per 5.3 it has no valid control.

---

## 8. If you read nothing else

- **Measure rate-of-crossing, not medians.** The budget is the segment duration.
- **Pace your load like a player, and measure the lag it accumulates.** A flat-out fetcher is a load
  generator: it overstates a viewer's CPU by 2x, and the share of late segments cannot tell a viewer
  that recovers from one whose buffer is draining. The lag a viewer _ends_ on can, and it was zero at
  64 viewers and 8 to 11 seconds at 128.
- **Split retrieval capacity (thousands, headless) from playback quality (a handful, real browsers).**
- **Warm every node before the clock starts**, and interleave arms within one sitting.
- **Establish your noise floor by mislabelling data where nothing happened**, before trusting a design.
- **Read bee's own counters**, and read the source of any counter a conclusion rests on.
- **Price runs in bytes.** Unfunded nodes are free.
- **Pool viewers behind gateways, and never let them arrive together.** Sixteen on one node cost the
  network what one costs. But 128 viewers firing on the same tick drain 12.8 seconds of buffer where
  the same 128 in cohorts of 8 drain none and cost half the network contacts. ⛔ **You cannot jitter
  your way out of it**: what matters is how many want the same chunk, not how many arrive in the same
  instant, and 60ms of jitter was measured to do nothing. The cache and pooling are the fix.
- **Turn the cache on, and size it at or above the working set or do not bother.** It halves network
  retrievals and cuts CPU 2.3 to 3.4x, and with a scattered audience it reaches one network fetch per
  distinct chunk for 128 viewers. But the benefit is a **step, not a slope**: at 76% of the working set
  it is byte-identical to no cache, at 100.1% it buys everything, and above that it buys nothing more.
  It is off by default in everything this repo has ever run, and the units are **chunks, not bytes**.
- **Do not ship an unfunded viewer gateway.** Not because it always breaks, but because the variation
  an operator cannot control is wider than the margin a viewer needs.
- **A 1.0s GOP is the one reliable mitigation** for every retrieval problem in this document.
