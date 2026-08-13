# What a viewer gets through an UNFUNDED gateway

**2026-08-13. Eight arms, six counted, one broadcast, two warm gateways alternating under it.**
Cost 0.9993 BZZ. Task #93.

## The answer

**A viewer through an unfunded gateway gets every segment, at the same bitrate, sitting the same
distance behind live. Each segment simply takes about twice as long to arrive, and the buffer
absorbs all of it.**

| | funded | unfunded |
| --- | ---: | ---: |
| median segment transfer, counted arms | **82ms** | **163ms** |
| seconds behind live, arms that did not stall | 6.03 | 6.03 |
| segments refused (404) | 0 | 0 |
| segments never served | 0 | 0 |
| segment bytes delivered | 340-345 kB/s | 340-341 kB/s |
| buffer stalls, 3 counted arms each | 1 | 1 |

## ⭐⭐⭐ The separation is total

Every funded arm was faster than every unfunded arm, across all eight including the warm-ups. There
is no overlap to argue about and no arm to reweigh.

| arm | condition | median transfer | behind live | stalls |
| ---: | --- | ---: | ---: | ---: |
| 1 | funded | 99ms | 6.03 | 0 |
| 2 | unfunded | 143ms | 6.02 | 0 |
| 3 | funded | 87ms | 6.03 | 0 |
| 4 | unfunded | 183ms | 6.03 | 0 |
| 5 | unfunded | 151ms | 6.29 | **1** |
| 6 | funded | 88ms | 6.03 | 0 |
| 7 | unfunded | 154ms | 6.03 | 0 |
| 8 | funded | 72ms | 6.26 | **1** |

Arms 1 and 2 are the warm-up round and are discarded by the harness, on the record that the first
arms of a sitting run differently. They are shown because they agree.

⭐ **A time trend cannot produce this.** The arms interleave, funded at positions 1/3/6/8 and
unfunded at 2/4/5/7, so any drift over the hour lands on both. Funded drifts gently downward
(99, 87, 88, 72) and unfunded does not trend at all (143, 183, 151, 154), and the two bands never
touch.

## The mechanism, read off the nodes themselves

Both gateways were bracketed before and after every arm and over the whole sitting.

| whole sitting, read path | funded (10077) | unfunded (10087) |
| --- | ---: | ---: |
| retrieval requests | 140,678 | 138,868 |
| mean retrieval time | **27.4 ms** | **65.6 ms** |
| **peers asked per request** | **1.59** | **30.05** |
| failed outright | 6,966 (5.0%) | 6,381 (4.6%) |
| invalid chunks retrieved | 0 | 0 |

⭐⭐⭐ **An unfunded node asks nineteen times as many peers to get the same chunk.** It cannot pay, so
it is refused and keeps asking until it finds a peer that will serve it on the free allowance. It
finds one: its outright failure rate is **4.6%, slightly lower than the funded node's 5.0%**. It just
takes 2.4x as long to get there.

The viewer sees a muted 1.98x rather than the node's 2.4x, because a segment is many chunks and the
player fetches with some parallelism.

## What it costs, and what it does not

⭐ **The 6s buffer is what makes this a non-event.** `LIVE_SYNC_DURATION_S = 6`, and both conditions
sat at 6.03s behind live in every arm that did not stall. An extra 80ms per segment against a six
second cushion is invisible, and every arm delivered `1.000` media seconds per wall second.

⛔⛔ **This is not a claim that funding never matters.** It is a claim about a **warm, well-peered**
unfunded node: 133 peers, up three hours, on the same host and the same link as the funded one. A
node that is unfunded **and** cold, or unfunded **and** thinly peered, is a different question and
this says nothing about it. [[swarm-hls-funding-cliff]] measured a funded node that ran **dry** going
0.1% to 10.6% late, which is a third condition again.

## ⛔⛔⛔ "0 rebuffers, 0 stalled samples" DOES NOT MEAN ZERO STALLS

Two arms stalled, one in each condition, and **every summary counter in their reports reads zero**:
rebuffers 0, stalled samples 0, fatal errors 0. The stall is visible only because the report checks
hls.js's latency target and finds it steered to 7.00s against a configured 6.00s.

A buffer stall need not fire a `waiting` event and is not fatal, so it passes every counter. What it
does do is permanent within the session: hls.js adds to `liveSyncDuration` on a stall and never
lowers it. See [[hls-stall-latency-penalty]].

⭐ The comparable figure the reports print for a stalled arm is latency **against the player's own
target**, per sample: **-0.74s** for the funded arm 8, **-0.71s** for the unfunded arm 5. Those two
agree with each other as closely as the clean arms do.

The stalls fell one on each condition, so this sitting has **no evidence that funding changes the
stall rate**, and n=3 per condition is far too small to look for one.

## What was controlled

- **One broadcast for all eight arms**, 3880s of 1280x720 at 2500 kbps and a 0.5s GOP, so both
  conditions read the same content from the same encoder over the same window. Two broadcasts is
  how the fragment-size cliff was found and withdrawn.
- **A fresh browser per arm**, because the latency-target ratchet above would otherwise carry an
  unfunded arm's stall into the funded arm after it, biasing toward the null.
- **Counterbalanced `AB/AB/BA/BA`**, which balances position with a single seam.
- **The arms differ in funding and nothing else**: both gateways carry matched flags, the same local
  RPC, the same CORS origins, the same cache settings. The unfunded one is
  `--full-node=false --swap-enable=false` and answers 405 on `/chequebook/balance`.
- **Both nodes warm before the sitting**, 134 and 133 peers, neither restarted during it.

## ⚠️ What was not controlled

- **n=3 per condition** counted, n=4 including warm-ups.
- **Co-tenancy.** The box carries some forty other bee nodes. Host load ran 5.63 to 11.77 across the
  arms. A bracket controls for drift over time and never for the neighbours, who are in every arm.
- **One profile only**: 720p, 2500 kbps, 0.5s GOP, one viewer at a time.
- ⛔ The per-arm **"What the gateway node was doing"** section of an unfunded arm's report describes
  the **funded** node. The health sampler is deliberately never pointed at the unfunded one, because
  it reads a missing chequebook as an unknown budget and would write a stop file mid-sitting. The
  per-arm node metrics under `node-metrics/*-on-unfunded-*.json` are the unfunded node's real
  readings, and they are bracketed either side of every arm.

## Provenance

- Harness `deploy/scripts/gateway-funding-arms.sh`, run
  `/home/solarpunk/gateway-funding-arms/sitting-2026-08-13`.
- Every arm passed the request-log gate: `armWasServedByItsGateway` counts an arm's fetches by host
  and refuses on a single foreign one. **All eight logged "fetched only from" their own gateway.**
  On 2026-08-13 an earlier smoke had both arms fetching all 253 video segments from one node while
  the client honestly reported two, so this gate is the reason the numbers above mean anything.
- That defect was the publisher's `MANIFEST_ACCESS_URL`, removed in PR #182 and unset on the
  deployment before this sitting. Segment lines are now bare Swarm references and each viewer's
  client prefixes its own gateway.
- Uploader spent 0.7321 BZZ (0.79/broadcast hour), gateway 0.2672 BZZ (0.29/broadcast hour).
- Batch `7849851f` 257 to 264 of 512 buckets. `segmentsSkipped` 0, `segmentsNeverNamed` 0,
  `maxConsecutiveSegmentFailures` 0 throughout.

⚠️ The publisher wrapper prints **"publish FAILED (exit 127). Nothing usable was broadcast, so do not
measure against this"** at the end of a **successful** sitting. It is the wrapper misreading its own
teardown of a container that had already gone: the arms took 3285s of a 3880s broadcast and the
remaining 595s were killed on purpose. 363,952 chunks were push-synced and all eight arms watched
their full 360s. The message is a false alarm and needs fixing, because an alarm that cries wolf at
the end of every good run is one an operator learns to skip.
