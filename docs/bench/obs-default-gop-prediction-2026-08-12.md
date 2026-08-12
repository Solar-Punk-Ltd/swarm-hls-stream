# What a 2.0s-GOP broadcaster gets, predicted before spending

**Registered 2026-08-12, before the sitting.** Task #91. Predictions here so the result can refute
them rather than be read back as having been expected.

## Why this sitting exists when the bench already compared 0.5 against 2.0

`small-gop-wins` settled the **bench** comparison on 2026-08-11: capture-to-fetchable of 1.55s at a
0.5s GOP against 3.88s at 2.0, and confirmed feed stalls of 0-of-3 against 3-of-3. That is the
pipeline's half.

A viewer does not watch the fetchable edge. They watch what their player chose to play, which sits a
further buffer behind, and the buffer is not a constant: hls.js adds
`min(stallCount * liveSyncOnStallIncrease, targetduration)` to its target every time playback stalls,
and **never lowers it**. `targetduration` is `ceil()` of the longest segment the manifest has carried,
kept by `ManifestManager` as a running maximum that never falls.

So the two GOPs do not merely differ by their segment length. They differ by **how much a stall costs
and how permanently**, and nothing has watched that in a browser.

**2.0 is OBS's default**, so it is the uninvited case: the configuration a broadcaster arrives with
when nobody told them otherwise.

## The arithmetic being tested

Segment length is `ceil(fragment / GOP) * GOP`, and a segment overshoots its settled length by a
measured constant of about **0.135s** before ramping back.

| GOP | segment | + overshoot | `#EXT-X-TARGETDURATION` | stall penalty cap |
| ---: | ---: | ---: | ---: | ---: |
| 0.5 | 0.500s | 0.635s | **1** | **1.0s** |
| 2.0 | 2.000s | 2.135s | **3** | **3.0s** |

## Predictions

1. **`#EXT-X-TARGETDURATION` reads 1 at a 0.5s GOP and 3 at a 2.0s GOP.** The 3 is the one worth
   watching: it comes from `ceil(2.135)` rather than `ceil(2.0)`, so a reading of 2 refutes the
   overshoot at this GOP and not the ceiling rule.
2. **A 2.0s arm that stalls once ends the arm sitting about 3s further behind live than it started,
   and does not recover inside the arm.** A 0.5s arm that stalls once loses about 1s.
3. **The 2.0s arms stall more often**, following the bench's 3-of-3 against 0-of-3. ⚠️ Weakest of the
   four: the bench's stall counter and a browser's rebuffer counter are not the same instrument.
4. **Median viewer latency is worse at 2.0 by more than the 2.33s the bench measured**, because the
   player's own buffer is additive and the target is a multiple of the segment length rather than a
   constant.

## What would make the sitting void rather than negative

- Either GOP failing its axis check, since `ceil(fragment / GOP) * GOP` is what makes 2.0 reachable at
  all and the rig pins `hls_fragment` at 0.25 with an aof ratio of 10, giving a 2.5s force-close
  ceiling that a 2.135s segment fits inside with 0.365s to spare.
- `#EXT-X-TARGETDURATION` moving inside an arm, since the penalty cap ratchets and arms either side of
  that moment are measured under different ceilings.
- Zero stalls in every arm at both GOPs, which leaves predictions 2 and 3 untested rather than refuted
  and is a real possibility at 48 minutes: the shipping profile ran a sustained stretch with none.

## Design

Six arms of 8 minutes, GOP alternating 2.0 and 0.5, **the first pair discarded**, rounds 2 and 3 run
in opposite order. Each arm is its own broadcast, because unlike the player's buffer target the GOP
is a publisher setting and cannot be changed under a running stream.

⛔ Scored on stalls and on the target the player held, not on median latency alone. A median over an
arm that stalled once and recovered says the same thing as one that never stalled.

Cost about **0.72 BZZ** at the measured 0.90 BZZ per broadcast hour at 720p.
