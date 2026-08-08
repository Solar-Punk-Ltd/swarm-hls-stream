# Ultra-light at the profile that ships

**2026-08-08, 02:30 to 04:00 UTC.** Six arms interleaved in one sitting on `latbench`, 720p 2500kbps
at **0.25s GOP**, watched in Chrome on the deployment host. Three funded, three unfunded, fifteen
minutes each for the four that count.

This is the sitting the [1.0s report](light-vs-ultra-light-at-a-viewer-2026-08-07.md) said was owed.
That one answered the funding question at a 1.0s GOP and could not answer it here.

## Every arm held

| round | arm | segment | median transfer | of the segment budget | buffer | stalled | rebuffers | advance |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| proving | L funded | 0.267s | 57ms | 21.3% | 5.13s | 0 | 0 | 1.002 |
| proving | U ultra | 0.271s | 134ms | 49.4% | 4.89s | 0 | 0 | 1.002 |
| 1 | L funded | 0.264s | 63ms | 23.9% | 5.00s | 0 | 0 | 1.001 |
| 1 | U ultra | 0.267s | **131ms** | **49.1%** | 4.78s | 0 | 0 | 1.001 |
| 2 | L funded | 0.265s | 63ms | 23.8% | 5.02s | 0 | 0 | 1.001 |
| 2 | U ultra | 0.268s | **142ms** | **53.0%** | 4.82s | 0 | 0 | 1.000 |

All six instrument-sound. All six at a latency target of 6, so no arm carries a stall penalty and
every latency here is comparable with every other. **Zero segments never served, in any arm.**

✅ **Forty-five minutes of unfunded playback at the profile that ships, and nothing stalled, nothing
rebuffered, and the buffer never moved off 4.8s.**

✅ **The axis is verified rather than assumed.** Every arm delivered 0.264 to 0.271s segments against
the 0.267s an eight-frame GOP at 30fps asks for. The 1.0s sitting could not have told the difference,
and on 2026-08-05 twelve runs swept a GOP that never reached the segment.

## And yet this does not clear ultra-light for the shipping profile

**Because 2026-08-06 collapsed at this same GOP**, and the only thing that differs is how fast the
unfunded node was.

| sitting | arm | transfer | of budget | buffer | outcome |
| --- | --- | ---: | ---: | ---: | --- |
| 2026-08-06 | U1 | 156ms | 62.4% | 3.12s | 3 rebuffers |
| 2026-08-06 | U2 | 172ms | 68.8% | **1.46s** | **17 rebuffers**, fps below encoded |
| **2026-08-08** | U proving | 134ms | 49.4% | 4.89s | clean |
| **2026-08-08** | U round 1 | 131ms | 49.1% | 4.78s | clean |
| **2026-08-08** | U round 2 | 142ms | 53.0% | 4.82s | clean |

⛔ **The outcome is a threshold, and the two sittings sit on opposite sides of it.** Around half the
segment budget the buffer holds. Around two thirds it drains and does not recover. Nothing in between
has been measured.

⛔ **The unfunded node's spread is larger than its margin.** Across the two sittings it ran 131 to
172ms, a range of 31%, and the distance from this sitting's worst arm to 2026-08-06's first failing
one is 14ms. **The variation an operator cannot control is wider than the headroom they would be
relying on.**

✅ **The funded arm has no such problem.** 57, 63, 63ms here and 65.5, 91ms on 2026-08-06: a quarter of
the budget with three times the headroom, and no failing arm in either sitting.

### A corroboration worth keeping

Refusals ran **40 and 19** in the funded arms against **1 and 1** in the unfunded ones, out of ~3400
requests each. A refusal is a 404 for a slot the publisher has not written yet, so the fast node
occasionally outruns the live edge and the slow one never gets close enough to try. The asymmetry is
the same mechanism seen from the other end, and it is the shape a viewer would not notice at all.

## The standing answer

**Do not ship an unfunded viewer gateway.** Not because it broke here, it did not, but because a
funded node sits at a quarter of the segment budget and an unfunded one sits at half, with a cliff
close above it and a spread that reaches the cliff. "It held on the night we measured it" is not a
deployment argument.

**What would change that** is either a mechanism for why the unfunded node was 24% faster on one night
than another, or a segment length with enough budget to absorb the penalty. The 1.0s sitting already
showed the second works: at a 1000ms budget the same 2 to 4x penalty is absorbed completely.

## What it cost

| | before | after | spent |
| --- | ---: | ---: | ---: |
| gateway chequebook | 7.233 | 6.807 | **0.426** |
| uploader chequebook | 3.528 | 2.324 | **1.204** |
| postage, fullest bucket | 141/256 | 151/256 | 10 buckets |

**1.63 BZZ**, against the 2.94 the funding guard reserved. The gateway paid **0.353 BZZ per 30
minutes** at 0.25s against 0.307 to 0.317 at 1.0s, so a shorter segment costs about 15% more per
minute to read, which is consistent with cost per byte not carrying across segment lengths.

The three unfunded arms cost the gateway nothing at all, which remains the deployment argument in
ultra-light's favour and the reason the question keeps being asked.
