# The 267ms tables are approximately right, and this morning I said they were pessimistic

**2026-08-15, free.** No broadcast, no BZZ. 764,340 per-retrieval timings already on disk across 50
arms and 11 sittings, rescored at four thresholds.

> ## ⛔⛔ THIS CORRECTS A CORRECTION I MADE THIS MORNING
>
> `corpus-audit-2026-08-15.md` found that `docs/scale/running-a-high-scale-event-on-swarm.md` scores
> every over-budget share against **267ms**, the latbench rig's segment duration, while the shipped
> profile is 0.5s and a **500ms** budget. I wrote that this makes every share in that document an
> **upper bound**, which reads as "the real numbers are better".
>
> ⛔ **That framing missed half the change.** A 0.5s GOP does not only double the budget, it
> **doubles the segment**, 94 kB to 188 kB. A bigger segment takes longer to retrieve. **The two
> effects run in opposite directions and very nearly cancel.**

## The arithmetic

| | multiplier |
| --- | ---: |
| budget, 267 → 500 ms | **1.87x** |
| segment, 94 → 188 kB | 2.00x |
| **retrieval time**, if `time ∝ bytes^k` | **1.45x to 1.84x** |

Two estimates of `k` from healthy-content measurements this project already holds:

| source | range | `k` |
| --- | --- | ---: |
| `size-on-healthy-content-2026-08-11.md` | 407 → 801 kB | **0.53** |
| `golden-zone-2026-08-10.md` | 120 → 358 kB | **0.88** |

⚠️ **Neither is measured in the 94-188 kB range this needs**, and they disagree by enough to matter.
The golden-zone pair is the closer of the two to our sizes and gives the pessimistic answer.

## What the retrievals say

Scoring the same 764,340 timings at the threshold each case implies:

| threshold | over budget | what it represents |
| ---: | ---: | --- |
| **267 ms** | **20.6%** | as published, the rig's budget |
| 272 ms | **19.8%** | shipped profile if `k = 0.88` |
| 346 ms | **15.1%** | shipped profile if `k = 0.53` |
| ~~500 ms~~ | ~~11.3%~~ | ⛔ **naive rescore. Ignores the bigger segment. Do not use** |

⭐⭐⭐ **So the published tables are between exactly right and 5.5 points pessimistic**, not the
1.8x-too-pessimistic that dropping the budget in alone suggests. **The correction I published this
morning overstated the gap by roughly a factor of six.**

## ⭐⭐ The one conclusion that does move

`running-a-high-scale-event-on-swarm.md` reads: *"At 128 the median segment transfer is 248ms against
a 267ms budget. The typical segment barely fits."*

| | |
| --- | ---: |
| measured median at 128 viewers | 248 ms |
| shipped-profile equivalent, `k = 0.88` | 456 ms against 500 |
| shipped-profile equivalent, `k = 0.53` | 359 ms against 500 |

⚠️ **"Barely fits" holds in the pessimistic case at 91% of budget and eases to 72% in the optimistic
one.** It does not become comfortable in either. The load-planning conclusion survives.

## ⛔ And the shift is not uniform, which is why no table should be rescaled

Per-arm, moving from 267 to 500 ms shifts the over-budget share by **0.0 to 26.3 points**. Arms whose
retrievals cluster well inside both thresholds do not move at all, and arms with a heavy tail move a
lot. **An over-budget share is a count against a threshold. It does not convert**, and applying a
single factor to a table of them would be inventing data.

| example arms | at 267 ms | at 500 ms | shift |
| --- | ---: | ---: | ---: |
| `KNEE1/R128b` | 0.0% | 0.0% | 0.0 pt |
| `conc3/U128` | 45.1% | 18.7% | **26.3 pt** |
| `spread3/J1` | 41.1% | 16.9% | 24.2 pt |
| `JIT4/S16` | 0.5% | 0.1% | 0.4 pt |

## What this changes

- ✅ **The scale handover's tables can be read roughly as they stand.** They are not badly pessimistic.
- ⛔ **Strike "upper bound" as the framing.** The right framing is that budget and payload both roughly
  double and the net is small and uncertain in sign-of-magnitude, not in direction.
- ⛔ **Do not rescore anything at 500 ms without also scaling the payload.** That is the mistake this
  document exists to prevent, and I made it first.
- ⚠️ **`k` is the open quantity**, 0.53 against 0.88 from two sittings at the wrong sizes. **#84** is
  the design that would settle it, and this is a second reason to run it.

⚠️ **Nothing here is a new measurement.** It is 764,340 timings already on disk read against different
thresholds, plus an exponent borrowed from two sittings measured outside the range where it is
applied. A real answer scores the shipped profile directly.
