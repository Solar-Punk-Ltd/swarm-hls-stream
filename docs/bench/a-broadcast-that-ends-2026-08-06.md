# A broadcast that ends, watched from a viewer's seat

**2026-08-06.** One 450-second watch in real Chrome on the deployment host, 720p at a 0.25s GOP. The
publisher was killed **150 seconds into the watch** and the viewer was left on the page for the
remaining 300. Task #93.

`browser-watch-2026-08-06T08-55-10-332Z`.

## What was being asked

Fix 0.8a asks four extra feed slots whenever a poll sits on an unserved slot three times running.
That is the right trade on a live feed and it cost nothing measurable there: **0 probes in 2,308
requests** on a healthy ten-minute run. The worry was the other end of it. A publisher that goes away
for good leaves no head to find, so the ladder can never succeed, and nothing in the code stops it
asking. `UNSERVED_SLOT_POLL_LIMIT` only decides when to log.

**The prediction was five requests per poll, forever.**

## ⛔ Refuted, and by a wide margin

| feed slot reads per second | | |
| --- | ---: | ---: |
| while the broadcast was live | t = 0 to 150s | **3.0 to 4.1** |
| after it ended | t = 180s onward | **0.00** |

**A viewer parked on an ended broadcast sends nothing at all.** The last request of any kind left the
page at **t = 281.6s**, and the final **168 seconds were completely silent**: no slot reads, no head
lookups, no segments.

The reason is upstream of the probe. When the broadcast ends the uploader publishes the finished VOD
manifest, which carries `#EXT-X-ENDLIST`, so hls.js stops reloading the playlist. Our feed polling
rides on that reload. No poll means no refusal, and no refusal means the ladder is never reached.

⚠️ **This closes the clean case only.** It was the *publisher* that went away here and the uploader
finalised the stream normally. An uploader that dies mid-broadcast never writes the VOD manifest, the
playlist stays live, and polling continues at full cadence. The earlier crash run measured that at
**13 probes in 415 requests**, so it is real and small, but it is unbounded in time and nothing here
tested it. Task #93 is closed as refuted for the clean end and reopened narrowly as that.

## ⛔ What the run found instead, which is worse

The request log was the cheap half of this. The playback trace is the finding.

| t (s) | currentTime | what the viewer saw |
| ---: | ---: | --- |
| 0 to 150.7 | 5.54 → **155.98** | watching normally, 1:1 with the clock |
| **151.7** | **→ 0.00** | **thrown back to the beginning** |
| 152 to 304 | 0.00 → 149.57 | silently re-watching the broadcast from the start |
| 405 onward | **180.59, paused** | stopped at the end of the recording |

⭐ **When a live broadcast ends, the viewer is rewound to zero and replays the whole thing.** Nothing
is said on screen. The player simply starts again from the first second of a broadcast the viewer has
just finished watching.

**The mechanism is confirmed in our code and is not a guess.** The live manifest is a sliding window
sitting at a high media sequence. The VOD manifest that replaces it names every segment and therefore
starts at sequence zero. A media sequence that goes backwards is what hls.js reports as
`LEVEL_PARSING_ERROR`, and it reports it as **fatal**. `SwarmHlsPlayer.tsx:98` answers a fatal
`LEVEL_PARSING_ERROR` by calling `restartStream()`, which destroys the player and remounts it. The
fresh instance loads the VOD manifest and does the only thing it can with it, which is to play it
from the beginning.

So the rewind is not a failure of the recovery path. **It is the recovery path working exactly as
written, on an event that is not a fault.** The end of a broadcast is a normal thing for a broadcast
to do.

## ✅ Fixed in the uploader, and the client needed no change

Filed as **#94** and fixed in `f0912fd`. The chain was read end to end in hls.js's own source rather
than inferred:

| where | what |
| --- | --- |
| `hls.js` line 9045 | `mergeDetails` sets `playlistParsingError` to **`media sequence mismatch`** |
| `hls.js` line 36455 | raised as `LEVEL_PARSING_ERROR`, **`fatal: false`** |
| `hls.js` line 5072 | the error controller **escalates it to fatal**, because a single-variant stream has no level to switch to |
| `SwarmHlsPlayer.tsx:98` | a fatal `LEVEL_PARSING_ERROR` calls `restartStream()`, which remounts the player |

**So the uploader was the one breaking the rule**, and hls.js was correctly objecting to it.
Finalization now publishes the live window with `#EXT-X-ENDLIST` **before** the VOD manifest. That
closing manifest is the playlist the viewer is already on, at the same media sequence, now ended, so
it merges rather than restarting anything. The recording is published after it and is unchanged: it
still renumbers from zero and still names every segment, because it is a different resource with a
different reader.

⭐ **The client needed no change, and finding that out was the point of looking.** `parseManifest`
already sets `isFinalized` from `#EXT-X-ENDLIST` (`packages/shared/src/manifest.ts:86`), and
`updateManifest` already applies such a manifest, stops the walk, and ignores everything after it.
The client's design was right the whole time. It was being handed a manifest it could not merge, and
the guard that would have protected it fires on the same tag the fix now arrives with. **This is the
opposite of the usual finding here, where the instrument or the client turned out to be at fault.**

⚠️ **What is still not done**: nothing on screen says the broadcast ended. The viewer plays out what
it holds and stops, which is correct behaviour and a silent one. An end-of-broadcast `FeedStateOverlay`
state is a separate, smaller piece of work.

⚠️ **Not yet verified live.** The unit tests cover the manifests and the publish order. The viewer-side
proof needs another `ended-run.sh`, which is queued behind the hour-long 1080p gate.

## ⛔ And the report said none of this had happened

The run's own summary reported **0 fatal errors** for a session containing one, and **0.389 media
seconds per wall second**, which reads as a viewer frozen for 61% of the time.

Both are the same defect, and it was mine. The page keeps rebuffers, fatal errors and dropped frames
as running totals for the session. A remounted player starts them at zero, and `summarize` read the
**last** sample. Everything before the restart was erased. The advance ratio has the matching
problem: it took `last.currentTime - first.currentTime`, so a rewind to zero reads as a player that
never moved.

Fixed in `7507b24`, which totals each counter across restarts and sums the media played over each
life of the player separately. Against this run's own samples:

| | reported | corrected |
| --- | ---: | ---: |
| fatal errors | 0 | **1** |
| dropped frames | 69 | **169** |
| media per wall second | 0.389 | **0.736** |
| **frames per second of media** | **31.0** | **30.0** |

⭐ **The frame rate is the check that matters.** 31.0 is not a rate a 30fps stream can produce, and
the corrected figure is exactly 30.0. That is an independent confirmation the correction is right
rather than merely different.

✅ **Every other browser run was audited and none is affected.** All 30 stored runs were scanned for a
`currentTime` that goes backwards. **This run is the only one**, so no published figure moves: the
sixty-minute gates, the quality grid and the five crash scenarios all ran on a player that never
restarted.

## What this does not say

**One run, one ending.** The publisher was killed while the uploader stayed healthy, which is the
clean ending. An uploader that dies, an engine that restarts, and a broadcast that ends and then
resumes on the same topic are three different endings and none was tested here.

**Nothing here measures how long the rewind takes to become visible.** The viewer was already at the
live edge with a full buffer. A viewer who joined seconds before the end has less to replay and would
notice sooner.
