# The ceiling is bytes per second, not viewers, and a cold gateway is a different machine

**2026-08-08, 15:48 to 16:02 UTC.** Sixteen arms on an unfunded gateway, scaling the audience from 128
to 512 viewers **with the cohort size held constant at 8**, alternating against a 128-viewer reference.
Two rounds. **Cost: nothing.** The chequebook was byte-identical before and after.

The open question was where the concurrency knee sits, since 128 viewers scattered into cohorts of 8
had been measured as comfortable and nothing above that had been tried. The sweep answers it, corrects
how the previous finding was framed, and turns up a second result nobody was looking for.

## ⭐ The design, and why cohort size is held fixed

[The cohort finding](a-synchronised-audience-is-the-failure-2026-08-08.md) showed that 128 viewers in
cohorts of 8 hold zero buffer drain while 128 on one tick drain 12.8 seconds. That measured cohort
size at a fixed audience. This sweep does the opposite: it **scales the audience and scales the spread
with it**, so every arm has the same cohort of 8 and only the total changes.

| arm | viewers | spread | viewers per chunk |
| --- | ---: | ---: | ---: |
| R128, the reference | 128 | 16 | 8 |
| N192 | 192 | 24 | 8 |
| N256 | 256 | 32 | 8 |
| N384 | 384 | 48 | 8 |
| N512 | 512 | 64 | 8 |

⭐ **The reference is interleaved between every scaled arm rather than run once.** The probe's own
notes warn that a ladder cannot resolve anything under about 2x, because relabelling eight unchanged
runs as if the viewer count had varied moved the metric by up to 1.95x with nothing happening. That
warning is what caught the second finding below.

## ⭐⭐ The result: the knee is between 128 and 192, and it is a byte rate

| arm | ended behind, round 1 / 2 | over the 267ms budget | throughput |
| --- | ---: | ---: | ---: |
| **R128** | **0 / 0ms** | **0.0 / 0.0%** | 33.0-34.5 MB/s |
| N192 | 10293 / 3298ms | 35.5 / 20.8% | 37.5 / 43.5 MB/s |
| N256 | 11553 / 11520ms | 34.7 / 33.7% | **43.9 / 43.9 MB/s** |
| N384 | 27749 / 25612ms | 42.2 / 40.2% | 41.8 / **44.4** MB/s |
| N512 | 42900 / 37335ms | 40.4 / 43.2% | 40.3 / 42.7 MB/s |

⛔ **Holding the cohort at 8 did not save any of them.** Every arm above 128 drains buffer, in both
rounds, and 512 viewers end 37 to 43 seconds behind.

⭐⭐ **Throughput plateaus at 43 to 44 MB/s** across four different concurrencies and both rounds, while
the demand at those concurrencies runs from 59 to 88 MB/s. The arms are not failing at different
points. They are all failing against the same wall, and each one falls behind by roughly the amount its
demand exceeds it.

✅ **The reference held at exactly zero in all seven of its uncontaminated appearances**, with medians
of 27 to 70ms and nothing over budget. 128 viewers is not marginal. It is comfortably inside.

## ⭐ What the ceiling is not

At the top arm, three separate resources that could explain a 43 MB/s wall all have headroom:

| | at 512 viewers | of |
| --- | ---: | ---: |
| bee's own CPU | 407-408 CPU-seconds over 68-72s = **~6 cores** | 48 |
| host load average, peak | **31.6-35.9** | 48 |
| network | 43 MB/s = **344 Mbps** | 1000 |

⭐ **So the ceiling is internal to bee**, which is consistent with LAT-11 having put the concurrency
limit inside bee rather than in the network or the wallet. It is not a capacity that can be bought with
a bigger box or a faster link.

⚠️ The host load figure is new, added for this sweep precisely so a starved probe client could not be
mistaken for a slow gateway. At 36 of 48 there were roughly twelve idle cores, so the probe's own
clients were not being descheduled. That is what licenses the conclusion above.

## ⭐⭐ The reframe: it is bytes, so the capacity is a bitrate

This sitting's segment is **94.4 KB per 267ms**, which is **2.83 Mbps per viewer**. Divide the plateau
by it and the viewer capacity falls out at **roughly 120 to 130 viewers per gateway**, which is exactly
where the measured boundary sits between the 128 that holds and the 192 that does not.

⛔ **So "how many viewers fits behind a gateway" is not a number, it is a number per bitrate.** The
same gateway that holds ~123 viewers here would hold roughly half that at 6 Mbps.

⚠️ **1080p at 6000k ships and has never been measured this way.** On this arithmetic alone it would put
a gateway's capacity near 60 viewers rather than 123, but that is division rather than a measurement,
and [the scale handover](../scale/running-a-high-scale-event-on-swarm.md) already separates figures
that were measured from figures that were derived for exactly this reason.

⭐ **This does not overturn the cohort finding, it bounds it.** Cohort size decides whether a given
audience is served efficiently or wastefully, and it was measured at a fixed audience where the byte
rate was not the binding constraint. Aggregate byte rate decides how large the audience can be at all.
Both are real, and a deployment has to clear both.

## ⭐⭐ The result nobody asked for: a cold gateway is roughly 3x more expensive

The first arm of round 1 is the same work as the other seven references, 7680 fetches and 725 MB, and
it did not behave like them at all.

| R128 appearance | gateway CPU | CPU per MB | ended behind | over budget |
| --- | ---: | ---: | ---: | ---: |
| **round 1, first arm of the sitting** | **194.0s** | **0.267** | **13411ms** | **47.1%** |
| round 1, 3rd arm | 81.8s | 0.113 | 0ms | 0.0% |
| round 1, 5th and 7th | 71.3 / 74.8s | 0.098 / 0.103 | 0 / 0ms | 0.0 / 0.0% |
| round 2, all four | 69.5-70.4s | 0.095-0.097 | 0ms | 0.0% |

⛔⛔ **Identical work cost 194 CPU-seconds cold and 70 warm.** The second arm shows it too: N192 took
210.7s in round 1 against 132.8s in round 2 for the same arm.

⭐ **It is the recreate, not the label or the round.** Round 2 opens with R128 as well, and round 2's
R128 is clean at zero, because by then the node has been up for ten minutes. The only thing that
distinguishes the contaminated arms is that a container recreate happened shortly before them.

⭐ The node's own counters agree. Peer count is flat at 368 throughout, so this is not a node short of
peers. What moves is the accounting: peers in debt fall **239 to 119** and total debt shrinks by more
than half across the sitting as the node settles into its relationships.

⚠️ **The probe already discards a warm-up retrieval for exactly this reason and it is not enough.** The
discard covers a single fetch of 8 to 10 seconds. What this shows is a degradation that takes **three
to four arms, roughly two minutes**, to decay.

### Why this matters beyond the harness

⭐ **A gateway restarted mid-event is not the same gateway for its first couple of minutes.** At 128
viewers, which is inside its steady-state capacity, a cold node put 47% of segments over budget and
left viewers 13 seconds behind. Warm, the identical load put nothing over budget at all.

⛔ **So a newly provisioned gateway should be warmed before viewers are pointed at it**, and a restart
during a live event should be treated as taking that gateway out of service for minutes rather than
seconds.

⚠️ ⛔ **Every sitting this project has run put a real arm first.** The effect is largest for arms near
a limit, which is why it surfaced here and not in the cache sweep, where the first arm's median was
114ms against 109 and 105 for its siblings. It is worth re-reading any past first arm before quoting
it, and worth a throwaway arm at the head of every future plan.

## ⚠️ What this does not show

⚠️ **One gateway, one host, one bitrate.** The plateau is this node's, and the viewer counts derived
from it are that plateau divided by this sitting's segment size.

⚠️ **192 is close enough to the boundary to be unstable**, at 10293ms in one round and 3298 in the
other. The arms from 256 up are consistent to within a few percent, so the instability is a property of
sitting near the knee rather than of the instrument.

⚠️ **Probe viewers, not browsers.** No decoder, no buffer, no feed walk. Ending lag is arithmetic
against a start-to-start deadline rather than an observed stall, which is the right model for retrieval
load and not a model of playback.

⚠️ **Unfunded gateway**, which asks many more peers per chunk than a funded one. Every arm here shares
that condition, so the comparison holds, and the absolute plateau on a funded node is unmeasured.

⚠️ **The cold-gateway mechanism is described, not explained.** The accounting counters move in the
right direction and the peer count does not, which narrows it, but naming the exact cause would need
more than this sitting.

## Artifacts

`/home/solarpunk/retrieval-probe/KNEE1/`. Probe: `deploy/scripts/retrieval-debt-probe.sh`, with viewers
as the 5th arm field and spread as the 7th. Host load was added to the probe for this sweep and its
ceiling was set at 40 of 48 cores, which never tripped: the hottest arm peaked at 35.94. Gateway
restored to `--swap-enable=true` and `--cache-capacity=0` and confirmed on the node.
