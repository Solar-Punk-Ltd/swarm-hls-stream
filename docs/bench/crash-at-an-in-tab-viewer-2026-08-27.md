# Crashes under a viewer whose segments come from inside the tab

**2026-08-27, 15:51 to 16:12 UTC.** The first crash-recovery readings ever taken with the byte
source this product ships. Every earlier crash reading in this repository is a gateway reading,
whatever its sitting was called, because two of the three viewer drivers never read
`BROWSER_FETCH_BACKEND` at all (fixed 2026-08-27, see `e2e/src/browser/byteSourceArm.ts`).

Six arms, one broadcast per fault, shipped profile throughout (0.5s GOP, 720p, 2500 kbps), driven by
`deploy/scripts/crash-arms.sh` on the deployment host: afford, postage-capacity and owner-ceiling
gates in front of every arm, metric snapshots either side of each, and an arm that does not name its
byte source refuses to run. Chrome 151 headed against Xvfb, instrument sound on every counted
sample.

**The whole sitting cost 0.319 BZZ against a 0.995 BZZ gate projection** (uploader 0.265, gateway
0.054, read from the sitting's own metrics bracket and matching the ledger arithmetic to the fourth
decimal).

## The paired headline: a gateway outage costs an in-tab viewer the same freeze

The gateway was stopped for 20.5s under two viewers in the same sitting, same broadcast profile,
minutes apart. One read segment bytes from the weeb-3 node in its tab, the control read everything
from the gateway.

| | in-tab bytes (weeb3) | gateway control |
| --- | ---: | ---: |
| buffer lasted after the fault | 6.0s | 6.1s |
| longest freeze | **28.6s** | **27.6s** |
| moved again, after the service answered | 10.7s | 9.9s |
| rebuffers | 5 | 5 |
| whole-session advance ratio | 0.782 | 0.791 |
| behind live, before → after | 6.03 → 6.05s | 6.03 → 7.04s |
| segment requests over HTTP | **8** | **366** |

The last row is the proof the arms differed: the in-tab arm moved roughly 240 segments through the
node in the tab and only its seeded prefix over HTTP, while the control fetched every segment from
the gateway. The arm session reported `requested=weeb3, reported=weeb3`, settled 60.0s, and the
driver's bytes-came-from-it proof passed.

**The in-tab node neither shields a viewer from a gateway outage nor costs anything when one hits.**
It cannot shield, because the hybrid still reads the feed and manifests through the gateway, so when
the gateway dies the viewer stops learning what the next segment is, and bytes it could fetch
in-tab have no names. The freeze is feed-driven, not byte-driven. And there is no penalty either:
freeze, recovery and rebuffer counts match the control inside a second, so nothing about the in-tab
path makes a crash worse. Fully decoupling availability from the gateway needs the feed itself to
move in-tab, which is the gateway-less native path and its separate line of work.

The behind-live column is left uninterpreted: hls.js ratchets its latency target up on stalls and
never lowers it, both arms stalled five times, and one run of each cannot say whether the 1s
difference in where they settled is real.

## Every arm

| # | fault | byte source | freeze | recovered after service answered | the client said, while frozen |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | gateway stopped 20.5s | weeb3 | 28.6s | 10.7s | "Reconnecting to the stream" |
| 2 | gateway stopped 20.5s | gateway | 27.6s | 9.9s | "Reconnecting to the stream" |
| 3 | uploader killed 15.4s | weeb3 | 13.5s | 2.3s | **nothing** |
| 4 | writer bee paused 8s | weeb3 | 3.1s | 2.0s | nothing, and 3.1s is under the overlay's horizon |
| 5 | writer bee stopped 20s | weeb3 | 29.5s | 12.5s | **nothing** |
| 6 | engine restarted 30s | weeb3 | 83.2s | correctly never | "Waiting for the broadcast to continue", then **"This broadcast has ended"** |

Every weeb3 arm carried the same proof surface: 8 to 9 segment requests over HTTP for the whole
run, arm session `requested=weeb3, reported=weeb3`, driver proof passed, exit 0.

## What arms 4 to 6 add

- **The pause identity is exact across byte sources.** An 8s writer-bee pause froze the in-tab
  viewer **3.1s** and playback moved 2.0s after the unpause, the same 3.1s and 2.0s the gateway
  corpus measured on 2026-08-06. Outage minus buffer, to the decimal, in both worlds.
- **The 20s writer-bee outage read far better than its 2026-08-06 corpus run** (29.5s frozen, 12.5s
  to resume, 2 rebuffers, against 54.9s, 37.9s and 7 then), but that corpus run predates the loop
  fix and the probe ladder, so this is the client having improved across eras, not the byte source.
  No within-sitting control ran for this fault. ⚠️ The overlay said nothing for all 29.5s, the same
  silence as arm 3 and the same #100 mechanism.
- **The engine restart is correctly terminal, and for the first time a viewer was watching when the
  orphan reap spoke.** SRS takes the SRT session with it, so the broadcast genuinely ends: the
  viewer froze 83.2s, the overlay escalated from "Waiting for the broadcast to continue" to **"This
  broadcast has ended"**, which is #86's sixty-second reap finalizing the stream and reaching the
  screen. The corpus run of this fault (84.3s, never recovers) could only infer that ending.

## What arms 1 to 3 say beyond the headline

- **The uploader-crash recovery fix holds under an in-tab viewer.** Killed uploader, 13.5s freeze,
  playback moved again **2.3s** after the service answered. The corpus figure the 0.8a probe ladder
  was verified at is 4.1s on a gateway viewer, against 46.7s before the fix. Nothing about reading
  bytes from the tab breaks the ladder.
- **The overlay's silence during an uploader crash reproduces exactly.** Arm 3 froze 13.5s and
  `FeedStateOverlay` said nothing, the same behaviour #100 traced to `UNSERVED_SLOT_POLL_LIMIT`
  counting polls whose rate collapses during the stall it exists to detect. It is a threshold-unit
  defect, not a byte-source one, and the in-tab reading removes the last excuse to think otherwise.
- **The freeze identity survives the byte-source change.** In all three arms the picture kept moving
  for almost exactly `LIVE_SYNC_DURATION_S` worth of buffer (6.0, 6.1, 7.1s) after the fault landed,
  then froze until service plus client recovery. Freeze = outage − buffer + ours, still.

## What this does not say

- **n=1 per arm.** The paired gateway-outage arms agree with each other and with the corpus
  (27.6/28.6s here against 30.6s on 2026-08-05), which is consistency, not a distribution.
- **The weeb3 arm is the shipped hybrid, not gateway-less.** Segment bytes in-tab, feed and
  manifests via the gateway. A gateway-less viewer's crash behaviour is a different measurement on a
  different page.
- **The viewer ran on the deployment host**, loopback to the gateway, so operator-uplink effects are
  out of frame on purpose.

## Method

Sitting wrapper `deploy/scripts/crash-arms.sh` (tests in `deploy/test/crashArms.test.js`), sized at
6 arms x 7 min; the ledger authorised 3 BZZ on 2026-08-27 and the projection printed before the
first publish. Raw per-arm artifacts (`browser-crash-<scenario>-<runId>.{md,json,requests.json}`)
are untracked by convention; this document is the committed record.
