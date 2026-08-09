# A cold gateway is finished warming up long before it stops being expensive

**2026-08-09, 01:14 to 01:29 UTC.** One settled node and one freshly recreated node, sampled every five
seconds on the same unfunded arm, with **no retrieval at all**. **Cost: nothing.**

[The cold sitting](a-cold-gateway-needs-a-minute-2026-08-08.md) measured a recreated gateway serving
**2 to 3x more CPU per MB** for its first arm and settling over about four. It could not say why, because
it measured a node that was retrieving, and two very different mechanisms produce the same reading:

- **the retrieval path is more expensive while the node is cold**, or
- **the node is busy with startup housekeeping** and the arm's CPU accounting is charged for it.

This separates them by running no retrieval.

## ⭐⭐ The answer: housekeeping is over in thirty seconds, and the penalty is not

| window | CPU-seconds per second | against warm |
| --- | ---: | ---: |
| **warm reference**, node up 7 minutes | **0.0132** | |
| **cold + 30s** | **0.1847** | **14.03x** |
| cold + 60s | 0.0070 | 0.53x |
| cold + 90s | 0.0140 | 1.06x |
| cold + 120s | 0.0120 | 0.91x |
| cold + 150s | 0.0140 | 1.06x |
| cold + 180s | 0.0087 | 0.66x |
| cold + 210s | 0.0073 | 0.56x |
| cold + 240s | 0.0120 | 0.91x |
| cold + 270s | 0.0083 | 0.63x |
| cold + 300s | 0.0083 | 0.63x |

⭐⭐ **The burst is real, large and short.** Fourteen times the settled rate for the first thirty seconds,
and then **nine consecutive buckets covering four and a half minutes, none of them above 1.06x**. This is
not a decay. It stops.

Per sample, the shape is sharper still:

| seconds after the API answered | CPU-s/s |
| ---: | ---: |
| 5 | **0.8700** |
| 10 | 0.1040 |
| 15 | 0.0380 |
| 20 | 0.0160 |
| **25** | **0.0040** |

⭐ **By twenty-five seconds the node is at the floor**, and the floor is below the warm window's own mean.

## ⭐ What it costs in total, which is a nicer way to see it

The counter is a running total since the process started, so the absolute readings say what coming up
costs outright:

- **3.69 CPU-seconds** were already burned when the API first answered, roughly four seconds in.
- **9.23 CPU-seconds** by thirty seconds in.

At the settled rate of 0.0132 CPU-s/s, 9.23 CPU-seconds is **about twelve minutes** of ordinary
background work. A gateway spends it in half a minute and then stops.

## ⛔ So the cold penalty is in the retrieval path, and this rules out the alternative twice

**Once by timing.** The probe discards a warm-up fetch, reads node metrics and then watches the node do
nothing for fifteen seconds before an arm starts, so its first measured arm begins more than thirty
seconds after the recreate. **The background burst is over before the first number is taken.**

**Once by arithmetic, in the opposite direction.** The probe measures an idle rate in that fifteen second
window and reports `cpuUsed - idleRate x duration`. If background work were still decaying during the
arm, that subtraction would use a rate higher than the arm's true background and **over-correct**, making
a cold arm read **cheaper** than it was. The cold arms read dearer. ⭐ **Background decay cannot produce
the penalty and cannot explain it away either.**

## ⭐ Two candidates eliminated for free, before any of this ran

⛔ **Bee's `--warmup-time` is not the mechanism, despite defaulting to five minutes.** The flag is a
maximum: bee "proceeds when stable or after this time". This node's own log says
`warmupDurationSeconds=1.439946981`. It is over before the first segment is ever asked for.

⛔ **Peer discovery is not the mechanism either.** The node reports **381 peers on the first sample, five
seconds in**, and 381 on every sample afterwards, cold and warm alike. There is no ramp.

⚠️ Peer discovery is, however, almost certainly **what the burst is**. The node's own log emits **4,467
lines in its first minute** against 33 per minute once settled, and **76% of that first minute is
`node/hive`**, the peer discovery gossip protocol. The rate falls to 123 lines in the second minute and
34 by the fourth. Same shape, same timescale.

## ⛔⛔ The consequence: there is no readiness signal that goes green late enough

Every cheap check says a cold gateway is ready long before it is cheap to serve from.

| signal | green after |
| --- | --- |
| `/health` answers | milliseconds |
| bee's own warmup completes | **1.4 seconds** |
| peer count reaches its steady value | **5 seconds** |
| background CPU reaches its floor | **25 seconds** |
| **retrieval actually costs what it normally costs** | **minutes** |

⛔ **A load balancer cannot wait for a signal that does not exist.** The previous sitting said returning a
node to the pool on `/health` alone returns it too early. This says something stronger: **nothing the node
exposes goes green at the right moment**, so waiting is not a strategy at all.

⭐ **The only thing that warms a gateway is retrieval traffic.** A fleet that cares should walk a handful
of references through a new node before admitting viewers to it, and treat the cost of that walk as part
of bringing the node up.

## ⚠️ What this does not show

⚠️ **It does not name the sub-mechanism.** It narrows the cold penalty to the retrieval path and rules out
background work, bee's warmup and peer discovery. Whether the remaining cost is per-peer stream setup, an
unlearned peer selection, or first contact accounting is **unmeasured**, and this run cannot see it
because it never retrieves anything.

⚠️ **One cold start sampled at full protocol.** A second, independent recreate during the proving pass
agrees: its first fifteen seconds averaged **0.3973 CPU-s/s** against **0.337** for the same window of the
real run, an 18% spread on a signal whose effect is 14x. Two cold starts, not twenty.

⚠️ **The proving pass looked like a failed control and was not.** It was built to give a null: both
windows opened on a node that had been up for ten seconds, so the ratio should have been near 1.0. It
came back **13.70x**. The reason is the finding itself. Its warm window opened at ten seconds, already
past the burst, while its cold window opened at zero and caught it. ⭐ A control that fails in a way the
mechanism predicts is evidence, but only once the mechanism is known, so it was rerun at full protocol
rather than believed.

⚠️ Unfunded gateway, one host, no retrieval, and the host was quiet throughout at 2 to 11 runnable tasks
of 48 cores.

## Artifacts

`/home/solarpunk/retrieval-probe/coldidle/`. Instrument:
[`deploy/scripts/cold-gateway-idle-cpu.sh`](../../deploy/scripts/cold-gateway-idle-cpu.sh). Gateway
restored to `--swap-enable=true` and `--cache-capacity=0`.
