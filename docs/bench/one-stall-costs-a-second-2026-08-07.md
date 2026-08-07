# One stall costs a viewer a second, for the rest of the broadcast

**2026-08-07.** `the-same-test-at-1080p-2026-08-07.md` reported that the 1080p ABA's two control
arms came back **0.92s apart** against an 0.85s effect, voided the latency comparison, and said the
cause was "**not established**", listing ambient host load and postage fullness as candidates.

⭐ **It is established now, and it is neither of those.** It is a permanent per-session latency
penalty inside hls.js, triggered by a single non-fatal stall, that **every instrument in this project
was blind to**. It was found by replay, on the three run files already on disk, and it cost nothing
to find.

## The mechanism, read out of the library rather than recalled

`node_modules/hls.js@1.6.15/dist/hls.js`, `LatencyController`:

```js
var maxLiveSyncOnStallIncrease = targetduration;
return targetLatency + Math.min(this.stallCount * this.config.liveSyncOnStallIncrease, maxLiveSyncOnStallIncrease);
```

`liveSyncOnStallIncrease` defaults to **1** and this client does not set it. `stallCount++` happens
on an `ERROR` whose details are `BUFFER_STALLED_ERROR`, and it falls back to zero in exactly two
places: `onManifestLoading`, and the `targetLatency` setter.

So **one stall raises the viewer's latency target by up to one target duration, permanently.**
Nothing lowers it while the session lasts.

The catch-up that exists to pull latency back down is measured against that same moved target:

```js
var distanceFromTarget = latency - targetLatency;
if (inLiveRange && distanceFromTarget > 0.05 && this.forwardBufferLength > 1) {
  var rate = Math.round(2 / (1 + Math.exp(-0.75 * distanceFromTarget - this.edgeStalled)) * 20) / 20;
  ...
}
```

A viewer sitting 0.8s behind a **raised** target is 0.2s *ahead* of it, so the catch-up never fires
and they stay there.

## The proof, by inverting that curve against the archived arms

The rate is a deterministic function of `distanceFromTarget`, rounded to the nearest 0.05 and clamped
to `[1, 1.1]`. So an observed `playbackRate` inverts to a band for the target the player was using.
`rate 1.05` means `distanceFromTarget` was in `[0.0667, 0.2004)`.

| | samples at rate 1.05 | their median latency | **implied target** | where the arm rested |
| --- | ---: | ---: | ---: | ---: |
| arm 1, 0.25s | 63 | 6.10s | **~6.0s** | 5.89s |
| arm 2, 1.00s | 7 | 6.12s | **~6.0s** | 5.04s |
| arm 3, 0.25s | **1** | 7.05s | **~7.0s** | 6.81s |

**Arm 3 ran 1185 of its 1187 samples at `playbackRate` exactly 1.0 with a median latency of 6.81s.**
That is only possible if its target was at or above 7.01s. `LIVE_SYNC_DURATION_S` is 6 and
`userConfig.liveSyncDuration` is set, so the playlist's `holdBack` cannot move the target: the stall
term is the only thing in the getter that can.

⭐ **The 0.92s "drift between the arms" is that one second.** The sitting never drifted. Two arms of
the same configuration were measuring against two different targets.

### Where the stall came from

Arm 3's very first sample: `readyState 1`, **0.12s buffered**, zero decoded frames, latency 9.33s.
A buffer-starved join, which is what hls.js's gap controller raises `BUFFER_STALLED_ERROR` for. Arms
1 and 2 joined with 5.65s and 4.95s buffered and took no penalty.

After that first sample, arm 3 advanced at exactly 1.00 media seconds per wall second for twenty
minutes with no plateau anywhere. **There is no stall visible in the series.** It happened before the
first sample and its only trace is the number the player was steering to.

## Why nothing saw it

All three arms report **0 rebuffers, 0 stalled samples, 0 fatal errors.** None of those is wrong.

- A stall is **not fatal**, and `useHlsQoeMetrics.ts` opened with `if (!data.fatal) return`, so the
  error never reached a counter.
- A stall need not fire the media element's **`waiting`** event, which is what `rebufferCount`
  counts. hls.js detects it itself, off `detectStallWithCurrentTimeMs: 1250`.
- The advance ratio cannot see it, because the picture was never frozen. The player was playing
  perfectly. It was just playing from further back.

A fault whose every symptom lands in a gap between the signals that exist, which is the fourth of
these this project has hit.

## How often, and how much: every archived run, re-read

The same inversion runs on all **35** archived browser runs, and it needs nothing they were not
already recording. 27 of them nudged often enough to invert confidently. The rest only give a lower
bound, since a run that never nudged says only that its target was above the highest latency it
tolerated.

⭐ **The two ABAs come out exactly as the mechanism predicts, on data neither was designed to
produce:**

| | arm 1 | arm 2 | arm 3 | controls agreed to |
| --- | ---: | ---: | ---: | ---: |
| **720p ABA** | 5.94 | 6.05 | 5.97 | **0.00s** ✅ |
| **1080p ABA** | 5.98 | 6.06 | **7.01** | **0.92s** ⛔ |

Six of the 35 ran against a raised target. Among the 27 confidently inverted, three did, and the size
tracks how much the run stalled:

| run | rebuffers reported | target | raised by |
| --- | ---: | ---: | ---: |
| `2026-08-06T02-08-12` | 1 | 6.87 | +0.87s |
| `2026-08-06T06-47-38` | 3 | 7.36 | +1.36s |
| `2026-08-06T06-58-18` | **17** | 8.26 | **+2.26s** |
| `2026-08-07T05-58-55` (1080p arm 3) | **0** | 7.01 | **+1.01s** |

⭐ **That last row is the whole point.** Every run whose rebuffer counter moved shows a raise roughly
in proportion to it, which is the counter working. **The one run with a raised target and a zero
counter is the one that voided the control.** A stall that fires no `waiting` event is invisible to
every existing signal and costs exactly as much.

### ⚠️ The cap is not one second, it is up to three

`maxLiveSyncOnStallIncrease` is `targetduration`, and `ManifestManager.addSegment` computes it as

```ts
const newTarget = Math.ceil(duration);
if (newTarget > this.targetDuration) { this.targetDuration = newTarget; }
```

a running **maximum that never comes back down**. SRS force-cuts a segment at
`hls_fragment * hls_aof_ratio`, which is `0.25 * 10 = 2.5s` on this deployment, so **one long segment
sets `EXT-X-TARGETDURATION` to 3 for the rest of the broadcast** and raises the ceiling on every stall
after it. The measured +2.26s is only reachable that way, and it is a floor rather than a point
estimate: `edgeStalled` is omitted from the inversion, and omitting it biases the recovered target
**down**.

So a viewer can lose up to three seconds, and a stream that hiccups once makes every later stall more
expensive.

## What changed

**Client.** Two rows under `Live` in the QoE overlay: the target hls.js is actually steering to,
flagged when it sits above the configured value, and the stall count that moved it. The stall is
counted **above** the fatal guard rather than below it.

**Harness.** `judgeLatencyTarget` reads both off the overlay and the latency section prints the
verdict beside the figures it governs:

> ⛔ **The latency figures above are against a target that moved, and are not comparable with another
> run's.**

Judged on the **worst target the run ever saw**, not on a step between samples. The stall that voided
arm 3 happened at its join, so a check comparing samples against each other would have called that
run clean. A run that never read a target reports that it could not tell, rather than that the target
held.

## What this does and does not change

1. ⛔ **The 1080p latency comparison stays void.** Nothing here rescues it. What it does is name the
   confound, so the rerun can be gated on it instead of hoping the sitting holds still.
2. ✅ **The 720p result is untouched.** Its controls agreed to 0.00s, which on this mechanism means
   neither arm stalled.
3. ✅ **Cost and refusals are untouched.** Neither goes through the player's latency target.
4. ⚠️ **It is a viewer-facing defect, not only a measurement one.** Two viewers of the same broadcast
   can sit a second apart for an hour, decided by whether one of them happened to join buffer-starved,
   with every number either of them could see reading identically.

## The product call, which is not mine to make

Whether to defeat the penalty is a decision, not a reflex. hls.js's reasoning is sound in its own
terms: a stall at a six-second target is evidence that six seconds is too tight for this network.
What is not sound is that the evidence never expires.

- **Leave it.** A viewer who stalls once pays a second of latency for the whole broadcast. Simple,
  and it is upstream's default.
- **Reset it after a quiet period.** `hls.targetLatency = LIVE_SYNC_DURATION_S` sets `stallCount = 0`.
  Recovers the second, and risks oscillating if the network genuinely cannot hold the target.
- **Set `liveSyncOnStallIncrease` to 0.** Removes the mechanism entirely, including the part of it
  that is protecting the viewer.

⚠️ **Nothing here has measured which is better for a viewer**, and the measurement is not free: it
needs a sitting with deliberate stalls in it. Recorded as a decision, not a recommendation.

## Method note

⭐ **Replay beat re-run again, and by a wider margin than usual.** The answer was in three files
already on disk. Spending the funded 2.3 BZZ on rerunning the ABA first would have produced a fourth
arm and no explanation, and would have had roughly an even chance of drawing a stall in one arm and
voiding the control a second time.
