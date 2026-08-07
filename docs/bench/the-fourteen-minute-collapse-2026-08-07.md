# The fourteen-minute collapse: the read path halved, and nothing else moved

**2026-08-07.** `the-third-attempt-at-1080p-2026-08-07.md` closed by naming this as the open question:
"A broadcast that plays perfectly and then loses its buffer for good is worth more attention than a
tenth of a second of steady-state latency." This is that attention, paid entirely from artifacts
already on disk. **0.000 BZZ spent.**

⭐ **The cause is now located to the second and to the layer**: the gateway's read path slowed by
about 4.9x at **t = 822s**, and the buffer drained from that instant. ✅ **The profile question the
third-attempt report left open is answered, and it points the opposite way from the suspicion.**
⚠️ **What slowed the node is not established**, and no browser-side artifact can see that far.

Replayed from `browser-watch-2026-08-07T10-32-55-185Z` and the fourteen other archived runs.

## What actually happened, minute by minute

| minute | requests | delivered | median transfer | median segment | buffer | rebuffers |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1-13 | 60/min | 792 kB/s | 218-324ms | 794 kB | 4.6s | 0 |
| 14 | 49 | 648 kB/s | **1156ms** | 794 kB | **1.07s** | 11 |
| 15-19 | 47-48 | 621-633 kB/s | 1153-1216ms | 793 kB | 0.45-0.68s | 22-32 |

**The segments did not change.** Median segment stays within 1% of 794 kB from the first minute to the
last, so the encoder was not the trigger and demand was constant throughout.

**The client did not change.** It asked once a second while it could. When each answer began taking
longer than a second, it could no longer ask once a second, and the request rate fell to match.

## The onset is a step, not a drift, and both request kinds took it together

Segment transfers sat at 220-330ms until **t = 822s**, then climbed over about 25 seconds and settled
into a wide, slow band:

| | n | p10 | median | p90 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| before, 0-13 min | 786 | 201ms | **245ms** | 324ms | 964ms |
| after, 14-20 min | 286 | 461ms | **1161ms** | 1778ms | 2515ms |

The feed-slot lookups moved at the same moment and by a similar factor, from a 236-448ms median across
minutes 0-13 to 859-1016ms across minutes 14-19. ⭐ **Two different endpoints, one shared degradation,
one instant.** That is the shape of the node getting slower, not of any one path breaking.

⚠️ **It is not a timeout.** A timeout would pile up at a constant value. The post-onset spread runs
from 306ms to 2515ms, which is genuine variance in service time.

## The order of events settles which thing caused which

| t | what |
| ---: | --- |
| 821s | buffer 5.07s, zero stalls, target 6.0s |
| **822s** | **transfer time steps up, buffer 3.94s and falling** |
| 851s | buffer 2.69s |
| 860s | buffer 0.48s |
| 870s | first stall, and the player raises its latency target 6.0 → 7.0 |
| 880s | latency 9.32s |

⭐ **The buffer collapsed first, the stall followed 48 seconds later, and the target rise followed
that.** So the latency-target penalty of `one-stall-costs-a-second-2026-08-07.md` is downstream of
this, a consequence rather than a cause. The gate that voided B2's latency reading was reading a real
event correctly.

## ✅ It is 1 run in 15, and the 1.0s profile is not the fragile one

Every archived browser run was swept for a sustained transfer-time step, across both resolutions, both
segment lengths, and 10 to 60 minute durations. **B2 is the only run that has one.** The next largest
is 1.57x, which is ordinary variation. B2 is 4.86x.

That makes "it has happened once in three 1.0s arms at 1080p" too narrow a frame. It has happened once
in fifteen runs, and the profile is not what the fifteen separate on.

Ranking every profile by how much slack it has, baseline transfer against the time one segment must
cover:

| profile | runs | median transfer | budget | headroom |
| --- | ---: | ---: | ---: | ---: |
| 1280x720 @ 1.0s | 4 | 158ms | 1000ms | **6.3x** |
| 1920x1080 @ 1.0s | 2 | 225ms | 1000ms | **4.4x** |
| 1280x720 @ 0.25s | 18 | 82ms | 250ms | 3.0x |
| 1920x1080 @ 0.25s | 10 | 90ms | 250ms | **2.8x** |

⭐ **The 0.25s profile has the thinnest margin against a slow read, not the 1.0s profile.** A shorter
segment does not buy resilience here, because the work per segment falls more slowly than the deadline
does. B2 broke because a 4.9x degradation is larger than its 4.4x margin. The same degradation landed
on a 0.25s arm would have crossed a 2.8x margin sooner and harder.

This is a fourth independent reason favouring the longer segment, after cost, postage and refusals,
and like those three it does not go through the player's latency target.

## ⛔ The viewer was told nothing, for six minutes

`feedStateMessage` is empty for every one of the 1185 samples, including the 296 taken while the
buffer sat under 0.7s with 144 rebuffers behind it. A broadcast degraded to the point of stalling
every few seconds showed the same interface as a healthy one.

This is the mechanism `#100` already names: the overlay's threshold counts polls, and the poll rate
collapses during exactly the stall it is supposed to report. **This run is a clean second sighting of
it**, on a fault the overlay was built for.

## What a reader should take from this

1. ⭐ **The collapse is a read-path service-time step**, located at t = 822s, affecting feed lookups
   and segment bytes together and in proportion, with demand, client behaviour and the write path all
   unchanged.
2. ✅ **The profile question is closed in the opposite direction from the suspicion.** By headroom the
   1.0s arms are the safest of the four profiles, and 1080p at 0.25s is the thinnest.
3. ⚠️ **Cause inside the node is not established, and cannot be from these artifacts.** Everything
   above is measured at the browser, which can see that answers got slower but not why.
4. ⛔ **Do not buy a repro.** One occurrence in fifteen runs is roughly a 7% chance per twenty-minute
   arm, at about 0.8 BZZ an arm. The expected cost of catching it once by re-running is around 11 BZZ,
   against a chequebook that is the binding budget. **Instrument instead, and let it be caught the
   next time it happens on a run that was going to happen anyway.**
5. ⭐ **Two changes cost nothing and turn the next occurrence into an answer**: sample the gateway
   node's own service metrics alongside the browser during a run, and fix the overlay so a viewer is
   told. The second one is worth doing whatever happens to the first, because it is the viewer-facing
   half.
