# Taking the ceiling off the byte-source comparison

**2026-08-13, overnight.** Two live broadcasts, eight arms each, counterbalanced, both conditions held
at a **2s** target and then at **1.5s**, instead of the build's 6s. 1.6390 BZZ against a 2.4 BZZ
authorisation.

⭐⭐⭐ **The headline is that the latency column cannot rank these two conditions at any target that
works.** At 6s and at 2s both conditions sit exactly on the configured target. At 1.5s the target
mechanism breaks in both, because hls.js's stall penalty drives every arm's effective target to 2.5s.
What survives all three sittings is the economics and the absence of stalls.

## Why this sitting exists

`weeb3-live-arms-2026-08-13.md` answered whether a Swarm node in the viewer's tab holds a live edge,
and it does. What it could **not** do was rank the in-tab node against a gateway on latency:

> `LIVE_SYNC_DURATION_S` is 6. All three weeb-3 arms read exactly 6.03s, and so do two of three
> gateway arms. That is not a measured tie, it is both conditions sitting on one configured target.

A reading at a cap says both conditions reached the cap. It says nothing about which of them could
have gone lower, and the whole economic case for an in-tab node would be undermined if it turned out
to cost latency that the 6s target was hiding.

So these sittings change exactly one thing: **the target**. Everything else is the design that PR #186
already validated. Sitting 1 runs at 2s. Sitting 2 went to 1.5s rather than repeating 2s, because by
then the 2s arms had shown the same pinning and a repeat would only have re-confirmed it.

## What was run

One publisher for the whole sitting, so both conditions read the same content from the same encoder
over the same window into the same network. 1280x720 at 2500 kbps, 0.5s GOP, the shipping profile.

Order `gateway weeb3 gateway weeb3 weeb3 gateway weeb3 gateway`, position-balanced and paying one
seam. Round 1 is warm-up and is discarded, leaving **n=3 per condition** of four minutes each.

⭐ **The target is applied identically to both conditions**, so it is a constant of the sitting rather
than a second treatment. Each arm's report carries the value requested beside what the player
reported, because an arm whose target did not take is an arm of a different condition.

⛔ It is applied **twice**: once before the settle, so the catch-up from 6s to 2s happens while
nothing is being counted, and once as the measured window opens, because the setter is what clears
hls.js's `stallCount`. Without that second call, a stall while the in-tab node was booting would
raise the arm's target for its whole life and never lower it.

## How to read the columns

⭐⭐⭐ **`advance` first, latency second.** `advance` is video seconds played per wallclock second over
the window. It cannot sit at a configured cap, which is exactly the failure that made the 6s sitting
unable to rank anything. A latency column is only worth reading once you know the player was not
pinned to the number you configured.

## Preconditions, so the numbers can be defended

- The spend was authorised at **2.4 BZZ** and the driver refuses past it rather than warning after.
  `spend-ceiling.sh` logged `2.400 authorised, 0.004 already spent, 1.422 projected` before sitting 1
  and `2.400 authorised, 0.810 already spent, 1.422 projected` before sitting 2, so it genuinely
  carried the first sitting's cost into the second's decision. **Whole night: 1.6390 BZZ.**
- Gateway warm and funded throughout: **134 peers at the start and at the end**, no bee container
  restarted at any point in either sitting.
- Postage `7849851f`, depth 25, **274 → 285 of 512 buckets**, TTL 244.6h at the end.
- **Host load 3.90 to 15.00** across sitting 1 and **2.95 to 21.27** across sitting 2, on 48 cores.
  The box carries some forty other bee nodes plus other tenants' stacks. See the note on sitting 2's
  load below.
- The free checks ran before either sitting published: `browser:selfcheck` SOUND, and
  `browser:fetch-backend-check` moved the switch both ways, refused an unknown byte source, and
  **booted a real in-tab node in 959ms**.
- Every weeb-3 arm was required to have fetched the weeb-3 wasm **and** made zero in-window `/bytes/`
  requests. A zero without the wasm is a backend that never loaded, and it is the more attractive of
  the two readings.

## What a viewer got, at a 2s target

All eight arms passed every gate. n=3 per condition after the warm-up round.

| | gateway | weeb-3 |
| --- | --- | --- |
| behind live | 2.15 / 2.03 / 2.03 | 2.03 / 2.03 / 2.06 |
| **advance** | 0.9995 / 0.9999 / 1.0000 | 1.0030 / 1.0001 / 1.0016 |
| rebuffers | 2 / 1 / 1 | 2 / 1 / 3 |
| **stalls** | **0 / 0 / 0** | **0 / 0 / 0** |
| buffer ahead | 1.57 / 1.39 / 1.24s | 1.54 / 1.31 / 1.64s |

### ⛔⛔⛔ The latency column is censored AGAIN, one level down

Every counted arm reads **2.03 to 2.15s against a 2.00s target**. Both conditions are sitting on the
new cap exactly as they sat on the old one. **Cutting the target from 6s to 2s did not rank the two
conditions, it moved the point at which they are both pinned.**

⭐ What it does establish, and this is worth having: **the in-tab node follows the gateway all the way
down to 2s.** Whatever target you set in this range, both byte sources reach it. There is no latency
penalty for reading video out of the tab, anywhere down to 2s.

⭐ The uncensored column agrees. `advance` is 0.9995 to 1.0030 across all six arms, so real time was
held in every one, and **stalls are zero in every arm of both conditions**. Rebuffers are 4 total for
the gateway against 6 for weeb-3, on ranges that overlap (1-2 against 1-3).

⚠️ The one consistent sign: all three weeb-3 arms have `advance` **above** 1.0 and all three gateway
arms at or below it. The magnitudes are 0.01% to 0.3%, this is n=3, and nothing should be built on it.

### The cost of the tighter target, paid by both

Buffer ahead falls from about **5.0s at the 6s target to about 1.4s at 2s**, which is the target doing
what it is for. A single small rebuffer appears where the 6s sitting had none, in **both** conditions,
and no stall follows it in any arm.

## Where the bytes came from, and what that cost

Read off the gateway's own `/metrics` and its chequebook either side of every arm, independent of
anything the browser reported.

| arm | source | gateway retrievals | gateway spend |
| --- | --- | ---: | ---: |
| 3 | gateway | 28,845 | 0.05442 BZZ |
| 4 | weeb3 | 1,449 | 0.00073 BZZ |
| 5 | weeb3 | 1,316 | 0.00064 BZZ |
| 6 | gateway | 28,877 | 0.05346 BZZ |
| 7 | weeb3 | 1,514 | 0.00074 BZZ |
| 8 | gateway | 29,069 | 0.04981 BZZ |

⭐⭐⭐ **20.3x fewer retrievals and 75x less gateway spend, with no overlap on either counter.** The
warm-up arms sit inside the same two bands.

**This replicates 2026-08-13's sitting on a second broadcast at a different target**, which is worth
more than any caveat attached to the first. That sitting measured 24.4x and 143x at a 6s target.

⚠️ **The spend ratio is smaller tonight, and the reason is interesting.**

> ### ⛔⛔ CORRECTED 2026-08-15: EVERY RATE HERE DIVIDED BY THE WRONG WINDOW
>
> The numerators are chequebook deltas taken from the `on-gateway-before` and `on-gateway-after`
> snapshots. **Those brackets span 320s, not the 240s of counted playback**, because they open before
> the arm starts and close after it ends. Dividing a 320s delta by 4 minutes charges the setup and
> teardown spend to the playback minutes and inflates every figure by **1.34x**.
>
> ⛔ **And the two sittings inflate by different factors**, 1.34x here against 1.23x at the 6s target,
> whose arms are 6 minutes against a 441s bracket. **So the cross-sitting ratio is distorted, not
> merely shifted**, which is the part that cannot be fixed by reading the numbers as relative.

| | as published | on matched windows |
| --- | ---: | ---: |
| gateway, this sitting | 0.01314 BZZ/min | **0.00984** |
| gateway, the 6s sitting | 0.01338 | **0.01029** |
| weeb-3, this sitting | 0.000175 | **0.000131** |
| weeb-3, the 6s sitting | 0.0000933 | **0.0000810** |
| **the in-tab excess at a tighter target** | **1.9x** | **1.62x** |

✅ **Both conclusions survive.** The gateway rate is still the same number across the two sittings, now
0.00984 against 0.01029, a 4.6% difference. The in-tab node still costs more the closer to the edge it
runs, now **1.62x rather than 1.9x**, and is still about 75x below a gateway. What remains in a weeb-3
arm is feed and manifest polling, and that tightens as the target does.

⚠️ **One number does not reproduce even by the original method.** Recomputing the 6s sitting's weeb-3
rate the way the doc did, dividing by 6 minutes, gives 0.0000991 against the published 0.0000933. The
matched-window figure above is the one to quote.

### ⚠️ The failure-rate column is a composition effect, not a quality difference

The gateway's own retrieval failure rate reads **4.96 to 5.24%** during gateway arms and **20.41 to
26.67%** during weeb-3 arms. That is not the in-tab node making the gateway fail more.

During a gateway arm the gateway's retrievals are dominated by segment chunks, which mostly succeed.
During a weeb-3 arm almost the only traffic left is feed-head lookups, and roughly 45% of those are
legitimately not-founds by design. The rate rises because the denominator changed composition, not
because anything got worse. **The two rates are measuring different mixes and must not be tabled as if
they were the same quantity.**

## Sitting 2: going to 1.5s, where a gateway is known to strain

Because both conditions were pinned at 2s, a repeat at 2s would only re-confirm the pinning. Task #87
had already found 1.5s worse than 2.0s on achieved latency for a gateway, so 1.5s is the target where
degradation is known to exist and the two can in principle be ranked. Same design, same broadcast
shape, n=3 per condition, all eight arms passed every gate.

### ⛔⛔⛔ 1.5s is below what this profile holds, in BOTH conditions

hls.js adds `min(stallCount * liveSyncOnStallIncrease, targetduration)` to the configured target and
**never lowers it**. Sampling `liveTargetLatencyS` alongside `liveLatencyS` shows what that did:

**Every arm of both conditions reached an effective target of 2.5s**, against the 1.5s configured.
The stall penalty was active everywhere.

So 1.5s does not rank the conditions either. **It breaks the target mechanism in both of them**, which
is a real result and a mechanism for #87's finding rather than a repeat of it. ⭐ **2.0s remains the
operating point**, now for a reason rather than by comparison.

### What separates them is the gap, not the raw latency

| | gateway | weeb-3 |
| --- | --- | --- |
| behind live | 2.26 / 1.53 / 2.52 | 1.79 / 1.81 / 1.82 |
| **gap to its own steering target** | +0.02 / −0.16 / +0.03 | **−0.74 / −0.71 / −0.69** |
| rebuffers | 3 / 2 / 4 | 3 / 5 / 4 |
| **stalls** | **0 / 0 / 0** | **0 / 0 / 0** |
| advance | 0.9966 / 0.9992 / 0.9964 | 1.0016 / 1.0013 / 1.0008 |

⭐ **The gateway arms sit on whatever target they have drifted to. The weeb-3 arms sit about 0.7s
below theirs.** A negative gap is the player closer to live than its own steering required, which for
a live stream is the better side to be on. And weeb-3's achieved latency is far more consistent:
a spread of **0.03s** across three arms against the gateway's **0.99s**.

⚠️ **Treat this as an observation with a mechanism, not a headline.** n=3, one sitting, and the target
drifted differently between arms, so this is not a clean equal-target comparison. What it is not is a
latency penalty for the in-tab node, which is what the sitting was booked to look for.

⭐ The sign that repeats: **`advance` is above 1.0 in all six counted weeb-3 arms across both sittings**
and at or below 1.0 in five of six gateway arms. Magnitudes are 0.04% to 0.3%.

### The economics, replicated a third time

| arm | source | gateway retrievals | gateway spend |
| --- | --- | ---: | ---: |
| 3 | gateway | 28,912 | 0.05387 BZZ |
| 4 | weeb3 | 1,340 | 0.00045 BZZ |
| 5 | weeb3 | 1,243 | 0.00042 BZZ |
| 6 | gateway | 28,916 | 0.05215 BZZ |
| 7 | weeb3 | 1,443 | 0.00068 BZZ |
| 8 | gateway | 28,978 | 0.05456 BZZ |

**21.6x fewer retrievals and 104x less gateway spend, no overlap on either counter.**

| target | retrievals | gateway spend | stalls, both conditions |
| ---: | ---: | ---: | :---: |
| 6s | 24.4x | 143x | 0 |
| 2s | 20.3x | 75x | 0 |
| 1.5s | 21.6x | 104x | 0 |

⭐⭐⭐ **Three sittings, three broadcasts, three targets, zero overlap every time.** The economic case
for an in-tab node does not depend on the latency target, and no viewer stalled in any arm of any
condition at any target.

### ⚠️ Sitting 2 ran on a noisier box

Host load per arm reached **21.27** (a discarded warm-up arm) and **12.71 and 11.81** in counted arms,
against sitting 1's 3.90 to 15.00. The box carries some forty other bee nodes and other tenants'
stacks. The counterbalanced order puts one arm of each condition in every round, which is what carries
a drifting neighbour, but a bracket controls for time and never for co-tenancy.

## ⚠️ A 404 count that was not what it looked like

The first arm's log carried **238 404s**, against zero in the whole 6s sitting, and the story wrote
itself: a 2s target puts the viewer on top of the ~100ms window in which our uploader has published a
segment's reference but not its bytes, so the smaller buffer now pays for a race the 6s buffer hid.

**That reading is wrong, and the route is what says so.** The 404s are `/soc/` feed-head lookups, not
`/bytes/`. Median 436ms, which is the announcement floor doing its ordinary job at zero BZZ.

The control was free and already on disk. Grouped by route, the 6s sitting ran `/soc/` 404 rates of
**22.45%** (gateway, n=5) and **24.53%** (weeb-3, n=5) at a 405-437ms median, against this sitting's
comparable rate at the same median. **`/bytes/` 404s are zero in both sittings.** Nothing about
segment availability changed when the target came down.
