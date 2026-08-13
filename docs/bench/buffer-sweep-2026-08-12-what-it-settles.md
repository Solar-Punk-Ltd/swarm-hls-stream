# The buffer sweep of 2026-08-12 13:11, and what its stall counts can and cannot settle

**17 arms of 300s, 15 counted, 1.140 BZZ.** Task #87's re-gather. The artifacts sat untracked for a
day, which is 1.140 BZZ of paid data that a lost working tree would have destroyed.

## Stalls per arm, by requested buffer target

| target | arm 1 | arm 2 | arm 3 | total |
| ---: | ---: | ---: | ---: | ---: |
| 6s | 0 | 1 | 0 | **1** |
| 4s | 0 | 0 | 0 | 0 |
| 3s | 0 | 0 | 0 | 0 |
| 2s | 0 | 0 | 1 | **1** |
| 1.5s | 1 | 0 | 1 | **2** |

⭐ **Cutting 6s to 2s did not raise the stall count here**, which is the direction #87 already reported
and is the opposite of the worry that the buffer is a cushion whose removal costs a permanent second.

⛔⛔ **But this cannot settle it, and the reason is the same one the interleaved arms made concrete.**
Counts of 0 to 2 over three arms cannot separate a rate of 0.3 per arm from 0.6. The six-hour soaks
caught **one stall in six hours**, so a 300s arm is two orders of magnitude short of the exposure the
question needs. A table that reads 1 against 1 is not evidence of equality.

⚠️ **`#EXT-X-TARGETDURATION` was 1s throughout**, so the ratchet was capped at +1s in every arm here.
At the 2.0s GOP it caps at +2s, which is where the permanent cost is largest and where this sitting
says nothing.

⛔ **No node metrics.** This ran before the sampler existed, so there is no account of what either bee
node did during it. Anything read from it is viewer-side only.

## What would settle it

Force the stalls rather than wait for them: matched degradation applied per arm through CDP network
emulation, comparing how much protection 6s buys over 2s. That measures the mechanism rather than the
field rate, and its first phase is free on recorded content. See the roadmap in
`docs/reviews/comparing-a-gateway-viewer-with-an-in-browser-one.md` for the shape of a sitting that
holds one broadcast and switches the arm on the live player.
