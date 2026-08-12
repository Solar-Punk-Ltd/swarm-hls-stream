# #155 halved what a stall costs a viewer, and #87 does not need a rebuild after all

**2026-08-12, free.** Two reads of `hls.js@1.6.15`'s own source against our uploader's arithmetic. No
broadcast, no browser, no BZZ. Both answers were a grep, and both change #87 before it is booked.

## ⭐ A stall costs less than it used to, because the cap is our segment length

hls.js computes the position a live viewer sits at as:

```js
return targetLatency + Math.min(this.stallCount * this.config.liveSyncOnStallIncrease, maxLiveSyncOnStallIncrease);
//                                                                                     ^ = levelDetails.targetduration
```

`liveSyncOnStallIncrease` defaults to **1** and we do not override it, so each stall adds one second
**and the total is capped at one target duration.** The uploader sets that cap itself:
`targetDuration = Math.ceil(duration)` over the longest segment it has seen
(`ManifestManager.addSegment`), and it only ever rises.

Taking the longest segment actually produced, measured today in
[`shipped-fragment-validation`](shipped-fragment-validation-2026-08-12.md):

| segment | longest `#EXTINF` | `#EXT-X-TARGETDURATION` | worst a stall can cost |
| ---: | ---: | ---: | ---: |
| **0.5s** | 0.636 | **1** | **1.0s** |
| 1.0s | 1.136 | 2 | 2.0s |
| 2.0s | 2.133 | 3 | 3.0s |

⭐⭐ **So #155 halved it, 2.0s to 1.0s**, and at the profile we now ship **one stall reaches the cap
immediately and a second costs nothing more.** That is the opposite direction from
[the growth cost](manifest-growth-2026-08-12.md) the same change carried, and it is the larger of the
two effects on what a viewer feels.

⛔ **This only works out because the overshoot was measured.** `Math.ceil` is decided by the longest
segment, not the settled one, and the settled values would have given `ceil(0.5) = 1` and
`ceil(1.0) = 1`, making the two profiles look identical. The 1.0s row is 2 solely because its
segments peak at 1.136. **A median would have got this backwards.**

⚠️ Scoped to what is measured: the cap is arithmetic read off two sources, not an observed stall.
`one-stall-costs-a-second-2026-08-07.md` observed the effect at a 1.0s segment and agrees with the
2.0s row via a different route. **Nothing here has watched a stall at 0.5s.**

## ⭐⭐ #87 needs one build and one broadcast, not one build per arm

`LIVE_SYNC_DURATION_S` is a compile-time constant, so sweeping it looked like it needed the client
rebuilt and redeployed for every arm. It does not. hls.js exposes a setter:

```js
set targetLatency(latency) {
  this.stallCount = 0;
  this.config.liveSyncDuration = latency;
  this._targetLatencyUpdated = true;
}
```

and the matching getter re-reads `this.config.liveSyncDuration` on **every** access. The branch that
does so is gated on `this._targetLatencyUpdated || userConfig.liveSyncDuration || ...`, and we pass
`liveSyncDuration` in the user config, so it is taken from the first mount onward.

⭐⭐⭐ **`hls.targetLatency = X` is therefore a complete arm change**, and it does the one other thing
an arm boundary needs: **`stallCount = 0`**. Without that, a stall in arm N would follow the viewer
into arm N+1, because the penalty is carried on the instance rather than recomputed.

So the sitting is **one client build, one continuous broadcast, arms set between stretches**, instead
of a rebuild and redeploy per arm. That removes the redeploy from the measurement as well as from the
cost, which matters because a redeploy restarts cold and
[a cold gateway is expensive for its first minutes](a-cold-gateway-needs-a-minute-2026-08-08.md).

⛔ **Set `liveMaxLatencyDuration` in the same step and keep it at twice the target.** hls.js validates
`liveMaxLatencyDuration > liveSyncDuration` at construction only, so a runtime cut to the target alone
will not throw, it will silently leave the ratio at 4x. `playerConfig.ts` records why 2x is the value:
above it the catch-up range and the seek range stop meeting, which stranded a viewer between 22 and
30 seconds of latency at 3x and 5x.

## What this changes about #87

The task called it the riskiest change on the board, on the grounds that a stall is permanent. It is
permanent, but it is **bounded at one second at the shipping profile**, which is a quarter of the
6 seconds under test. That is still worth measuring and no longer worth being frightened of.

It also gets cheaper: no per-arm redeploy, so a sitting is one broadcast long enough to hold every arm
plus the warm-up ones to discard.
