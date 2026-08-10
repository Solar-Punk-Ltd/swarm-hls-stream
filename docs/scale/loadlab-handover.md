# Handover to the loadlab repo: what to test, what is already known, and where every number lives

**Written 2026-08-10, rewritten the same day once the Devcon architecture was settled.** This repository
measures **one gateway at current scale**. The loadlab repo runs the load tests this one cannot. This
file is the bridge: what is settled, what is open, what to run first, and the file to open for each
claim so nothing is re-derived from memory.

⛔ **Read [`running-a-high-scale-event-on-swarm.md`](./running-a-high-scale-event-on-swarm.md) section
2z before designing anything.** It is the load model, and its boundaries are the point.

---

## 1. The target the tests are for

**Devcon: 10 stages, 4-rung ABR ladder (1080p/720p/480p/360p), 20,000 concurrent viewers, 8 hours.**
The architecture is settled and it decides which tests matter:

```
Swarm                                     the content genuinely lives here
  ↓   104 Mbps pulled ONCE                2-3 bee gateways, redundant
HTTP cache / CDN                          segments are immutable, they cache perfectly
  ↓   50 Gbps delivered                   180 TB over the event
20,000 viewers                            ordinary streaming infrastructure
```

⭐⭐⭐ **The load Swarm sees is set by `stages x renditions` and by nothing else.** Viewer count does not
appear anywhere in it. 20,000 viewers or 200,000, Swarm is asked for the same **104 Mbps / 4,124 requests
per second**. That single property is why the event is feasible, and it is the property every test below
is really checking.

|                                        |                                     |
| -------------------------------------- | ----------------------------------: |
| Swarm-facing, whole event              |          **104 Mbps**, ~4,124 req/s |
| retrieval cost, 8h, one puller         |                         **254 BZZ** |
| published to Swarm                     |                          **374 GB** |
| concurrent uploads                     |        **40** (10 stages x 4 rungs) |
| delivery layer, scales with audience   | 50 Gbps, 180 TB, conventional money |
| if bee served viewers directly instead |        **143 gateways, ~3,630 BZZ** |

---

## 2. The three-line summary

1. **Whoever does the fan-out decides everything.** In bee it costs 143 machines and 14x the BZZ. In an
   HTTP cache it costs 2 to 3 machines and the Swarm side stops caring about audience size.
2. **A gateway's capacity is a bitrate, ~350 Mbps, and it is internal to bee.** CPU, host load and NIC
   all had headroom when it was hit. It cannot be bought past.
3. **We have never run more than one stream, more than one gateway, or more than eight real viewers.**
   Everything at fleet scale in either repo is arithmetic until loadlab measures it.

---

## 3. Settled, with the file that settles it

| claim                       | number                                                      | where                                                          |
| --------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| Gateway throughput ceiling  | **344-352 Mbps**, cache-off and cache-warm alike            | `docs/bench/the-ceiling-is-bytes-not-viewers-2026-08-08.md`    |
| Viewers per gateway, 720p   | **~123**, bracketed 128 held / 192 drained                  | same                                                           |
| Viewers per gateway, 1080p  | **~55** ⚠️ derived                                          | `running-a-high-scale-event-on-swarm.md` §2.4e                 |
| Chunks per segment          | **26.2** for a 94 kB segment, includes merkle-tree overhead | §2.5 cache sizing                                              |
| Retrieval cost              | **0.000678 BZZ/MB**, flat over an 8.5x size range           | §2 cost table                                                  |
| GOP premium                 | **does not exist**, 1.4% not 15%                            | same                                                           |
| Viewers pool for free       | 16 cost what 1 costs                                        | §2.4b                                                          |
| Feed reads under load       | flat to 128 concurrent readers **through gateways**         | §2.6                                                           |
| Not-found cost              | ~480ms, **zero BZZ**, ~45% of live-edge reads               | §2.7                                                           |
| Funding is a switch at zero | 0.05 BZZ performs like 6.4 BZZ                              | §2.1b                                                          |
| Unfunded network cost       | **+13%**, not 34x ⛔ see §2z.3                              | §2.1                                                           |
| Unfunded viewer cost        | **11.6-15.0% of segments late** vs 0.0-0.3%                 | §2.1                                                           |
| Synchronised audience       | 128 on one tick drain **12.8s of buffer**                   | `a-synchronised-audience-is-the-failure-2026-08-08.md`         |
| Cold gateway                | **2-3x cost for ~2 min**, no readiness signal catches it    | `a-cold-gateway-is-idle-long-before-it-is-cheap-2026-08-09.md` |
| Browser node throughput     | **~0.6x of realtime**, 100% crossing rate                   | `docs/scale/in-browser-phase-1.md` §5c                         |
| Browser node is demand-only | never accepts inbound retrieval                             | same §6                                                        |
| Browser fragment ceiling    | ≤500 kB **20/20**, 3.5 MB **0/5**                           | `in-browser-fragment-profile-*-2026-08-10.tsv`                 |

---

## 4. ⛔ The five traps that cost this project the most

Every one of these produced a published figure that was wrong. Loadlab will meet the same shapes at
larger scale, where they cost more.

1. **A counter incremented before the send is not a send.** `bee_retrieval_request_attempts` counts
   peers that accounting then skips. This turned "38x network amplification" into the real answer,
   **+13%**. Subtract `accounting_blocks_count` before believing any request rate.
2. **A correct measurement of the wrong quantity.** A median transfer time improved 20x while the thing
   users feel, the rate of crossing a deadline, did not move at all. **Pick the statistic before the
   run, and prefer rate-of-crossing to medians.**
3. **A matched control is not a replicate.** One pair of arms giving 0/3 against 3/3 felt conclusive and
   was wrong. Replicate the arm, not just the comparison.
4. **n=1 does not get a mechanism.** A mechanism found by reading source _after_ an anomaly is fitted to
   it and cannot fail to fit. Three explanations for one session were refuted in turn. **Replicate
   first, explain second.**
5. **A bound the harness imposes is not a measurement.** A result sitting at your own timeout is
   "did not complete", never a duration. Report the bound beside the result every time.

---

## 5. What to run, in order

### ⭐ Start now, because it expires: the witness node

**A full node we own, in the network, doing nothing special**, recording inbound request rate, peer
count and accounting counters continuously.

- **Weeks of baseline before the event** is what makes it useful. There is no way to compress that.
- **During the event**, any movement is the only network-level signal available to us.
- Costs one small server.

⛔ **Nobody hands us Swarm-wide telemetry.** A node we control is the entire observability story, and its
value is the baseline. Every other item on this list can start later. This one cannot.

### First test, and it decides the architecture: one gateway, 40 distinct streams

**Can a single bee gateway pull 104 Mbps of 40 renditions with nothing shared between them?**

- Our 350 Mbps ceiling was measured with viewers **sharing** chunks in cohorts of eight. Forty distinct
  renditions is the opposite workload and we have no evidence for it.
- Arms: 4, 10, 20, 40 distinct streams. Measure sustained throughput, per-stream late share, and where
  it bends.
- **Prediction to falsify:** one gateway sustains 104 Mbps of fully distinct content.
- ⭐ Cheapest thing on the list and the only one that can invalidate everything above it.

### Second: concurrent publishers

**Nothing in either repo has run more than one stream.** The Devcon shape is **40 simultaneous uploads**
(10 stages x 4 rungs) through an uploader that has only ever handled one.

- Arms: **1, 2, 5, 10, 20, 40** concurrent broadcasts.
- Measure: per-stream publish latency, uploader queue depth, `segments_never_named_total`,
  `manifest_publish_failures_total`, and whether anything serialises.
- Watch for: a postage batch filling, which went 9.4% to full in a day and then evicts **silently**.
  374 GB across 40 parallel uploads needs batch sizing before the event.
- **Prediction to falsify:** per-stream behaviour is independent up to some stage count.

### ~~Third: verify weeb-3's six peers~~ ✅ ANSWERED 2026-08-10, and the second row won

`RETRIEVE_CHECK_CONFIRMATION_PEERS = 6` was **read from source and never verified**. It has now been
traced to its caller, and **it is not on the viewer's path at all**: `retrieve_check_chunk` reads it,
and its sole caller runs immediately after `push_chunk`, so six is what an **uploader** does to confirm
a push. A viewer runs `retrieve_chunk`, which asks **one** peer and breaks on the first valid reply,
hedging a second only after `RETRIEVE_HEDGE_AFTER_MS = 1000`.

|                           | one browser node | browser nodes = the whole Devcon event |
| ------------------------- | ---------------: | -------------------------------------: |
| ~~if 6 means six sends~~  |    ~~590 req/s~~ |                              ~~**7**~~ |
| ✅ **~1.1-1.3, like bee** |    **112 req/s** |                                 **37** |

⭐ **Plan against the second row.** The same trap caught us twice in one project, on bee's skip counter
and now on this constant: **a constant's name is not its behaviour, and the caller is where the
behaviour is.** Grepping the definition is what produces these errors; grepping the call sites is what
catches them, and it costs one command.

⚠️ The 112 req/s still rests on an unmeasured denominator, so read "Fourth" below before using it.

### Fourth: the missing denominator, what can a full node answer?

**We measured what a gateway can retrieve. We never measured what a node can answer.** Opposite
directions, and we only ever instrumented one.

- Point a rising number of requesters at one node we own, find where its response rate bends.
- ⛔ Until this number exists, "590 requests per second" has nothing to be large or small against, and
  every claim about how many nodes the network tolerates is invented.
- It also converts every browser-node figure into "and therefore N more full nodes", which is what
  planning actually needs.

### Fifth: the unpooled feed neighbourhood

A feed is **one address in one neighbourhood**, and our "flat to 128 readers" result was taken **through
gateways**, so it says nothing about independent nodes.

- Arms: **1, 8, 32, 128 independent light nodes** polling **one** feed address.
- The chosen architecture avoids this case entirely, which is a reason to prefer it, but the number is
  worth having if browser nodes are ever promoted.

### Sixth: the two silent killers

Both ranked first and second on this project's own risk list, both known to occur, **neither ever run**.

- **Chequebook exhausted mid-stream.** It emptied at run 7 of 12 once, 64 of 247 peers went past their
  debt threshold, and the uploader has **no behaviour** for it. A dry gateway answers `/health` in
  1.1 ms with 134 peers while its viewers go to 10.6% late.
- **Postage batch full or expired mid-stream.** Mutable batches evict silently.

### Seventh, once the above pass: real viewers above eight

Probe viewers model retrieval load well and playback not at all. No decoder, no buffer, so they cannot
stall. At some point people have to watch in browsers and stalls have to be counted.

---

## 6. The load model, ready to implement

**Drive the simulation in requests, not bytes.**

```
# Swarm side. Note that viewer count does not appear.
per_stage_kbps    = 6000 + 2500 + 1200 + 700        # the 4-rung ladder
total_mbps        = per_stage_kbps / 1000 * stages   # 104 at 10 stages
bytes_per_sec     = total_mbps * 1e6 / 8
chunk_reads       = bytes_per_sec / 3600             # ~3.6 kB per chunk, measured
peer_requests     = chunk_reads * 1.142              # measured, funded
                  = chunk_reads * 1.281              # measured, unfunded
bzz_per_hour      = bytes_per_sec * 60 / 1e6 * 0.000678 * 60

# Delivery side. This is the only place viewers appear.
egress_gbps       = viewers * avg_viewer_mbps / 1000
```

⚠️ **Feed traffic is invisible to any byte-based model.** A not-found moves no bytes, costs ~480ms, and
is ~45% of live-edge reads. Model feed polls as a separate request stream or you will under-count.

⚠️ **Service time is a distribution with a fat tail, never a mean.** Feed it percentiles. A p50 of 246ms
and a p90 of 2,771ms describe completely different viewers, and the p90 decides whether a stream lives.

⛔ **Do not model browser nodes as network participants.** They accept inbound for pricing and gossip
only, never retrieval. They add demand and contribute **no serving and no caching**.

⚠️ **A request is not one node's problem.** Swarm forwards retrieval toward a chunk's neighbourhood, so
each request becomes several messages along a path. **We have never measured the hop count**, so every
request figure here is a lower bound on messages.

---

## 7. Where the raw data is

- **`docs/bench/*.md`** one report per sitting, each with its own cost in BZZ and its own controls.
- **`docs/bench/*.tsv`** raw per-request rows, including discarded arms and why they were discarded.
- **`docs/bench/*.requests.json`** a corpus of already-paid-for requests. ⭐ Several questions were
  answered from these for **zero broadcast minutes**, including the entire fragment-size result. Check
  here before booking any run.
- **`deploy/scripts/`** the harnesses. `in-browser-fragment-profile.js` carries the canary pattern worth
  copying: every round opens with a known-good probe, and a round whose canary fails is discarded whole.
- **`docs/scale/in-browser-phase-1.md`** everything about browser nodes, simulator inputs in §7b.
- **`docs/reviews/roadmap.md`** the ranked risk list, including the two unrun scenarios above.

---

## 8. Open questions, and who can close them

| question                                                        | status                                        | who                                         |
| --------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| Can one gateway pull 40 distinct streams at 104 Mbps?           | **blocks the architecture**                   | loadlab, ~1 day                             |
| Do 40 concurrent publishers interfere?                          | never run                                     | loadlab, ~1 day                             |
| Does weeb-3 send 6 requests per chunk or consider 6 candidates? | source-read, unverified                       | either repo, an afternoon                   |
| What request rate can a full node answer?                       | never measured, **the missing denominator**   | loadlab                                     |
| How many hops does a retrieval traverse?                        | never measured                                | loadlab                                     |
| Is an unpooled feed neighbourhood a hot spot?                   | our result went through gateways              | loadlab                                     |
| Does the Swarm network have headroom for an event?              | **not answerable by measurement from inside** | witness node baseline is the closest we get |
| Does funding fix a browser node's tail?                         | ⏸ deferred by the owner                       | reopen only on their word                   |
| What causes the ~14-minute collapse?                            | 1 run in 15, cause never found                | unresolved, mitigated not fixed             |
| Is ABR worth building?                                          | no ladder exists, neither engine transcodes   | product decision, not a measurement         |
