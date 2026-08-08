# A viewer paces, and half the CPU model was measuring a queue

**2026-08-08, 11:49 to 12:18 UTC.** Three sittings on an unfunded gateway: a proving pass, sixteen arms
alternating paced against flat-out at 1, 16, 64 and 128 viewers, and five arms separating the cache from
the network at 128. **Cost: nothing.** The chequebook was byte-identical before and after all three.

Every arm this project had ever run fetched flat out. That is a load generator, not a viewer. A player
asks for one segment per segment duration because that is the rate the encoder makes them at, so a
flat-out walk measures a queue draining as fast as it can rather than a person watching television.

## ⭐ What pacing measures that a late-segment share cannot

The pacing is start-to-start. The next segment appears one duration after the last one did no matter how
long the fetch took, so a fetch that overruns eats its own slack and the deadline advances regardless.
`now - nextAt` at the start of a fetch is then the viewer's accumulated lag behind real time, and **that
is buffer depletion in milliseconds**.

⭐⭐ **A late-segment share cannot see it.** Ten late segments in a row and ten late segments spread over
a minute give the same share, and only the first empties a buffer. The two numbers that matter are the
**deepest lag**, which is how much buffer a viewer needs to never stall, and the **lag it ends on**,
which says whether it recovered or was still losing ground when the walk stopped.

## The proving pass, including a control designed to fail

⛔ An instrument that only ever reports zero passes every test and tells you nothing. So the proving
pass included an arm that had to fall behind:

| arm | pace | wall clock | expected | started behind | deepest lag |
| --- | ---: | ---: | --- | ---: | ---: |
| FLAT | 0ms | 3s | unpaced | | |
| SLOW | 1000ms | **29s** | 29 intervals + one fetch ✅ | **0.0%** | **0ms** |
| FAST | 10ms | ~2.5s | must fall behind | **96.7%** | **2222ms** |

✅ The arithmetic reconciles in both directions: `elapsed = (n-1) x pace + accumulated lag + last fetch`.
SLOW gives 29,000ms + 0 + 36ms against 29s measured. FAST gives 300ms + 2222ms = 2.52s against a
second-resolution 2s. **The instrument can both report zero and detect falling behind.**

## ⭐⭐ The correction: per-MB survives, per-viewer does not

Sixteen arms, paced and flat-out interleaved in pairs, concurrency walked non-monotonically (1, 64, 16,
128) so an ordering drift cannot masquerade as an effect. Two rounds.

CPU-cores is `cpuRetrievalS / elapsed`, both rounds averaged:

| viewers | **paced cores** | flat-out cores | flat-out overstates by |
| ---: | ---: | ---: | ---: |
| 1 | **0.70** | 1.75 | **2.5x** |
| 16 | **1.34** | 2.84 | **2.1x** |
| 64 | **3.62** | 5.97 | **1.65x** |
| 128 | 5.97 | 6.10 | 1.02x, both pinned at the ceiling |

⭐ **Fitted on paced arms: about 0.67 cores fixed plus about 0.046 cores per viewer.** It predicts 1.41
at 16 against 1.34 measured, and 3.61 at 64 against 3.62.

⭐⭐ **The flat-out model published earlier the same day was ~1.5 fixed plus ~0.07 per viewer, and this
sitting's own flat-out arms reproduce it exactly** (slope 0.067, intercept 1.68 fitted on F1 through
F64). That is the control that makes the correction credible: the flat arms land where the old model
says they should, so the gap is pacing and not a re-measurement.

**The marginal cost of a viewer was 1.5x too high and the fixed cost 2.2x too high.**

### But the per-MB figure was right all along

| viewers | paced CPU-s/MB | flat-out CPU-s/MB | |
| ---: | ---: | ---: | --- |
| 1 | 2.01 | 2.44 | paced 18% cheaper |
| 16 | 0.242 | 0.208 | paced 16% dearer |
| 64 | 0.163 | 0.199 | paced 18% cheaper |
| 128 | 0.186 | 0.196 | paced 5% cheaper |

⭐ **Within 20% and with no consistent sign, so the per-MB normalisation holds.** CPU tracks bytes, and
a paced viewer simply moves fewer bytes per second. **Every per-MB figure in the handover stands. Every
per-viewer and viewers-per-host figure derived from a flat-out arm is about 2x pessimistic.**

## ⭐⭐ 128 viewers do not fit, and the lag metric says so where the median does not

| viewers | median | over 267ms | **started behind** | **deepest lag** | **ended behind** |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 59 / 54ms | 0.0 / 4.0% | 0.0 / 17.0% | 0 / 1450ms | **0 / 613ms** |
| 16 | 52 / 57ms | 1.8 / 3.0% | 3.0 / 15.1% | 78 / 1487ms | **0 / 0ms** |
| 64 | 79 / 77ms | 0.4 / 7.0% | 0.9 / 33.4% | 80 / 1280ms | **0 / 0ms** |
| **128** | 212 / 252ms | 26.1 / 43.5% | **96.0 / 96.0%** | **8672 / 11125ms** | **8391 / 11125ms** |

⭐⭐ **The ending lag is bimodal where nothing else is.** At 16 and 64 viewers it is zero in both rounds:
the viewer wobbles up to a second and a half behind and then recovers. At 128 it is 8.4 and 11.1
seconds and still at its maximum, which is a viewer whose buffer has drained and which is not coming
back.

⛔ **The late-segment share cannot resolve this.** 26.1% at 128 overlaps with 11.7% at flat-out 64, and
the two 128 rounds disagree by 17 points. The ending lag agrees with itself to within the difference
between "fine" and "broken", in both rounds, at every concurrency.

⚠️ **One viewer on an unfunded gateway reached 1450ms of lag and ended 613ms behind in round 2, and 0
in round 1.** That is the unfunded variance the earlier sittings kept finding, now expressed as
something a player would feel: five segments of buffer, at a 0.25s profile, from a single viewer.

## ⭐⭐ Where the ceiling actually is

Every 128-viewer arm delivered **1201 MB in 36 to 41 seconds regardless of pacing**, which is ~32 MB/s.
The paced arm *demanded* 1201 MB in 26.7 seconds, or **45 MB/s**, and did not get it. Paced and flat-out
converge at 128 because both are pinned against the same wall.

At this profile one viewer needs **0.352 MB/s (2.81 Mbps)**, so the ~32 MB/s wall is **about 91
viewers**. 64 viewers is 22 MB/s, 69% of the wall, and that is precisely the concurrency that recovers
from its wobbles.

⭐ **That independently reproduces the "pool 32 to 64 viewers per gateway" rule** arrived at earlier the
same day from network contacts and segment budget, by an unrelated route.

### It is not host CPU, and it is not the local link

| | measured | available |
| --- | ---: | ---: |
| bee CPU at 128 viewers | ~6 cores | 48 |
| throughput at 128 viewers | 256 Mbps | 1000 Mbps NIC |

## ⭐⭐ A warm cache moves the wall, and collapses the buffer 26x

Five arms at 128 paced viewers, cache alternated, cold and warm distinguished within the sitting:

| arm | cache | wall | p90 | **deepest lag** | **ended behind** | CPU-s/MB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| COLD | on, cold | 32s | 432ms | 4313ms | 4313ms | 0.198 |
| **WARM** | **on, warm** | **28s** | **299ms** | **506ms** | **315ms** | **0.159** |
| PURGE | **off** | 36s | 574ms | 8533ms | **8328ms** | 0.199 |
| COLD2 | on, cold | 31s | 368ms | 3340ms | 2930ms | 0.182 |
| **WARM2** | **on, warm** | **28s** | **281ms** | **352ms** | **180ms** | **0.158** |

⭐⭐ **The buffer a viewer needs falls from 8.3 seconds to 0.3.** Warm, 128 paced viewers finish in 28s
against an ideal of 26.7, so they run about 5% behind real time and hold there rather than draining.

⭐ **So the ~32 MB/s wall is in the retrieval path, not in bee's request handling.** Served from local
chunks bee does 1201 MB in 28s, **43 MB/s**, and only just misses the 45 MB/s the viewers ask for.

The two distributions have different shapes, which is the check that the warm arms are really being
served locally: **cold is median 221 / p90 432-574**, a long tail characteristic of network retrieval;
**warm is median 205-208 / p90 281-299**, a narrow band characteristic of a saturated server.

⚠️ **The warm median is 205ms, not the 4-5ms the same cache gives at 16 viewers.** That is queueing, not
retrieval. bee is saturated on serving, and it is serving from memory.

### The capacity chain, for one gateway at 720p on a 0.25s profile

| bound | viewers | basis |
| --- | ---: | --- |
| retrieval path, cache off | **~91** | ✅ measured, bracketed by 64 keeping up and 128 not |
| serving path, cache warm | ~122 | ⚠️ derived from 43 MB/s measured warm |
| host NIC, 1 Gbps | ~355 | ⚠️ derived, never tested |
| host CPU, 48 cores, pooled | ~1000 | ⚠️ extrapolated far past measurement |

⭐⭐ **For a pooled deployment CPU is nowhere near binding. Throughput is.** The earlier warning that
CPU saturates first still holds for the one-node-per-viewer topology, where the ~0.67 core fixed cost is
paid per node instead of once.

## ⛔ What this does not show

⛔ **Every viewer in a paced arm fires on the same schedule.** For live HLS that is honest, because a
segment becomes available to everyone at the same instant. But it means these arms are served largely by
**pooling**, bee merging concurrent requests for the same chunk, and pooling is exactly what a scattered
audience does not get. A real audience is offset by join time, poll interval and buffer depth. **A
scattered audience should need the cache much more than this test shows, and nothing has measured it.**

⚠️ **The harness runs on the gateway's own host**, so 128 curl processes are host load the gateway does
not cause. bee's own CPU is read from `/proc` of its pid and is clean, but the ~32 MB/s ceiling has not
been separated from the harness's own capacity.

⚠️ **The warm arms cache the whole working set**, 100 references fetched twice inside a minute. A live
broadcast's working set is the entire window and nothing has measured eviction.

⚠️ Unfunded gateway, 0.25s profile, one host, 100 references, two rounds.

## Artifacts

`/home/solarpunk/retrieval-probe/{paceproving,pace1,pace2}/`. Probe:
`deploy/scripts/retrieval-debt-probe.sh`, pace is the 6th arm field. Gateway restored to
`--swap-enable=true` and `--cache-capacity=0` and confirmed on the node after every sitting.
