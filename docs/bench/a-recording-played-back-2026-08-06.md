# A recording, watched for the first time

**2026-08-06.** Phase 1.2. Two runs, against the two recordings the task #86 crash runs left behind.

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

## ⛔ Open, and the real finding: a recording is 19% shorter than its playlist claims

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

Two mechanisms fit and this run cannot separate them:

- the `#EXTINF` durations over-declare, by a factor of **1.19** (0.320s declared against 0.269s of
  media per segment, at a profile whose GOP is 0.25s)
- consecutive segments **overlap in presentation time**, and the player discards the duplicate

The next measurement is the same either way: take the PTS span of a handful of segments straight from
the bytes and compare it with what the manifest says about them.

⚠️ **Both recordings here were made during the task #86 crash runs**, with SRS restarted underneath
them. Whether a cleanly started and cleanly stopped broadcast shows the same ratio is untested, and
should be checked before this is generalised.

It matters beyond the scrubber. The **catalog's advertised duration** comes from the same sum
(`getTotalDuration()`), `#EXT-X-TARGETDURATION` is derived from the same numbers, and so is every
latency figure this project computes from a manifest. Task #41 already moved the bench off manifest
spans onto the bytes for exactly this reason. This is the first time the gap has been measured at a
viewer.

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
