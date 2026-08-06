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

## ⚠️ Fixed in the uploader, and the claim that the client needed no change was wrong

**Read the two sections after this one before believing this one.** The uploader change below is
correct and still shipped. The conclusion drawn beside it, that the client needed nothing, was
refuted by the next run.

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

⛔ **This paragraph is wrong and is kept because being wrong here was the point.** `parseManifest`
already sets `isFinalized` from `#EXT-X-ENDLIST` (`packages/shared/src/manifest.ts:86`), and
`updateManifest` already applies such a manifest, stops the walk, and ignores everything after it.
What that missed is the probe added in 0.8a, which steps over a refused slot and can therefore reach
the recording without ever seeing the manifest that ends the live playlist. **The satisfying shape of
the conclusion, that for once the client was not at fault, is what stopped the search early.**

⚠️ **What is still not done**: nothing on screen says the broadcast ended. The viewer plays out what
it holds and stops, which is correct behaviour and a silent one. An end-of-broadcast `FeedStateOverlay`
state is a separate, smaller piece of work.

## ⛔ "VERIFIED LIVE", which it was not: one run of a race

**Superseded by the section after it.** The numbers below are real and the run happened, but it was a
single run of a scenario whose failure is a race, and the next one failed. Kept because the claim was
published and the correction belongs beside it.

`browser-watch-2026-08-06T10-24-24-325Z`, the same run: 150 seconds live, then the publisher killed
and the viewer left on the page for 300 more.

| | before | **after** |
| --- | --- | --- |
| **`currentTime` rewinds** | **1, at t=151.7s: 155.98 → 0.00** | **none** |
| fatal errors | 1 | **0** |
| `media sequence mismatch` in the console | yes | **none** |
| player restarts | 1 | **0** |
| where playback ended | 180.59s, after replaying from zero | **156.87s, the end of the broadcast** |
| segment requests | 1,248 for 677 distinct | **574 for 568 distinct** |
| **segment bytes fetched** | **116.3 MB** | **53.2 MB** |
| last request | t = 281.6s | **t = 158.8s** |

⭐ **The viewer now watches to the end of the broadcast and stops there.** It reaches 156.87 seconds,
which is everything from where it joined to where the broadcast finished, and pauses. No rewind, no
fatal error, no restart, nothing in the console.

⭐ **It also stops re-downloading the recording, which was never the point and is the larger number.**
The broken path fetched **116.3 MB** because the remount pulled the whole VOD to replay it. The fixed
path fetches **53.2 MB**, once, and goes quiet **123 seconds earlier**. That is bandwidth and BZZ the
old behaviour spent to deliver a worse experience.

The request log was confirmed **unthinned** first (1,134 successes against the 5,000 cap), as the rule
after `thinRequestLog` invalidated an adjacency analysis on the hour-long run.

⚠️ **One reading is not meaningful and is not a defect.** `behind live` pins at 56.60s once the
playlist ends, because hls.js's latency is defined against a live edge and the playlist is no longer
live. `currentTime` is the measurement that matters here and it is correct.

## ⛔ AND THEN IT CAME BACK, because one run of a race is not a verification

The next run of the same scenario rewound exactly as before. **The verification above was one run of
a race and it won the toss.** Decoding the slot indices out of the hashed request URLs says what
happened:

| t (s) | slot | |
| ---: | ---: | --- |
| 158.9 | 670 | 404, the fourth refusal, so the probe fires |
| 160.4 | **671** | **200, and 671 is the recording** |
| 160.9 | 670 | timed out after 10s |

The uploader published **670 (closing)** and **671 (recording)** 273ms apart, and **the probe added in
0.8a stepped over the closing manifest into the recording.** So publishing a closing manifest first is
**necessary and not sufficient**: a viewer can still reach the recording first, and here it did
because 670 was momentarily unretrievable while 671 was not.

⛔ **The first client guard written for this was also wrong, and it would have shipped as a no-op.** It
compared media sequences and refused one that moved backwards. `normalizeHeaders`
(`ManifestManagement.ts:269`) rewrites **every** playlist this client serves to
`#EXT-X-MEDIA-SEQUENCE:0`, so both playlists sit at zero and the comparison can never fire. The same
number meaning different media in each is precisely what `mergeDetails` reports. Found by reading
`normalizeHeaders` before wiring the guard up, not by a test.

## ✅ The fix that shipped: a finished playlist extends, it does not replace

`0d83a04`. Segment N means "the Nth since this viewer joined", so changing the front of the list
changes what every number already handed to hls.js refers to. **Both finished playlists would do it**:
the closing manifest is a live window and starts **later** than a viewer who joined earlier, the
recording names everything and starts **earlier** than one who joined partway through.

Neither replaces the list now. Each contributes only what it carries after the last segment already
held, matched by segment address rather than position, and one sharing no segment at all is ignored.
Against the old wholesale replacement, three of the five new cases fail.

## What three more runs actually showed, which is less than it looks

Three end-of-broadcast runs against the corrected client: **no rewind, no fatal error, and the ended
overlay in all three.** Mapping each client trace onto the uploader's own indices:

| run | closing | recording | what the client fetched |
| --- | ---: | ---: | --- |
| 11-16 | 558 | 559 | 558 only, never touched the recording |
| 11-22 | 563 | 564 | 562 then 563, never touched the recording |
| 11-28 | 555 | 556 | the probe stepped over 554 and landed on **555, the closing manifest** |

⚠️ **None of the three reproduced the race.** In every one the client stopped at the closing manifest,
so the uploader fix carried them and **the playlist-extension fix was never exercised live.** It is
unit-tested and falsifiable, and that is the whole of its evidence.

**What would exercise it**: the closing manifest unretrievable for a few seconds while the recording
is retrievable, which is what happened once and has not been reproduced on demand. A fault injection
that delays one specific feed slot would do it, and does not exist.

## ✅ Verified live: the viewer is told

`browser-watch-2026-08-06T10-57-37-286Z` and all three runs above. **"This broadcast has ended"**
appears on the first sample after the feed finishes and stays, and on no sample before it. `ended`
outranks `reconnecting` and `stalled`, because a gateway going down afterwards does not make a
broadcast unfinished, and it carries no pulsing dot, since the pulse promises a picture that is not
coming.

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
