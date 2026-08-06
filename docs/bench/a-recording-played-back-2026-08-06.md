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

## ⛔ Open: seeking outside the buffer stops the picture for good

| target | asked | landed | landed in | resumed in | |
| --- | ---: | ---: | ---: | ---: | --- |
| 50% | 13.55s | 13.56s | 57ms | 358ms | ✅ |
| 90% | 24.39s | 22.59s | — | — | ⛔ never landed within 1.5s |
| 20% | 5.42s | 5.42s | 61ms | — | ⛔ landed, and the picture never moved again |

Recording 2 reproduces every row: 47ms and 351ms, then stuck at 22.39s, then landed at 5.37s and
frozen.

A **forward seek inside what the player already holds is fast and clean**. Both failures are seeks
outside it, and the 90% target lands at the buffer's own edge rather than where it was asked.

The element afterwards is the part worth keeping:

```
readyState 4, currentTime 5.372, paused TRUE
buffered [0.021 - 15.211], [22.154 - 22.387]
```

**`readyState 4` is HAVE_ENOUGH_DATA, and 5.372 sits inside the first buffered range.** The media for
the position it is parked on is already in memory. It is not waiting for a segment. It is paused.

That is as far as this goes, and the rest is a reading of the code rather than a result: the player
calls `hls.stopLoad()` on the media element's `pause` event, so once something pauses it, loading
stops and nothing is left to start it again. **Whether that is what pauses it here is not measured.**
The next run should get it, now that the probe records media events, since the `pause` and its
`readyState` would name the moment exactly.

## ⚠️ One instrument caveat, and it is the same shape as the defect above

The probe's `MediaSource` and media-event hooks recorded **nothing** on the watch page across two
runs, while its element reading worked and did all the work here. An empty `sourceBuffers` on a page
that plainly played fifteen seconds of video is a probe fault, not a fact about the player, and the
run said nothing to distinguish the two. The probe now sets `installed` as the last thing its init
script does, so a reader can tell "installed and saw nothing" from "never ran". **Until a run comes
back with `installed: true` and non-empty counters, treat the append and event capture as unproven.**

## Still untested

Seeking past a discontinuity, and seeking into a region whose chunks have left the local gateway.
The harness asks both and neither has been reached, because the seek defect above stops it first.
