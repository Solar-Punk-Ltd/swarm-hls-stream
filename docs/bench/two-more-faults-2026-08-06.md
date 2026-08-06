# Two faults a viewer had never been watched through

**2026-08-06.** `pnpm browser:crash` with `writer-bee-pause` and `writer-bee-outage`, 0.25s GOP,
against `latbench-bee-uploader-1`, which is the node the **uploader writes through** rather than the
one a viewer reads from. Both faults already have upload-side scenarios that pass.

| | pause, 8s | outage, 20s |
| --- | ---: | ---: |
| froze | **3.1s** | **54.9s** |
| moved again, after the node was ready | 2.0s | **37.9s** |
| the node's own startup | 0.0s | 3.6s |
| rebuffers | 2 | 7 |
| media per wall second, whole run | 0.994 | 0.994 |
| recovered | ✅ | ✅ |
| the client said | *nothing* | "Waiting for the broadcast to continue" |

## ⛔ The short pause was predicted to be invisible and it was not

`writer-bee-pause` is the only scenario here that declares `expectFreeze: false`, and it failed,
which is the whole reason to write a prediction down. `suites/scenarios/bee-outage-short.test.ts`
establishes that an outage shorter than the uploader's fifteen second retry window loses nothing:
indices stay gapless and no discontinuity is armed. That is true and it is not enough.

**Eight seconds of outage against about five seconds of buffer left three seconds of frozen picture**,
which is `freeze = outage − buffer` to a tenth of a second, the same identity the crash runs closed
on. The viewer also took two rebuffers and was told nothing, because nothing was wrong: the gateway
answered throughout and the feed was still advancing whenever it was asked.

⭐ **The uploader's threshold and the viewer's are different numbers and nothing connected them
before.** Lossless up to `SEGMENT_RETRY_WINDOW`, fifteen seconds. Invisible only up to
`LIVE_SYNC_DURATION_S`, six. Every write outage between those two is a fault the upload side calls
clean and a viewer sees.

## ✅ A viewer survives a discontinuity, which had never been played

`writer-bee-outage` runs the node down for twenty seconds, past the retry window, so the segment in
flight is dropped and the uploader arms `#EXT-X-DISCONTINUITY`.
`suites/scenarios/bee-outage-long.test.ts` proves it arms one and stops there. Whether hls.js then
recovers the timeline, or stalls on a break it was told about, was open.

**It recovers.** Playback resumed with no reload, the broadcast did not end, and the run finished at
0.994 media seconds per wall second. The cost is seven rebuffers and a slow return.

The client said **"Waiting for the broadcast to continue"** throughout, which is the correct message
and the correct state: `stalled` rather than `reconnecting`, because the gateway was answering
perfectly and the feed simply was not advancing. The two are told apart by a viewer-side signal that
has now been right in every scenario it has met.

## ⚠️ 37.9 seconds to resume, and none of it is the client's

Measured from the bee node reporting ready, not from `docker start` returning, so the node's own 3.6s
of startup is already excluded.

Nothing is written while the writer's node is down, so there is no hole for the probe added in #71 to
step past: the reader is correctly waiting for a slot that does not exist. **0.8a is inert here and
that is right.** What the 37.9s covers is the uploader flushing what it buffered, giving up on the
segment it could not place, arming the discontinuity and resuming publication. That is the same
family as #86, and it is server-side.

## What this does not say

**One run each.** Neither has been repeated, and the pause figure in particular is a difference of two
numbers of similar size, so a viewer sitting further forward in their buffer would see less of it.

The pause window was chosen at eight seconds to sit under the retry window. **Nothing here locates the
threshold at which a write outage starts reaching a viewer**, only that eight seconds is past it and
that the buffer is what decides.

## ✅ Decision on the gap: accept it (2026-08-06)

The gap is between what the two sides call success. The uploader retries a manifest publish for
**15 seconds** and calls anything it recovers within that window lossless, correctly, because no
media is lost. A viewer holds **6 seconds** of buffer, so anything past six is visible to them. A
write outage between those two numbers is clean upstream and a freeze downstream, and nothing said
so.

Three ways out were considered and the decision is to **accept**.

**Raising `LIVE_SYNC_DURATION_S` is rejected.** It buys tolerance at exactly one second of latency per
second of tolerance, against a standing goal of stable, constant latency at the best quality
available. Covering the full 15-second window would put every viewer 15 seconds behind live,
permanently, to hide a fault that lasted eight seconds once.

**Shortening the uploader's retry window is rejected, and it is the worse of the two.** It would trade
a viewer's freeze for permanently lost media. A three-second freeze recovers. A segment no manifest
ever names does not, and #81 exists because that is the quietest way this uploader can lose part of a
broadcast.

**Accepted, because the measured cost is small and the buffer is already doing its job.** Eight
seconds of write outage cost a viewer **3.1 seconds** of frozen picture. The buffer absorbed the rest,
which is what it is for, and the identity holds:
`freeze = (outage − buffer absorbed) + client-side overhead`.

⚠️ **Deliberately not shown on screen.** `FeedStateOverlay` declares a stalled feed after 30 unserved
polls, far longer than this, and a banner that appears and disappears inside three seconds would be
more disruptive than the freeze it announces.

**Reversible in one constant** if a deployment would rather buy the tolerance:
`LIVE_SYNC_DURATION_S` in `packages/client/src/components/SwarmHlsPlayer/playerConfig.ts`.

⚠️ **What would reopen this:** a measurement showing write outages in the 6-15 second band are common
rather than rare on this deployment. Nothing has counted how often one happens.
