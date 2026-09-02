# Under a cap the in-tab node doubles its own traffic and still leaves the link half idle

**2026-09-02, measured on manager-host, 0 BZZ.** One run of `pnpm browser:in-tab-throttle-probe`
against the shipped client at build `dd21a1e`, Chrome 151, the recording of sitting five. Plan:
[`in-tab-throttle-probe-prediction-2026-09-02.md`](in-tab-throttle-probe-prediction-2026-09-02.md),
written before the driver existed. Artifact:
`in-tab-throttle-probe-2026-09-02T07-30-38-148Z.{md,json}` beside this file, with the sampled frame
log in `.requests.json` on the host under `~/swarm-hls-bench/docs/bench/`.

19 retrievals, 19 distinct references, every canary landed, nothing hit its budget, and the cost
bracket read every node's chequebook and batch unchanged.

## The headline, in three numbers

| | uncapped | capped at 2800 kbps |
| --- | ---: | ---: |
| bytes the node pulled per byte of segment, while the retrieval ran | **1.09 to 1.13** | **1.92 to 2.00** (360p), **2.33 to 2.87** (1080p) |
| more bytes arriving in the 10 s after the segment was complete | 6% to 33% of the segment | **another 0.65 to 1.16 segments' worth** |
| how full the capped link was while the retrieval ran | | **31% to 51%** |

Uncapped, a 360p segment took 0.1 s and a 1080p segment 0.4 s, about 2.9 MB/s. Capped at 350 KB/s,
the same node delivered **54 to 71 KB/s of segment**, one fifth of what the link allowed, and a
1080p segment took 16.5, 18.1 and 19.6 s against a 3.3 s link minimum, each within four seconds of
the 20 s at which hls.js abandons a fragment.

## Part A, idle: the background is not the cause

| window | mean inbound | connections |
| --- | ---: | ---: |
| unthrottled, opened at the first peer | 48,534 B/s | 13 → 200 |
| capped at 2800 kbps | 2,064 B/s | 200 → 200 |
| capped at 700 kbps | 2,024 B/s | 200 → 200 |

⚠️ The first window is the **join**, not the background. Its per-second series reads 121, 597, 784,
546, 519 and 147 KB/s in its first six seconds while the connection count climbed from 13 to 200,
then single-digit KB/s bursts. The driver opened the window the moment `ready(1)` returned, which is
the first peer, and that is a design fault recorded below. Once settled the node takes about
**2 KB/s**, under 1% of the 2800 kbps cap and 2.3% of the 700 kbps one.

**H2 is refuted.** The pre-registered threshold for it to be the cause was 105,000 B/s. Observed
2,064.

**H0 holds.** Idle inbound under the 700 kbps cap stayed at 2,024 B/s against the 87,500 that cap
allows, and no capped row ever exceeded its cap: the highest occupancy in the run was 51%. The cap
reaches the WebSocket transport, and the uncapped rows running at 2.9 MB/s beside capped rows that
never passed 350 KB/s is the stronger half of that proof.

## Part B, one fragment at a time

| round | arm | cap | outcome | inbound during | out frames | inbound in the 10 s after | ×payload | of the cap |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | canary | uncapped | 0.1 s, 224,848 bytes | 250,192 | 251 | 48,290 | 1.11 | — |
| 0 | 360p | 2800 kbps | 3.4 s, 222,968 bytes | 427,272 | 612 | 203,085 | 1.92 | 36% |
| 0 | 1080p | 2800 kbps | 16.5 s, 1,163,720 bytes | 2,705,805 | 4,879 | 1,350,367 | 2.33 | 47% |
| 0 | 360p | uncapped | 0.1 s, 224,096 bytes | 250,176 | 271 | 40,644 | 1.12 | — |
| 0 | 1080p | uncapped | 0.4 s, 1,148,492 bytes | 1,255,054 | 1,521 | 348,446 | 1.09 | — |
| 1 | canary | uncapped | 0.1 s, 223,720 bytes | 249,588 | 280 | 14,627 | 1.12 | — |
| 1 | 1080p | uncapped | 0.4 s, 1,209,780 bytes | 1,322,126 | 1,589 | 12,785 | 1.09 | — |
| 1 | 360p | uncapped | 0.1 s, 215,260 bytes | 242,237 | 305 | 13,398 | 1.13 | — |
| 1 | 1080p | 2800 kbps | 18.1 s, 1,154,508 bytes | 3,088,715 | 5,100 | 1,051,198 | 2.68 | 49% |
| 1 | 360p | 2800 kbps | 4.2 s, 225,224 bytes | 449,785 | 866 | 252,957 | 2.00 | 31% |
| 2 | canary | uncapped | 0.3 s, 225,224 bytes | 250,633 | 311 | 23,119 | 1.11 | — |
| 2 | 360p | 2800 kbps | 4.0 s, 233,308 bytes | 463,747 | 812 | 209,639 | 1.99 | 33% |
| 2 | 1080p | 2800 kbps | 19.6 s, 1,210,908 bytes | 3,476,433 | 5,264 | 786,844 | 2.87 | 51% |
| 2 | 360p | uncapped | 0.1 s, 229,360 bytes | 255,395 | 276 | 18,246 | 1.11 | — |
| 2 | 1080p | uncapped | 0.4 s, 1,185,152 bytes | 1,292,446 | 1,463 | 377,432 | 1.09 | — |

Arms alternated order each round. The rows replicate: three capped 360p rows within 0.8 s of each
other, three capped 1080p rows within 3.1 s, and every uncapped row of a size within 0.1 s of its
siblings. The capped 1080p rows also drift upward round on round, 16.5 → 18.1 → 19.6 s, which is
one run's hint and not a trend.

### What the columns say

- **Outbound request frames** under the cap are 2.5 to 3.4x the uncapped count for the same size
  (612 to 866 against 251 to 311 for 360p, 4,879 to 5,264 against 1,463 to 1,589 for 1080p). The
  node asked for far more than it needed.
- **Inbound during** is 1.9 to 2.9x the segment under the cap against 1.1x uncapped. The 1.1x is the
  protocol's own framing, and everything above it is chunks delivered more than once.
- **The tail** carries nearly a whole extra segment after the segment was already complete, under the
  cap, and a few percent uncapped. Those are the hedged attempts still answering. In a live viewer
  they land on the link while the next fragment is being asked for.
- **Occupancy** never passed 51%. The link was half empty while the node took five to six times the
  link time to finish.

## Part C, two at once

| round | arm | outcome | inbound during | out frames | inbound in the 10 s after | ×payload | of the cap |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | pair | 9.1 s, 210,560 bytes | 1,145,011 | 2,787 | 1,283,979 | 5.44 | 36% |
| 0 | pair | 6.4 s, 230,676 bytes | 714,048 | 2,274 | 1,712,002 | 3.10 | 32% |
| 1 | pair | 6.4 s, 214,884 bytes | 685,548 | 2,247 | 1,710,544 | 3.19 | 31% |
| 1 | pair | 8.8 s, 230,112 bytes | 1,086,169 | 2,724 | 1,311,973 | 4.72 | 35% |

Read together, since two rows on one link each count the other's bytes: pair 0 pulled 1,145,011
bytes over 9.1 s against 441,236 bytes of segments, **×2.60**, link at 36%. Pair 1: 1,086,169 over
8.8 s against 444,996, **×2.44**, link at 35%.

⭐⭐ **Two at once is worse than one after the other.** Alone, a capped 360p took 3.4 to 4.2 s, so
two in sequence would take about 7.6 s. Started together the slower of the two took 8.8 and 9.1 s,
and the pair left **1.3 to 1.7 MB** arriving in the ten seconds after it finished, three to four
times the two segments' combined size. Sitting five's viewer had three 360p retrievals overlapping
plus a 1080p in flight when the cap landed. On a 350 KB/s link, several megabytes of late duplicates
are ten or more seconds of the link carrying nothing a viewer will see, ahead of every new request.

## The pre-registration, against what was observed

| | predicted | observed | |
| --- | --- | --- | --- |
| **H1** hedge amplification | capped 360p at 3.0 or more, uncapped 1.0 to 1.3 | capped **1.92 / 1.99 / 2.00** during plus **0.9 to 1.1 more** in the tail, uncapped 1.11 / 1.12 / 1.13 | **confirmed in kind, below the in-window figure predicted** |
| **H2** idle background load | 105,000 B/s or more if it is the cause | 2,064 B/s settled | **refuted** |
| **H3** accounting exhaustion (amended 5e0558e) | link mostly idle, rejections when it answers. Under H1 the link is full | link **31% to 51%**, **0 of 10** capped rows rejected | **neither prediction as written** |
| **H0** the instrument | idle under 700 kbps at or under 87,500 B/s | 2,024 B/s, no row above 51% of its cap | **holds** |

⛔ **The strict H1 prediction failed and I am recording that rather than moving the goalposts.** I
wrote "at least 3.0" for the bytes arriving while a capped 360p retrieval ran, and the run read
1.92 to 2.00. Counting the tail the node pulls about three segments' worth per segment, but the tail
was not what the prediction named.

## What the run says, and what it only suggests

**Measured.** Under a bandwidth cap the in-tab node asks for two to three times the chunks it needs,
receives two to three segments' worth of bytes while a segment loads and about one more afterwards,
completes at a fifth of the link's capacity, and leaves the link half idle while doing so. Two
concurrent retrievals compound it. None of this happens uncapped, where the same node runs at
2.9 MB/s with 9% to 13% framing overhead.

**Inferred, and labelled so.** The duplicates are the one-second hedge in `retrieve_chunk`: every
chunk unanswered for a second is asked of the next peer, up to twenty, and nothing calls the losers
off (`RETRIEVE_HEDGE_AFTER_MS`, `RETRIEVE_ATTEMPT_TIMEOUT_MS`, read in
[`in-tab-throttle-probe-prediction-2026-09-02.md`](in-tab-throttle-probe-prediction-2026-09-02.md)).
The half-idle link is not explained by duplicates alone: with twice the bytes on a full link a
capped 360p would take 1.3 s, and it took 3.4 to 4.2 s. The reading most consistent with a half-idle
link, request frames continuing every second and no rejections is the amended H3 acting as a
consequence of H1: each hedge reserves the chunk's price at a peer before asking, hedges under a
cap pile reservations on the closest peers until they refuse, and the node then cycles its overdraft
list waiting for allowance that refreshes once a second per peer. The node exposes no counter that
would show that directly, so it stays an inference. A hedge that stopped fanning out on a
bandwidth-limited link would test both at once, and the test is this probe run again.

## Design faults of this run, for the next one

1. **The unthrottled idle window opened at the first peer.** It measured the join. The driver should
   wait for the connection count to stop growing before Part A, or read the settled minutes only.
2. **Sitting five's shape is not in the run.** Its cap landed while a 1080p fragment was in flight
   and the 360p requests came after. A Part D that starts a 1080p uncapped, applies the cap
   mid-flight, then asks for a 360p, replicates that order exactly. Still free.
3. **The kept frame log is a one-in-five sample.** `MAX_LOGGED_FRAMES` is 20,000 and the run made
   about 95,000. Every figure in the tables was computed over the full stream before thinning, so
   nothing above is affected, but a per-second reading taken from the `.requests.json` afterwards is
   indicative only.

## What this cannot say

- **Which peers, or how many attempts.** yamux frames are not one to one with attempts. Bytes per
  segment byte does not need them.
- **Whether a fix works.** That needs the fix, and then this probe, which costs nothing.
- **The live edge.** VOD references through the identical retrieval path. Part C approximates a live
  viewer's overlap and does not reproduce hls.js's abandon-and-retry loop on top of it.
- **n=1 run.** Three rows per arm inside it replicate tightly, but one afternoon on one host.

## What it means for V2

V2 is red because a capped in-tab node cannot supply the cheapest rung, and this is why: the node's
own retrieval policy turns a 350 KB/s link into 54 to 71 KB/s of usable segment and then buries the
next request under the duplicates of the last one. The fix lives in that retrieval path, per the
owner's ruling of 2026-09-02, and any change to weeb-3 is drafted here and handed over, never filed
by me.
