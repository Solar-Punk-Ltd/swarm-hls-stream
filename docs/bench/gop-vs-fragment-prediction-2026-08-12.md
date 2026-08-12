# Prediction: which knob sets our segment length, `hls_fragment` or the GOP

**Written 2026-08-12, before any arm ran.** Registered here so the answer cannot be read backwards out
of the data. Instrument `deploy/scripts/srs-segment-duration.mjs`, arms in
`gop-vs-fragment-plan-2026-08-12.json`, free and local.

## Why this is being asked now

`c4-across-sizes-2026-08-12.md` turned segment size into a **latency** decision with a direction:
prefer small. That only helps if we know which knob moves it. The compose default is
`hls_fragment 0.25` while `DEFAULT_KNOBS` in `e2e/src/bench/wallclockPublisher.ts` sets
`gopSeconds: 2`, an 8x gap, and **no bracket has ever run a GOP longer than the fragment.**

⛔ Reaching for the wrong knob is exactly how `HLS_FRAGMENT` got blamed for the 1.917s. See
`segment-stretch-2026-08-12.md` for how far that went before it was caught.

## The recipe this has to run on, and why

SRS cuts a segment at a keyframe, so what matters is how much **time** a GOP spans, not how many
frames it holds. Under the stamped recipe the publisher has no brake, runs flat out, and a 60-frame
GOP spans a fraction of a second, so `hls_fragment` wins for every GOP value tested. That result
would be a property of the broken instrument rather than of SRS.

⭐ **So the bracket runs on `probe`, which is paced**, and 30 frames really do span one second. That
is also what a real broadcaster does, and nothing shipped uses wallclock stamping: it appears only
under `e2e/` and `deploy/scripts/`.

Two controls ride along on the shipped pair (fragment 0.25, GOP 2.0): a `bench-nostamp` arm to show
SRT and MPEG-TS change nothing, and a `bench` arm to show the stamped recipe collapsing to the
fragment, which is the prediction above stated as a falsifiable claim rather than an aside.

## The two models

Both say the GOP takes over once it is longer than the fragment. They disagree only on whether SRS
cuts at a keyframe **at** the fragment boundary or the first one **after** it, so they separate
exactly when the fragment is an integer multiple of the GOP.

| | rule | frag 0.25 / GOP 0.25 | frag 1.0 / GOP 1.0 | frag 1.0 / GOP 0.5 | frag 2.0 / GOP 1.0 |
| --- | --- | ---: | ---: | ---: | ---: |
| **M1** at-or-after | `ceil(frag / gop) * gop` | 0.25 | 1.0 | 1.0 | 2.0 |
| **M2** strictly after | `(floor(frag / gop) + 1) * gop` | **0.50** | **2.0** | **1.5** | **3.0** |

Where the fragment is not a multiple of the GOP both models agree, so those arms test the shared
claim rather than the difference:

| pair | both models |
| --- | ---: |
| frag 0.25 / GOP 0.5 | 0.5 |
| frag 0.25 / GOP 1.0 | 1.0 |
| **frag 0.25 / GOP 2.0**, the shipped pair | **2.0** |
| frag 1.0 / GOP 2.0, the deployment's pair | 2.0 |

⚠️ M2 is the one the existing record leans toward: `swarm-hls-srs-fragment-rule` records that a GOP
**equal** to the fragment doubles the segment. That observation was made once, in passing, on a
different instrument. It is a hypothesis here, not a premise.

## H1: the GOP, not `hls_fragment`, sets our segment length

**Claim.** At the shipped pair the median segment is **2.0s and not 0.25s**, so `HLS_FRAGMENT` is not
the knob that controls segment length in the configuration we ship.

**Falsifier.** A median at or near 0.25s on the shipped pair. That would mean the fragment does bind
and the GOP is free, and H1 is dead.

## H2: the crossover is real and sits at GOP = fragment

**Claim.** Holding the fragment at 1.0 and walking the GOP 0.5, 1.0, 2.0, the median tracks the
fragment while the GOP is below it and tracks the GOP above it.

**Falsifier.** A median that keeps tracking the fragment at GOP 2.0, or one that tracks the GOP at
0.5.

## H3: the stamped recipe hides all of this

**Claim.** The `bench` control on the shipped pair returns a median near the **fragment**, 0.25s,
while the paced arm on the identical pair returns 2.0s.

**Falsifier.** The stamped arm agreeing with the paced arm. That would mean the flat-out encode does
not shrink the GOP's wallclock span the way `segment-stretch-2026-08-12.md` says it must, and the
mechanism recorded there is wrong.

## What no arm here can say

⛔ This is loopback, and `swarm-hls-gate-lesson` AGX says a local reproduction of a distributed fault
is a different experiment. The paced arms should be immune, because pacing is what makes the timeline
independent of the socket, **but that is the claim under test rather than a guarantee**. A network arm
would be needed to close it.

⛔ Nothing here measures delivery, retrieval or cost. It reads `#EXTINF` out of a playlist.

⚠️ Two rounds, arm order reversed in the second, so a single reading never carries a row on its own.
