# A synchronised audience is the failure, and it was mine

**2026-08-08, 12:34 to 13:08 UTC.** Eighteen arms on an unfunded gateway at 64 and 128 concurrent
paced viewers, sweeping how far apart their playback positions sit. **Cost: nothing.** The chequebook
was byte-identical before and after.

⛔ **This corrects the headline findings of two reports written earlier the same day.** The concurrency
knee, the throughput ceiling and the pooling story were all measured with every viewer firing on the
same tick, which is the worst case rather than the normal one.

## Why the question came up

[Paced arms an hour earlier](what-a-paced-viewer-costs-2026-08-08.md) found 128 viewers could not keep
up: 96% of fetches started behind and the worst viewer ended 8 to 11 seconds behind, still losing. That
report closed by naming its own weakest assumption. **Every viewer in it fired on the same schedule**,
so they all asked for the same chunk at the same instant.

The prediction was that scattering them would be **worse**, because bee merges simultaneous requests
for one chunk into one network retrieval, and that merging is the whole basis of "pool viewers behind
gateways". Scattered viewers want different chunks and have nothing to merge.

⭐⭐ **The prediction was wrong in every measurable direction.**

## ⭐⭐ 128 viewers, scattered, are comfortable on one unfunded gateway

`spread` puts viewer *v* one whole segment behind the viewer in front, so `spread=16` means sixteen
cohorts at sixteen playback positions. Two rounds, cache-off arms always before cache-on ones.

| viewers | spread | cache | median | p90 | over 267ms | **ended behind** | CPU-s/MB |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 128 | 1 | off | 218 / 216ms | 873 / 680ms | 43.3 / 32.1% | **25652 / 5618ms** | 0.233 / 0.199 |
| **128** | **16** | off | **68 / 57ms** | **122 / 131ms** | **1.7 / 1.7%** | **0 / 0ms** | 0.133 / 0.124 |
| **128** | **16** | **on** | 98 / 95ms | 141 / 134ms | **0.0 / 0.0%** | **0 / 0ms** | **0.122 / 0.119** |
| 64 | 1 | off | 144 / 100ms | 606 / 248ms | 24.1 / 7.1% | 1281 / 0ms | 0.222 / 0.177 |
| **64** | **8** | off | **42 / 30ms** | **79 / 126ms** | **1.9 / 2.7%** | 0 / 111ms | 0.145 / 0.163 |
| **64** | **8** | **on** | 40 / 29ms | 63 / 55ms | **0.0 / 0.0%** | **0 / 0ms** | **0.127 / 0.127** |

⭐ **Scattered, 128 viewers hold zero ending lag in every arm.** Synchronised, the same 128 viewers on
the same node drain 25.6 and 5.6 seconds of buffer and are still losing when the walk stops.

⭐ **Wall clock says it plainly.** A `spread=16` arm should take `100 x 267ms` plus `15 x 267ms` of
stagger, or 30.7s. It took 32s, **4% over**. The synchronised arm took 53s against an ideal 26.7s.

⭐ **Scattering is cheaper in CPU too**, 0.124-0.133 CPU-s/MB against 0.199-0.233.

## ⭐⭐ It is the cohort size, not the spread

Sweeping the spread at a fixed 128 viewers turns it into a number an operator can act on:

| spread | **viewers arriving together** | over 267ms | **ended behind** |
| ---: | ---: | ---: | ---: |
| 1 | **128** | 40.3 / 41.9% | 8380 / 12813ms |
| 2 | **64** | 30.2 / 45.5% | 7053 / 13308ms |
| 4 | **32** | 13.7 / 0.5% | 3133 / 502ms |
| **16** | **8** | **1.7 / 1.7%** | **0 / 0ms** |

⭐⭐ **What decides it is how many viewers land in the same instant, not how far the audience is spread
in time.** 64 viewers in cohorts of 8 behave like 128 viewers in cohorts of 8. Both are fine. 128
viewers in one cohort of 128 fail in all six arms that have ever been run that way.

⚠️ **Cohorts of 32 and 64 are the unstable middle**, and they straddle the unfunded node's own spread:
`spread=4` was 3133ms in one round and 502ms in the other. **Treat anything above a cohort of about 8
to 16 as risk rather than as a working configuration.**

## ⭐ And it costs the network less, not more

Network contacts are `peer request count` minus `accounting blocks`, because on an unfunded node the
peer counter includes peers that were skipped without being contacted. At 128 viewers:

| arm | retrieval operations | **network contacts** |
| --- | ---: | ---: |
| synchronised | | **17,140 / 10,757** |
| scattered x16 | | **7,956 / 6,688** |
| **scattered + cache** | | **2,451 / 1,691** |
| *at 64 viewers:* synchronised | 109,399 / 99,120 | 8,590 / 6,716 |
| *at 64 viewers:* scattered x8 | **19,286 / 31,370** | 5,725 / 7,196 |
| *at 64 viewers:* scattered + cache | **5,109 / 5,856** | 2,365 / 3,219 |

⭐ **Scattering roughly halves network contacts** where the prediction was that it would multiply them
by the cohort count.

⭐ **At 64 viewers, synchronising them cost 5x the retrieval operations**, 109,399 against 19,286 for
byte-identical work. The scattered figure is the honest one: 19,286 against about 2,300 distinct chunks
is **8.4 per chunk for 8 cohorts**, which is one network fetch per cohort exactly as intended. The
synchronised figure is 47 per chunk. **Firing 64 requests for one chunk at the same instant does not
get them merged. It gets them raced.**

⭐⭐ **Scattered plus cached reaches the floor.** 1,691 to 2,451 contacts against ~2,300 distinct chunks
is **one network fetch per chunk, serving 128 viewers**. That is the ideal the pooling story promised,
and it needs the cache and a scattered audience together.

## ⛔ What this corrects

| claim, earlier the same day | status |
| --- | --- |
| "the knee is at 128 viewers" | ⛔ **measured on synchronised load.** 128 scattered viewers are comfortable and the knee has not been found |
| "pool 32 to 64 viewers per gateway" | ⛔ **conservative by at least 2x.** 128 works scattered, on an unfunded node |
| "the ceiling is ~32 MB/s" | ⛔ **that is a burst ceiling.** Scattered, the same node sustains 1201 MB in 32s = **37.5 MB/s** with 1.7% late |
| "16 viewers cost the network what one costs" | ⚠️ **true only when arrivals are not simultaneous.** The mechanism is real, and synchronising defeats it |
| "a cache halves retrievals" | ⚠️ **understated.** With a scattered audience it takes network contacts to one per distinct chunk |

## ⭐ Which case is real

**A real audience is scattered.** Players join at different moments, hold different buffer depths and
poll on timers that started whenever they happened to start. Nothing lines them up.

⛔ **So synchronisation is a failure mode rather than a baseline, and the moment it happens is after a
common shock**: an upstream outage clearing, an encoder restart, a manifest gap that every player
recovers from at once. **The recovery path is exactly where a herd forms**, and this is what one looks
like: 40% of segments late, and a buffer draining 12.8 seconds deep on a node that handles the same
load comfortably when the same viewers are 4 seconds apart.

⛔ **A client CANNOT buy this by jittering its own request schedule, and this report originally said
it could.** [Measured hours later](jitter-is-not-what-breaks-a-herd-2026-08-08.md): 60ms of
per-request jitter at 128 viewers is indistinguishable from none, in both rounds.

⭐⭐ **The reason corrects the framing above.** What limits the gateway is not how many viewers arrive
in the same *instant*, it is how many want the same *chunk* at the same time. Positional spread gives
chunk diversity, so the gateway has something to spread the work across. Jitter leaves every viewer at
one playback position wanting one chunk a few tens of milliseconds later, and buys none. The two only
converge once the jitter approaches a whole segment duration, which is a latency cost at the live edge
and which disagreed between rounds anyway.

⭐ **What does mitigate a herd is the gateway cache and pooling**, both measured the same day, and
neither is a client change.

## ⚠️ What this does not show

⚠️ **`spread=16` at a 267ms segment scatters viewers over 4.3 seconds**, which is more than a live
audience with a two or three segment buffer would naturally show. **Cohorts of 8 are what was proven,
not 4.3 seconds specifically**, and 64 viewers at `spread=8` (2.1 seconds) behaves identically.

⚠️ **The cohorts here are exact and evenly sized.** A real audience is randomly distributed, which will
produce occasional larger cohorts by chance. Nothing has measured a random distribution.

⚠️ **Unfunded gateway throughout**, whose run-to-run spread on identical work reaches tenfold. That is
why the unstable middle is reported as unstable rather than ranked.

⚠️ 0.25s profile, 100 references, one host, two rounds, and **no broadcast**: these are archived
segments, so the transfer times are not viewer latency and only compare to each other.

## Artifacts

`/home/solarpunk/retrieval-probe/{spreadproving,spread1,spread2,spread3}/`. Probe:
`deploy/scripts/retrieval-debt-probe.sh`, spread is the 7th arm field. The `spread=1` arms reproduce
the earlier synchronised paced arms, which is the control that makes the difference the spread rather
than a changed setup. Gateway restored to `--swap-enable=true` and `--cache-capacity=0` and confirmed
on the node.
