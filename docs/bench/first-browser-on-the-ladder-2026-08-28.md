# The first browser on the ladder: the in-tab viewer watches 1080p where the gateway viewer gets 360p

**2026-08-28, 06:52 to 07:43 UTC.** No browser had ever played this project's ABR ladder. This
sitting is the first, run in-browser-node-first: a 3-minute weeb3 shakedown, then four
counterbalanced arms (gateway, weeb3, gateway, weeb3) over one 39-minute ladder broadcast, round 1
discarded as warm-up. `deploy/scripts/byte-source-arms.sh` with `ABR_ENABLED=true`, shipped
profile ingest (0.5s GOP, 720p, 2500 kbps), SRS transcoding four rungs (360p, 480p, 720p, 1080p,
all measured publishing 0.500s median segments by the stage-fingerprint gate).

**Sitting spend 1.42 BZZ, day ledger 2.34 of the authorised 3.00.** A ladder broadcast burns
~0.042 BZZ per minute, about 2.5x the single-rendition model the gates project with, so ceilings
around ladder sittings must be sized off actuals.

## The headline: same broadcast, same moment, a 3-rung quality gap by byte source

The counted pair, arms 3 and 4, six minutes each, back to back on one broadcast:

| | gateway viewer | in-tab viewer (weeb3) |
| --- | ---: | ---: |
| time at 640×360 | **94%** (334/355 samples) | 0 |
| time at 1280×720 | 0 | 12% |
| time at 1920×1080 | 0 | **88%** (311/355 samples) |
| rebuffers | 64 | 121 |
| whole-session advance ratio | 0.548 | 0.665 |
| median behind live | 1.25s | 1.37s |
| median buffered ahead | 0.56s | 0.54s |
| segment requests over HTTP | 500 | **6** |
| page main thread, mean / peak | (not sampled for round 1 twin) | 0.271 / 0.637 |

The warm-up round agrees directionally: its gateway arm sat at 360p throughout, its weeb3 arm
visited all four rungs on its way up.

**The mechanism is hls.js's bandwidth estimator, fed by each path's own timings.** The gateway path
times real HTTP transfers through a bee node and stays conservative, parking the viewer on the
bottom rung. The in-tab path's retrievals report fast, the estimator trusts them, and the viewer
rides the top rung. The estimator's optimism is also not free: at this sitting's buffer the 1080p
segments rebuffered about twice as often as the gateway arm's 360p ones.

⭐ For the production topology decision this is the sharpest fact yet: **the in-tab node does not
just cut gateway load by orders of magnitude (6 HTTP segment requests against 500 here), it moves
the viewer three rungs up the ladder on the same infrastructure.**

## The honest frame around the rebuffer numbers

Both arms rebuffered heavily (64 and 121 in six minutes) on **half a second of buffer**: the
wrapper pins every arm at a 2s live-latency target for cross-sitting comparability, hls.js's stall
ratchet lifted it to 3s early in both arms, and at 0.5s segments that realized as ~0.55s of media
ahead of the playhead. The same wrapper at the same pin ran single-rendition arms with zero stalls
on 2026-08-16, so **the ladder itself costs real stability at tight latency targets**, in both byte
sources.

⛔ **None of this measures the shipped default.** Production ships `LIVE_SYNC_DURATION_S = 6`,
three windows deeper than this sitting's pin. Whether the ladder rebuffers at the shipped default
is exactly the buffer-sweep question, now to be answered on the ladder deploy, and this sitting's
numbers must not be quoted as the shipped experience.

⚠️ n=1 counted arm per byte source. The warm-up round's directional agreement is consistency, not a
replicate.

## What it took to get here, because both defects will be looked for again

- **The deployed client was fifteen days stale** (image built 2026-08-13, before any ladder client
  code) and every sitting in between had measured it unnoticed, because nothing gates a sitting
  against the served bundle's build. The first ladder arm failed with three
  `networkError manifestLoadError`, the exact served master replays clean through today's
  `fetchSource` (`packages/client/test/ladderMasterFetch.test.ts` pins that), and a paid gateway
  control confirmed byte-source independence before the client was rebuilt in place with the
  documented no-downtime procedure, 134 gateway peers kept. Gate lesson AJV.
- **The stage-fingerprint gate called a warming ladder dead**: 8 seconds after publish start it
  found 3 of 4 rung playlists and issued a verdict instead of not-ready. Rungs come up seconds
  apart, so fewer-than-asked at first read is now `EXIT_NOT_READY` and the caller's retry deadline
  is what convicts a rung that never publishes (`a6549a4`, both test tiers rewritten).

## Method

Wrapper `byte-source-arms.sh`, one live broadcast for all arms, arm order counterbalanced by
`browser:byte-source-order`, every weeb3 arm carrying its arm-session proof
(`requested=weeb3, reported=weeb3`, wasm witness in the request log, single-digit HTTP segment
requests). Raw artifacts `browser-watch-2026-08-28T07-*` beside this document, untracked by
convention. The stale-client shakedown arms live under `browser-watch-2026-08-28T06-*`.
