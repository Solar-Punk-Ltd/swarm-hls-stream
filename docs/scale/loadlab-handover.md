# Handover to the loadlab repo: what to test, what is already known, and where every number lives

**Written 2026-08-10.** This repository measures **one gateway at current scale**. The loadlab repo runs
the load tests this one cannot. This file is the bridge: what is settled, what is open, what to run
first, and the file to open for each claim so nothing is re-derived from memory.

⛔ **Read [`running-a-high-scale-event-on-swarm.md`](./running-a-high-scale-event-on-swarm.md) section
2z before designing anything.** It is the load model, and its boundaries are the point.

---

## 1. The three-line summary

1. **A pooled event is small. An unpooled one is 100x larger on identical content.** Network demand
   scales with gateway-stream pairs, not with viewers, because a gateway fetches each distinct chunk
   once and serves everyone behind it from that fetch.
2. **A gateway's capacity is a bitrate, ~350 Mbps, and it is internal to bee.** CPU, host load and NIC
   all had headroom when it was hit. It cannot be bought past. More gateways is the only lever.
3. **We have never run more than one stream, more than one gateway, or more than eight real viewers.**
   Everything at fleet scale in either repo is arithmetic until loadlab measures it.

---

## 2. Settled, with the file that settles it

| claim                       | number                                                   | where                                                          |
| --------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| Gateway throughput ceiling  | **344-352 Mbps**, cache-off and cache-warm alike         | `docs/bench/the-ceiling-is-bytes-not-viewers-2026-08-08.md`    |
| Viewers per gateway, 720p   | **~123**, bracketed 128 held / 192 drained               | same                                                           |
| Viewers per gateway, 1080p  | **~55** ⚠️ derived, not measured                         | `running-a-high-scale-event-on-swarm.md` §2.4e                 |
| Retrieval cost              | **0.000678 BZZ/MB**, flat over an 8.5x size range        | §2 cost table                                                  |
| GOP premium                 | **does not exist**, 1.4% not 15%                         | same                                                           |
| Viewers pool for free       | 16 cost what 1 costs                                     | §2.4b                                                          |
| Feed reads under load       | flat to 128 concurrent readers **through gateways**      | §2.6                                                           |
| Not-found cost              | ~480ms, **zero BZZ**, ~45% of live-edge reads            | §2.7                                                           |
| Funding is a switch at zero | 0.05 BZZ performs like 6.4 BZZ                           | §2.1b                                                          |
| Unfunded network cost       | **+13%**, not 34x ⛔ see §2z.3                           | §2.1                                                           |
| Unfunded viewer cost        | **11.6-15.0% of segments late** vs 0.0-0.3%              | §2.1                                                           |
| Synchronised audience       | 128 on one tick drain **12.8s of buffer**                | `a-synchronised-audience-is-the-failure-2026-08-08.md`         |
| Cold gateway                | **2-3x cost for ~2 min**, no readiness signal catches it | `a-cold-gateway-is-idle-long-before-it-is-cheap-2026-08-09.md` |
| Browser node throughput     | **~0.6x of realtime**, 100% crossing rate                | `docs/scale/in-browser-phase-1.md` §5c                         |
| Browser node is demand-only | never accepts inbound retrieval                          | same §6                                                        |
| Browser fragment ceiling    | ≤500 kB **20/20**, 3.5 MB **0/5**                        | `in-browser-fragment-profile-*-2026-08-10.tsv`                 |

---

## 3. ⛔ The five traps that cost this project the most

Every one of these produced a published figure that was wrong. They are listed because loadlab will meet
the same shapes at larger scale, where they cost more.

1. **A counter incremented before the send is not a send.** `bee_retrieval_request_attempts` counts
   peers that accounting then skips. This turned "38x network amplification" into the real answer,
   **+13%**. Subtract `accounting_blocks_count` before believing any request rate.
2. **A correct measurement of the wrong quantity.** The most expensive errors here were never bad
   instruments. A median transfer time improved 20x while the thing users feel, the rate of crossing a
   deadline, did not move at all. **Pick the statistic before the run, and prefer rate-of-crossing to
   medians.**
3. **A matched control is not a replicate.** One pair of arms giving 0/3 against 3/3 felt conclusive and
   was wrong. Replicate the arm, not just the comparison.
4. **n=1 does not get a mechanism.** A mechanism found by reading source _after_ an anomaly is fitted to
   it and cannot fail to fit. Three explanations for one session were refuted in turn. **Replicate
   first, explain second.**
5. **A bound the harness imposes is not a measurement.** A result sitting at your own timeout is
   "did not complete", never a duration. Report the bound beside the result every time.

---

## 4. What to run, in order

### First, and it blocks any go decision: concurrent publishers

**Nothing in either repo has run more than one stream.** Fifteen simultaneous stages through an uploader
that has only ever seen one is the single largest unknown.

- Arms: **1, 2, 5, 10, 15** concurrent broadcasts.
- Measure: per-stream publish latency, uploader queue depth, `segments_never_named_total`,
  `manifest_publish_failures_total`, and whether anything serialises.
- Watch for: a postage batch filling, which went 9.4% to full in a day and then evicts **silently**.
- Prediction to falsify: per-stream behaviour is independent up to some stage count. **We have no
  evidence for that and it is the assumption every capacity number rests on.**

### Second: does a fleet behave like one node times N

Every fleet-scale number in both repos is a single-gateway measurement divided.

- Arms: **1, 3, 8 gateways**, same content, viewers split evenly.
- Measure: whether per-gateway throughput holds at ~350 Mbps as gateway count rises, and whether the
  feed neighbourhood shows any effect.
- Prediction to falsify: gateways are independent.

### Third: the unpooled feed neighbourhood

§2z.4 identifies the **only structural hot spot**: a feed is one address in one neighbourhood, and our
"flat to 128 readers" result was taken **through gateways**, so it says nothing about independent nodes.

- Arms: **1, 8, 32, 128 independent light nodes** polling **one** feed address.
- Measure: poll latency distribution and not-found share, per node.
- This is the experiment that decides whether unpooled viewers are merely expensive or actually harmful.

### Fourth: the two silent killers

Both are ranked first and second on this project's own risk list, both are marked known-to-occur, and
**neither has ever been run**.

- **Chequebook exhausted mid-stream.** It emptied at run 7 of 12 once, and 64 of 247 peers went past
  their debt threshold. The uploader has **no behaviour** for it.
- **Postage batch full or expired mid-stream.** Mutable batches evict silently.
- ⛔ Both need a funded node, so price them in bytes first: **0.000678 BZZ/MB**.

### Fifth, only once the above pass: real viewers above eight

Probe viewers model retrieval load well and playback not at all. They have no decoder and no buffer, so
they cannot stall. At some point people have to watch in browsers and stalls have to be counted.

---

## 5. The load model, ready to implement

From §2z, at 720p / 2500 kbps / 0.25s. **Drive the simulation in requests, not bytes.**

```
chunks_per_segment      = 94 kB / 3.6 kB          ~= 26
segments_per_second     = 1 / 0.267               ~= 3.75
chunk_reads_per_stream  = 26 * 3.75               ~= 98  per second, per gateway
peer_requests           = chunk_reads * 1.142     ~= 112 per second, per gateway   (funded)
                        = chunk_reads * 1.281     ~= 126 per second, per gateway   (unfunded)

gateways_per_stage      = ceil(viewers_per_stage / 123)      # 720p; use 54 for 1080p
network_peer_requests   = stages * gateways_per_stage * 112
```

⚠️ **Feed traffic is invisible to any byte-based model.** A not-found moves no bytes, costs ~480ms, and
is ~45% of live-edge reads. Model feed polls as a separate request stream or you will under-count.

⚠️ **Service time is a distribution with a fat tail, never a mean.** Feed it percentiles. A p50 of 246ms
and a p90 of 2,771ms describe completely different viewers, and the p90 is the one that decides whether
a stream survives.

⛔ **Do not model browser nodes as network participants.** They accept inbound connections for pricing
and gossip only, never retrieval. They add demand and contribute **no serving and no caching**.

---

## 6. Where the raw data is

- **`docs/bench/*.md`** one report per sitting, each with its own cost in BZZ and its own controls.
- **`docs/bench/*.tsv`** raw per-request rows, including discarded arms and the reason they were
  discarded.
- **`docs/bench/*.requests.json`** a corpus of already-paid-for requests. ⭐ Several questions were
  answered from these for **zero broadcast minutes**, including the entire fragment-size result. Check
  here before booking any run.
- **`deploy/scripts/`** the harnesses. `in-browser-fragment-profile.js` carries the canary pattern worth
  copying: every round opens with a known-good probe, and a round whose canary fails is discarded whole.
- **`docs/scale/in-browser-phase-1.md`** everything about browser nodes, with simulator inputs in §7b.
- **`docs/reviews/roadmap.md`** the ranked risk list, including the two unrun scenarios above.

---

## 7. Open questions this repo cannot close

| question                                              | why it is stuck here                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Does the swarm have headroom for an event?            | Needs network-wide instrumentation. Not answerable from a single gateway.           |
| Do concurrent publishers interfere?                   | Never run. **Loadlab's first job.**                                                 |
| Does a gateway fleet behave like N independent nodes? | One gateway throughout.                                                             |
| Is an unpooled feed neighbourhood a hot spot?         | Our flat-to-128 result went through gateways.                                       |
| Does weeb-3 really send 6 requests per chunk?         | Read from source, never verified. bee taught us why that matters.                   |
| Does funding fix a browser node's tail?               | Test deferred by the owner. Stays a prediction.                                     |
| What causes the ~14-minute collapse?                  | Seen in 1 run of 15, cause never found, mitigated not fixed.                        |
| Is ABR worth building?                                | No ladder exists, neither engine transcodes. A product decision, not a measurement. |
