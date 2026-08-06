# A recording, watched for the first time

**2026-08-06.** Phase 1.2.

A recording plays. That had never been true and had never been checked, and getting there took one
product fix, one retraction of a fix that was answering a question nobody asks, and one harness that
had been reporting on the wrong page entirely.

## ✅ The product fix: a recording never played, for want of the first line of its playlist

`ManifestStateManager.updateManifest` adopted the playlist headers **after** its finalized branch had
already returned. Opening a broadcast that has already ended is the one route where the first
manifest a viewer ever sees is a finished one, so on that route it never adopted any. `serialize`
then emitted this:

```
#EXT-X-PLAYLIST-TYPE:EVENT
#EXTINF:2,
<segment>
...
#EXT-X-ENDLIST
```

No `#EXTM3U`, no version, no target duration, and a playlist type of EVENT invented in place of the
recording's own VOD. hls.js refuses that whole, as `Missing format identifier #EXTM3U`, and reports
it as fatal rather than as a bad playlist. The player answers a fatal error by remounting, which
fetches the same head and builds the same unusable playlist again.

Reproduced in a unit test before anything was touched, and pinned in two places: at the state manager
that builds the playlist, and at the fetcher that serves it. **The fetcher already had a test over
this exact route**, `clears the signal when the stream comes back already finished`, which asked what
the health signal said and never read the playlist it handed back. A defect can walk past a test
written directly over it if the test asks a different question.

## ⛔ Retracted: the shared watch link was never broken

`88129ea` changed vite's `base` from `./` to `/` and claimed it fixed every shared, bookmarked or
reloaded watch link. It is reverted, because the defect does not exist.

The client mounts its routes under a **`HashRouter`**. Every link the app produces carries the route
in the fragment, so `location.pathname` is always `/`, and a shared link is `/#/watch/...` which asks
for `index.html` at the root. Relative asset URLs resolve from there exactly as they should.

The evidence quoted for it was real and answered a different question. Asking nginx for an asset
under a deep **path** does return `200 text/html`. No viewer ever asks that. What actually put a
browser there was the VOD harness, below.

## ⛔ The harness was watching the catalog page and calling it a player

`e2e/browser/vod.ts` built its watch URL by hand, in the path form, which matches no route. The page
loaded, rendered the catalog, and the catalog drew a **small hls.js player per card**. One of those
loaded one segment. That is the whole of the "one segment arrives and then nothing" that three runs
of request logs kept showing, and it is the reason those logs never made sense: the feed head lookup
in them was the catalog's, and the topic hash in it is not this stream's.

It is the only harness in the repository that builds a watch URL rather than clicking a catalog card,
which is why it is the only one that could meet this. Nothing measured before it is affected.

**What named it was counting the media elements.** The run reported ten of them, none with autoplay
set, which no watch page can produce. Nothing else in the trace said so.

## What a viewer gets, measured

| | recording 1 | recording 2 |
| --- | ---: | ---: |
| duration reported | **27.10s** | **26.86s** |
| seekable to | 27.10s | 26.86s |
| position after settling 8s | **8.08s** | **8.10s** |
| buffered ahead | 14.36s | 14.87s |

A finite duration is the whole point, because a live playlist reports `Infinity` here. The position
after settling says it plays at 1x rather than limping.

### Starting costs a stumble, on both runs

```
bufferStalledError  Playback stalling at @0 due to low buffer
                    (buffered [{start: 0.021, end: 0.170666}], nextStart 0.021)
bufferSeekOverHole  fragment loaded with buffer holes, seeking from 0 to 0.1
```

The recording's media begins at **0.021s**, not at zero, so the player stalls on a hole 21ms wide at
the very start and then steps over it. It recovers because `maxBufferHole` is 1 second. Both runs,
identically. Nobody had seen this before because these two warnings are `console.warn`, and the
harness was reading only `console.error`.

## ✅ Seeking works, and the first report of it failing was mine

The first two runs reported two failed seeks. That was the harness, not the player. It took its seek
targets from `duration`, and 90% of 27.10s is **24.39s**, which is past the end of the seekable
range. Asking for it is an invalid request, not a defect. Targets now come off `seekable`.

With that fixed, seeking is clean on every run:

| target | landed in | resumed in |
| --- | ---: | ---: |
| 50% forward | 35 to 43ms | 338 to 341ms |
| 90% forward | 17 to 40ms | 347 to 359ms |
| 20% backward | 32 to 48ms | 343 to 348ms |

The media-event log, once the probe worked, shows why nothing was ever wrong here: each seek is
`seeking → waiting → seeked → canplay → playing`, and **no `pause` event fires in the whole run**.
The earlier reading of a paused element was the aftermath of asking for an unreachable position.

⭐ **The harness could pass by reaching less.** Because targets came off `duration`, and `duration`
is not stable (below), one run computed its targets from 22.59s instead of 27.10s, tested three
positions well inside the buffer, and reported "seeks all landed and resumed". A run that covers less
should not look like a run that covers more.

## ✅ Fixed, and the real finding: a recording was 19% shorter than its playlist claimed

`duration` and `seekable` both start at **27.10s** and settle at **22.587s** within eight seconds.
A viewer's scrubber shrinks by 17% shortly after playback begins.

Nothing is lost on the wire. Measured in the same run:

| | |
| --- | --- |
| segments the playlist names | **84**, `#EXTINF` summing to **26.860s** |
| distinct segments fetched | **85** (84 plus one refetch after a seek) |
| appends | **86 audio and 86 video**, 7,816,929 bytes |
| append or source-buffer failures | **none** |
| audio track buffered | `0 - 22.549` |
| video track buffered | `0.021 - 22.587` |
| gaps | **none**, one contiguous range on each track |

**Both tracks end together**, so this is not one short track truncating the intersection, which was
the obvious first guess and is refuted. Every segment the playlist names was fetched and accepted,
and laid end to end those 84 segments carry **22.57s** of media against **26.86s** declared.

### Diagnosed: the engine's declared duration matches neither the media nor the clock

Read straight off the segments' own presentation timestamps, all 84 of them:

| | |
| --- | --- |
| media per segment | **0.2667s, dead constant** (8 frames at 30fps) |
| segment continuity | first PTS advances by exactly one segment each time, **no gap, no overlap** |
| media total, 84 segments | **22.400s** |
| `#EXTINF` total | **26.920s** |
| ratio | **1.2018** |

That ratio predicts 22.55s of playable media. The browser measured **22.587s**. It agrees to 0.2%,
so this is the whole of the gap and there is nothing else to look for.

Both candidate mechanisms above are answered. The segments do **not** overlap, so nothing is
discarded as duplicate. The declared durations are simply wrong, and wrong in a specific way: they
jitter between 0.27s and 0.41s around a mean of **0.3205s**, against media that never varies from
0.2667s.

**The pipeline is not at fault, and neither is the encoder.** From the uploader's own log, segments
69 to 83 arrived **3.710s apart over 14 segments, or 0.265s each**, which matches the 0.2667s of
media they carry. The broadcast ran in real time, produced media in real time, and dropped nothing.
So the declared value is not a wall-clock measurement either. It matches nothing.

It comes from SRS. `on_hls` sends a `duration` field and the uploader passes it through verbatim into
`ManifestManager.addSegment` (`engines/srs.ts:308`), which is what lands in `#EXTINF`. SRS is
configured `hls_fragment 0.25`, and the media honours that exactly by cutting at the first GOP
boundary at or after 0.25s. Only the number SRS reports about it is wrong.

⚠️ **Both recordings here were made during the task #86 crash runs**, with SRS restarted underneath
them. Whether a cleanly started and stopped broadcast shows the same ratio is untested.

### Why it reaches further than the scrubber

The same figure is the **catalog's advertised duration** (`getTotalDuration()` sums the same values),
it sets `#EXT-X-TARGETDURATION`, and it is the basis of any latency figure computed from a manifest.
Task #41 already moved the bench off declared spans and onto the bytes for exactly this reason. This
is the first time the gap has been measured on the **product** path rather than the instrument's.

### ✅ Fixed, and confirmed against SRS on a clean broadcast

⭐ **The caveat above is cleared, and the answer is that this is SRS's ordinary behaviour.** Captured
from SRS's own playlist on disk, during a fresh broadcast published at a **2.000s** GOP, with nothing
crashed and nothing restarted:

```
#EXT-X-TARGETDURATION:3
#EXTINF:2.514, no desc
#EXTINF:2.509, no desc
#EXTINF:2.513, no desc
```

**2.51s declared for 2.00s of media**, 25% over, on a healthy stream. It is not a crash artifact and
it is not specific to the 0.25s profile.

The uploader now measures each segment instead. Verified end to end on a recording published after
the fix, cleanly started and cleanly stopped, comparing every `#EXTINF` in the playlist a viewer is
served against the presentation timestamps in the segment it names:

| | |
| --- | --- |
| segments compared | **17 of 17** |
| worst disagreement | **0.000000s** |
| segments that fell back to the engine's claim | **0** |

The values are right rather than merely consistent: the first segment is published as **2.068s**,
which is 62 frames at 30fps exactly, where SRS declared **2.514s** for those same 62 frames.

### The fix, which already existed in the wrong package

`e2e/src/bench/segmentSpan.ts` does this measurement properly and is covered by nine tests. It was
written for LAT-9 and it handles the two things a naive reading gets wrong: packets arrive in decode
order so the newest frame is not the last listed, and a timestamp says when a frame started rather
than how long it lasted, so the final frame is credited the median gap.

The uploader already held the segment bytes at `handleSegment`, so the module moved into
`packages/shared` and `#EXTINF` now comes from the bytes. What could not move is how the bench feeds
it, which is ffprobe: the uploader has no ffmpeg in its image, so `readVideoPts` reads the timestamps
out of the transport packets directly.

Substituted in the **orchestrator**, where the HTTP route, the SRS webhook and the OME puller
converge, because the engine caught at this is not special. The engine's claim is still the answer
for a segment that cannot be read, which is not a fallback for the unexpected but the live path for
OME, whose fMP4 segments carry no transport packets at all. That is counted as well as logged, since
the two deployments are opposite and both normal: one falls back on every segment, the other never,
and the rate moving between them is the signal.

The cost accepted is a parse of every segment on the upload path. It is a scan of roughly 550 packet
headers per segment, and no fallback fired across 17 real segments.

## ⚠️ The instrument, and it took three tries to trust it

The probe's `MediaSource` and media-event hooks recorded **nothing** across three runs while its
element reading worked and did all the real work. Two separate faults, and the second was only
findable because the first was fixed:

1. An empty `sourceBuffers` and a probe that never installed produced identical JSON, and the empty
   one is the reassuring answer. The probe now sets `installed` as the last statement its init script
   runs.
2. With that in place, one run named the cause exactly: **`ReferenceError: __name is not defined`**.
   tsx compiles with esbuild's `keepNames`, which rewrites named functions against a helper defined
   at module scope, and Playwright serialises only the function's own source. The whole script died
   before installing anything. `installTimerProbe` escapes it only by declaring no named function.

Readings from before `installed: true` say nothing about appends or events.

## Still untested

Seeking past a discontinuity, and seeking into a region whose chunks have left the local gateway.
The harness asks both, and on a 27-second recording that fits in the buffer entirely, neither is
reached.
