# What a viewer's node costs in CPU, and what a cache buys

**2026-08-08, 10:05 to 10:12 UTC.** Eight arms on `latbench`, funded and unfunded interleaved across
two rounds, each retrieving the same 400 references **twice** through the same gateway, with the
node's own CPU time and retrieval counters read per arm.

This exists because of what [the counter correction](why-an-unfunded-gateway-is-slow-2026-08-08.md)
implied and nobody had checked. If an unfunded node's 38 attempts per chunk are peer-selection
iterations that never leave the box, then **what bounds a fleet of them is host CPU**, not network
capacity. That is a number, and until now it was not measured.

## ⭐ An unfunded viewer node costs about one CPU core. A funded one costs a third of that.

| arm | late over 267ms | **CPU-seconds per MB** | first-peer service | skips per chunk |
| --- | ---: | ---: | ---: | ---: |
| funded, round 1 | 0.0% | **1.257** | **92.9%** | 0.015 |
| funded, round 2 | 0.2% | **1.310** | **91.0%** | 0.010 |
| unfunded, round 1 | 8.5% | **3.316** | **8.6%** | **35.1** |
| unfunded, round 2 | 1.5% | **3.745** | **9.6%** | **43.2** |

⭐ **An unfunded node burns 2.6 to 2.9 times the CPU of a funded one for byte-identical work.**

⭐ **A funded node is served by the first peer it considers 9 times in 10. An unfunded node, fewer
than 1 time in 10.** That single pair of numbers is the mechanism in its plainest form: the funded
node picks a peer and asks it, the unfunded node picks a peer, is told it cannot pay, and picks again.

**Converted to what a deployment plans with**, at 720p / 2500 kbps (0.3125 MB/s):

| | CPU-cores per viewer | viewers on a 48-core host |
| --- | ---: | ---: |
| funded, cache on | **0.17** | ~280 |
| funded, cache off | **0.39** | ~120 |
| **unfunded, cache off** | **1.04 to 1.17** | **~45** |

⚠️ **Derived, and the caveat is real.** The probe fetches back to back with no think time, where a
live viewer paces at real time. Per-MB is the right normalisation and should carry, but a simulation
should confirm it against its own duty cycle before sizing hosts on it.

## ✅ The counter correction reproduces on a fresh sitting

The [correction](why-an-unfunded-gateway-is-slow-2026-08-08.md) said peer-selection iterations are
counted before bee knows whether it will contact the peer, so real contacts are `attempts − skips`.
Four new arms, computed from deltas rather than totals:

| arm | Δattempts | Δskips | **real contacts** | **per chunk** |
| --- | ---: | ---: | ---: | ---: |
| funded, round 1 | 12,139 | 160 | 11,979 | **1.136** |
| funded, round 2 | 12,163 | 104 | 12,059 | **1.144** |
| unfunded, round 1 | 383,305 | 370,051 | 13,254 | **1.257** |
| unfunded, round 2 | 468,268 | 455,046 | 13,222 | **1.254** |

⭐ **1.25 against 1.14, a 10% difference in network load**, against the 34x the raw counter reads.
The earlier sitting gave 1.281 and 1.296 against 1.142. Two independent sittings agree.

## ✅ A cache halves both the network work and the CPU

Funded arms, cache off against `--cache-capacity=1000000`, same 400 references twice:

| | chunk retrievals | pass 2 median | **CPU per MB** |
| --- | ---: | ---: | ---: |
| cache off | 10,544 and 10,544 | 14ms, 13ms | 1.257, 1.310 |
| **cache on** | **5,614 and 5,631** | **2ms, 3ms** | **0.539, 0.583** |

⭐ **Exactly half the network retrievals**, which is what a cache should do when each reference is
fetched twice, and **2.3x less CPU**.

⚠️ **Every arm this project ran before today set `--cache-capacity=0`**, so every published retrieval
figure is a no-cache figure. That was deliberate while the funding question was open, and it means the
shipping default leaves this on the table.

## ⛔ Two unfunded cache arms are discarded, and the reason is worth more than the arms

The plan ordered arms `L0 U0 LC UC`, so the unfunded cache arm ran straight after the **funded** one.
Its numbers looked spectacular: 2ms medians, 0% late.

They are not retrievals. `req=737` with `reqFail=737`: **every network retrieval failed, and the 2ms
readings are local disk reads of chunks the funded arm had just cached.**

⭐ **The bee data directory is a volume, so the cache survives the container recreate that flips the
arm.** Once caching is on, arms are no longer independent, and an arm inherits whatever its
predecessor left behind. Nothing in the probe's design anticipated that, because with
`--cache-capacity=0` on every previous arm it had never been possible.

**Re-run unfunded-only** (`U0 UC U0 UC`), so a cache arm can only ever inherit from a cache-off arm.
It cost nothing, because a node with no chequebook cannot spend, and it is the most useful result of
the day.

## ⭐⭐ A cache does more for an unfunded node than funding does

Four unfunded arms, 10:20 to 10:26, cache off and on, interleaved:

| arm | pass 1 median | **pass 2 median** | chunk retrievals | **CPU per MB** |
| --- | ---: | ---: | ---: | ---: |
| cache off, round 1 | 119ms | 128ms | 10,544 | **4.117** |
| cache off, round 2 | 87ms | 118ms | 10,544 | **2.962** |
| **cache on, round 1** | 101ms | **3ms** | **5,630** | **1.006** |
| **cache on, round 2** | 115ms | **3ms** | **5,630** | **1.095** |

⭐ **Pass 1 is unaffected**, at 87-119ms in every arm, which is the check that the cache arms are
honest this time: the first fetch of a reference is a real unfunded network retrieval either way.

⭐ **Pass 2 goes from 118-128ms to 3ms.** The second viewer's fetch is not merely faster, it stops
being a network operation.

⭐ **CPU falls 3.4x, from 3.54 to 1.05 CPU-seconds per MB.** Exactly half the chunk retrievals, each
still costing its 25-43 accounting skips, so the skips fall with them: 142,229 and 175,545 against
453,261 and 368,174.

⭐⭐ **And that puts an unfunded node with a cache (1.05 s/MB) BELOW a funded node without one (1.28
s/MB).** On the CPU axis, turning the cache on is worth more than funding the chequebook.

| | CPU-cores per viewer at 720p | viewers on a 48-core host |
| --- | ---: | ---: |
| unfunded, cache off | **1.11** | ~43 |
| funded, cache off | 0.39 | ~120 |
| **unfunded, cache on** | **0.33** | **~145** |
| funded, cache on | 0.17 | ~280 |

⛔ **This does not make an unfunded gateway shippable.** Pass 1 still runs at 87-119ms against a funded
node's 28-44ms, the late share still swung 0.2% to 11.8% across four arms of identical work, and a
cache only helps a chunk somebody already fetched. **It changes what a fleet costs to host, not what a
first viewer sees.**

## ⚠️ The unfunded variance shows up again, unprompted

The two unfunded arms came in at **8.5% and 1.5% late**, three minutes apart, on identical work. A
5.7x spread, consistent with the
[eleven-arm sweep](eleven-unfunded-arms-2026-08-08.md) that ranged 1.9% to 19.5% and found nothing
controllable that explains it.

⚠️ **No chunk took a second or more at the node in any arm**, funded or unfunded, while the client
measured a p90 of 450ms on a whole segment. A segment is about 27 chunks, so the segment-level tail
here is built from many mildly slow chunks rather than from one stalled one. The 1.0-1.1s stalls seen
in live viewer runs did not appear in this sitting, and this probe cannot say whether that is the
archived-segment path or the afternoon.

## What it cost

| | before | after | spent |
| --- | ---: | ---: | ---: |
| gateway chequebook | 6.5007 | **6.4159** | **0.0848 BZZ** |
| uploader chequebook | 2.3238 | **2.3238** | **nothing** |
| postage | n/a | n/a | **nothing** |

⭐ **The whole bill is the four funded arms of the first sitting.** The eight unfunded arms, which carry
every result above, **cost nothing at all**, because a node with no chequebook cannot spend. No
broadcast ran, so nothing was uploaded and no postage was consumed.

The gateway was restored to `--swap-enable=true` and `--cache-capacity=0`, confirmed both in the env
file and in the running container's own arguments.

## Artifacts

`/home/solarpunk/retrieval-probe/cache1/` (this sitting) and `cache2/` (the unfunded re-run), each
holding `probe.log`, `probe-state.tsv`, `probe-series.tsv`, `probe-metrics.tsv` and per-arm, per-pass
timing files. Probe: `deploy/scripts/retrieval-debt-probe.sh`. Sampler:
`deploy/scripts/gateway-retrieval-metrics.sh`.
