# Stream Uploader

Node.js service that receives HLS segments and uploads them to the Swarm decentralized network. Part of the [swarm-hls-stream](../../) monorepo.

## How It Works

The uploader receives HLS segments from a media server, such as SRS, or directly via HTTP. It uploads
each segment to Swarm and maintains a live HLS manifest as a Swarm Feed. When a stream ends, the
manifest is finalized as VOD. A standalone deployment writes that state to the Swarm stream catalog.
In admin mode, the uploader reports `live` and `vod` to the admin service, which owns the catalog.

```
Segments in ──▶ StreamOrchestrator ──▶ StreamUploader ──▶ Swarm
                      │                      │
                      │                      ├─ Upload segment data
                      │                      ├─ Update manifest feed (SOC)
                      │                      └─ Update catalog or report state to admin
                      │
                      ├─ Backpressure (bounded queue, 429 on overflow)
                      ├─ Deduplication (a repeat index is accepted and does no work)
                      └─ Crash recovery (persisted state + recovery timeout)
```

### ABR ladder

With `ABR_ENABLED=true` (see [engines/srs](../../engines/srs/)) the engine publishes one stream per
rung, and each gets its own `StreamUploader` and its own manifest feed, whose topic is **derived from
the ladder's group id and the rung's name** (`src/utils/rungTopic.ts`, a version-5 UUID). That feed
therefore outlives any one session: a rung that restarts mid-broadcast — SRS bouncing a transcoder,
an encoder reconnecting — comes back onto the feed the master already names, reads its head, and
numbers its playlist on from there with a single `#EXT-X-DISCONTINUITY` at the seam, rather than
appearing on a feed nothing points at until it re-announces. A session opening over that feed also
**inherits the playlist at its head into its own recording**, so the head recording carries every
session the feed has held, oldest first, with an `#EXT-X-DISCONTINUITY` at each seam and the reported
duration covering the whole broadcast. The live playlists are unchanged by that: they stay a window
over the current session's own segments. Two things then tie the rungs back together:

- The four rungs merge into a **single catalog entry**, keyed by a shared group id rather than by
  topic. Four uploaders write that entry concurrently, which is safe only because every catalog
  write goes through one serialized queue.
- That same point is where the ladder's **master playlist** is written, to a fifth feed whose topic
  is the group id — it is the only place the whole ladder is known, since each uploader holds just
  its own rung. The catalog entry's `topic` points at the master, so one URL yields every rung.

The ladder becomes a recording once every rung has either finalized or stopped without a recording,
and at least one of them finalized. A rung stops without one when its stop fails, as 1080p's did on
2026-09-23 when its full postage batch refused its recording: before this, the entry stayed `live`
with no index for good. The finished entry and its master then name only the rungs that have a
recording, and `unfinishedRungs` names the rest. A rung that finishes later, when its recovery entry
is retried at the next boot, is added to the recording then, and nothing announces a second ending.

Each rung's `BANDWIDTH` in the master is measured from real segments rather than copied from the
encoder's target, and is re-announced when it drifts more than 15% (at most every 30s, since the
catalog is one feed shared by every stream). What tells a player that two rungs share a timeline is
the pair of numbers on every segment line, and they are the subject of the next section.

The master also stops advertising a rung that has stopped being produced. A rung the ladder has
delivered four segments past is dropped from the next master write, and it is put back the moment it
delivers again, unless its uploads were being refused, which the next paragraph covers. So a viewer
joining during an outage is not offered a quality with nothing behind it. Measured live on
2026-09-01: dropped 6.9s after the rung went down, restored 11.3s after it came back. The rule is
`LadderLiveness`, and how it drops a rung is deliberately a copy of the player's own rule in
`packages/client/src/components/SwarmHlsPlayer/feedState.ts` rather than a second independent one.
That file took eight attempts to get right and all three of its properties are load bearing: count
delivered segments rather than read a clock, compare against a middle rung rather than the leader,
and measure each rung's lag from where the ladder stood at its own last delivery. A master naming no
renditions at all is never written, because that is an unplayable stream rather than a degraded one.

The one place the two rules differ is taking a rung back, which the player never does. A rung that
fell behind while its uploads were being refused, a full postage batch being the measured cause,
comes back into the master only after landing eight segments in a row (`RUNG_READMIT_AFTER_SEGMENTS`).
On 2026-09-23 each stray segment such a rung landed put it back, and the master was rewritten 793
times in four hours, flipping between three rungs and four.

⛔ A rung dying is not a rendition announcement, so nothing on the announce path asks this question.
The segment path asks it on every delivery and rewrites the master only when the set of live rungs
actually changes. A version of this filter shipped correct, tested and deployed, and never ran once,
because only `upsertRendition` wrote a master.

With `ADMIN_API_URL` set as well, everything above still happens, but the merge moves out of the
catalog feed and into the admin and the master's topic is the declared one — see
[Admin mode](#admin-mode).

### The manifest contract: timestamps and continuous published numbering

Every playlist this service writes, live, closing and recording alike, carries a media sequence for
the playlist and a date-time per segment. The date-time and the session-local sequence come from one
anchor the whole broadcast shares. Neither comes from the number the engine handed over. If the feed
topic already holds an earlier session, the published media sequence also carries a feed offset so
it continues after the previous playlist instead of moving backwards.

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:0

#EXT-X-PROGRAM-DATE-TIME:2026-09-01T12:00:00.000Z
#EXTINF:1,
2a5f…c1
#EXT-X-PROGRAM-DATE-TIME:2026-09-01T12:00:01.000Z
#EXTINF:1,
9b04…7e
```

**The anchor** is one instant, taken when the broadcast is admitted, at the engine's publish
callback (`StreamOrchestrator.startStream` → `spawnUploader`), plus the nominal fragment length the
deployment declared through `HLS_FRAGMENT`. It is minted once per ladder group, so all four rungs
read the same value however far apart they were admitted, and it outlives every session of that
broadcast: it rides with the group in `state/ladder/groups.json` and in each rung's recovery entry,
so a rung rebuilt after a crash keeps it rather than re-dating the recording at the restart.

**`#EXT-X-PROGRAM-DATE-TIME`** is the instant of the segment in front of it plus the media that
segment holds, in UTC to the millisecond, decided once as the segment is placed and then stored on
it. The broadcast's first segment takes the anchor itself. An engine restart inside the broadcast
adds an epoch, described below.

**The media a segment contributes is read against `HLS_FRAGMENT`.** A segment measuring within 1% of
the declared length counts as exactly that length, and one outside it counts as itself, rounded to
the millisecond. That 1% is `DATING_SNAP_TOLERANCE` in `src/libs/broadcastDating.ts`. It is the
rounding band of one keyframe grid seen by several encoders and nothing wider, which is all the
snapping is for.

⚠️ **It is not `FRAGMENT_TOLERANCE`, the 5% the fragment agreement check uses, and the two are
different numbers on purpose.** That one asks whether a stage is misconfigured, so it has to survive
a segment SRS force-closed at `HLS_FRAGMENT x HLS_AOF_RATIO` without calling a healthy deployment
broken. Dating on that band would read a 2.067 second segment against a configured 2 as 2.000 and
lose its 67ms every segment, about two minutes an hour, which is the exact live stream this dating
exists to fix.

⛔ **Under a ladder every segment is inside that band, so the step is the declared fragment and four
rungs date one piece of media identically.** `engines/srs/entrypoint.sh` pins a keyframe every
`ABR_FPS × HLS_FRAGMENT` frames and SRS cuts exactly there, so a rung's segment holds the configured
length to within 90kHz tick rounding. Two rungs can only be dated apart by measuring one segment more
than the tolerance apart, which is the mismatch that check already names.

⛔ **On a single rendition the publisher's own keyframe interval decides the segment**, and
`HLS_FRAGMENT` is a floor rather than the length. A stage measured on 2026-09-15 cut segments from
2.067 to 10.033 seconds against a configured 2 while every date stepped exactly 2.000, so the
recording's wall clock fell further behind its own media with every segment and kept those dates for
ever. That is what the media term fixes.

⛔ It is still never an arrival time. Four rung uploaders stamping the clock they received a segment
at would disagree by their upload jitter, and hls.js reads that disagreement as the rungs covering
different media. The millisecond precision is what a sub-second fragment needs: at `HLS_FRAGMENT=0.5`
a whole-second stamp would give two consecutive segments the same instant.

⚠️ **It was therefore nominal when this rule was written, and the operating rule that keeps it
honest is about the source's keyframe interval.** Decided by the owner on 2026-09-03: accepted as it
is, with this rule and no code change. What "nominal" covers narrowed on 2026-09-15, and the
paragraph below says to what.

The stamp is nominal inside that 1% band now and no wider, so the drift that rule was written against
is gone. `HLS_FRAGMENT` is a floor on the segment rather than the segment, because the engine cuts at
the first keyframe at or after it, so a source whose GOP does not divide it produces segments longer
than the declared length. Until 2026-09-15 the stamps stepped by the declared length anyway and fell
behind by that excess on every segment, without bound over a long broadcast. They step by the media
now, so a recording of such a stage keeps the right clock. What is still wrong there is every
`#EXT-X-GAP` entry, which is dated and sized at the declared length, so a lost segment leaves a hole
of the wrong size. Under the ABR ladder neither arises, because the engine transcodes every rung with
a GOP that divides the fragment (`ABR_FPS × HLS_FRAGMENT`). **A single-rendition deployment must set
the broadcaster's keyframe interval to divide `HLS_FRAGMENT`**, and nothing in this service can make
it do so. See [deploy/README.md](../../deploy/README.md).

The e2e preflight gate that checks the stage cuts at the configured length would catch a misaligned
stage on a sitting. In production `/health` names one under `fragment_publisher_gop`, with the
configured length beside the measured one, which is as far as this service can go where the keyframe
interval belongs to whoever is broadcasting.

**The session-local media sequence** counts from 0 at the broadcast's first segment. On a fresh
topic, that is also the value published in `#EXT-X-MEDIA-SEQUENCE`.

A declared stream in admin mode can publish several broadcasts on one topic. A ladder rung also
keeps one derived topic across uploader sessions. Before either writes its first manifest, it reads
the feed head and counts the entries in the previous playlist, including gap entries. That count is
the new session's published offset. A previous playlist that starts at 12 and lists 30 entries makes
the next session publish its first segment as 42. The offset changes only the numbers written into
the playlist. Dating, ordering and restart detection still use the session-local sequence from the
shared anchor, so rungs that resume different feed heads still date the same media alike. A recovered
session restores its saved offset instead of reading its own latest playlist as a predecessor.

The example above is therefore a fresh topic. A later session on the same declared or rung feed has
the same shape but may open at a value above 0, with `#EXT-X-DISCONTINUITY` on its first segment to
mark the seam from the earlier session.

The engine's own index is not this number and is not used for it. SRS runs one counter per rung
stream and only resets it when the whole `SrsLiveSource` is destroyed, which its idle timeout does a
few seconds after a publisher leaves, so a broadcast on a warm engine opens at whatever number the
previous one ended on: six recordings of this stage opened at 210, 317, 416, 580, 707 and 850. Read
in `ossrs/srs` 6.0release, `trunk/src/app/srs_app_hls.cpp`: `_sequence_no` is set to 0 in
`SrsHlsMuxer`'s constructor and nowhere else, `on_publish` and `on_unpublish` leave it alone, and
`hls_dispose` deletes the segments and the m3u8 without touching it.

⛔ **The uploader's log lines keep naming the engine's index** (`Segment N of <stream> uploaded:
<ref>`), because that is what correlates with the engine's own logs and with a segment reference.
Only the playlists renumber, and the recording uses the same numbering as the live playlists rather
than a second one of its own.

⛔ **The sequence never moves backwards.** An engine that restarts inside one broadcast resets its
counter, and an index that would publish at or below a sequence already published re-anchors the
numbering forwards instead: the playlist continues from the last number plus one, the post-restart
media is filed after the media it follows, a discontinuity is armed, and the date-time re-anchors
with it rather than following the reset index. hls.js reads a media sequence that moves backwards as
a parsing error, escalates it to fatal on a single-variant stream, and the client answers a fatal
parsing error by remounting the player, which restarts playback at the beginning.

An index below the anchor before anything has been published is the other case and it is not a
restart: it is a segment that arrived out of order, and it takes its true place in media order.

⚠️ **The segment the restart lands on carries the discontinuity itself**, whatever the engine
declared, and only that one segment. The SRS webhook path delivers a segment with no break of its
own, so on the shipped engine the reset is the only evidence there is. It is one of only three things
that arm a break at all: the others are the origin declaring one through `markDiscontinuity`, and an
encoder returning inside the reconnect window through `resumeAfterReconnect`.

### An encoder that disconnects keeps its broadcast for one reap window

⛔ **Owner cases 1, 2, 3 and 6, fixed in the uploader on 2026-09-22.** SRS ends a publish within
seconds of any interruption — immediately on a clean stop, under five seconds on a torn-down socket,
under fifteen on a frozen one, all measured live against 6.0.184 — and the uploader used to answer
that webhook by finalizing. A recording was therefore sealed one or two seconds into every outage a
broadcaster was about to recover from, and the return opened a second one.

**A disconnect is silence now, not an end.** `on_unpublish` reports it and ends nothing: the live
playlist at the head simply stops advancing. What decides a broadcast is over is what has always
decided it for an engine that died without saying anything — `ORPHAN_REAP_MS` (60 s) with no media
in it.

| What the encoder does        | What a viewer gets                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comes back inside the window | The same session, the same recording and the same feed, with one `#EXT-X-DISCONTINUITY` at the seam and the dating re-anchored on the clock it returned at. No `#EXT-X-ENDLIST` was written in between, so a player following the feed head is handed the next update of the playlist it is already playing |
| Does not come back           | The reaper finalizes the broadcast one window after its last segment: closing playlist, recording, and `vod` to the admin. An encoder returning after that starts a **new** session, which inherits the recording at the feed head, so the recording a viewer opens still carries every session             |

So **the admin shows `live` for up to one window after the encoder leaves**, and a clean stop reaches
its recording about a window later than it used to. That is the cost of the row above it, and it is
the owner's decision of 2026-09-22.

⛔ **A reconnect buys the first segment time to arrive, and nothing more.** The window runs from the
last segment rather than from the webhook, so an announce does not move the deadline. What it does
buy is a grace of `SEGMENT_STALL_MS` for the segment it is about to deliver, capped at one grace past
the deadline the broadcast already had — without it an announce accepted three seconds before the
window was up was followed three seconds later by a reap, and the encoder went on publishing into an
id nothing held any more, because it does not announce again for a publish session it already has. An
encoder that reconnects every few seconds and never sends a frame therefore still ends, one grace
later than it would have, rather than being held open for as long as it keeps trying.

⛔ **SRS's own publish timeout is deliberately not lengthened to match.** A clean stop sends an
explicit goodbye, so no timeout applies to it at all, and a publish SRS still believes in refuses the
encoder's own reconnect as a stream already busy. The uploader is the only side that can hold
anything open here.

⚠️ **The seam is armed by the reconnect, not inferred from the numbering.** SRS keeps a source and
its HLS muxer alive for `hls_dispose × 1.1` ≈ 132 s after an unpublish, so an encoder returning inside
the window is usually served by the same muxer and its `seq_no` carries straight on — the
counter-restart detection described above sees nothing to detect. The returning segment publishes one
above everything already published whatever index it carries, which also means an **in-order** return
emits no gap entries: nothing was lost, because nothing was being produced. In order is what both
engines deliver — SRS posts each segment to the webhook as it closes it, and OME's puller walks a
playlist front to back. A lower index of the resumed run arriving afterwards would take the ordinary
counter-restart branch and declare a second break and a second re-anchoring — not a gap, because that
branch also places it at the high-water mark plus one, so the two are contiguous. It is pre-existing
behaviour for any out-of-order arrival below a published sequence rather than something the reconnect
path introduced, and nothing is engineered for it.

**Which announces join a live broadcast, and which take the id over a finalized one.** An announce is
first screened by the takeover rules below, which are unchanged; one that is allowed then joins the
live session only when it is the publisher that left it. Both sides having proved the publish key is
the strongest form of that and the one every real deployment takes, because in admin mode and under
`PUBLISH_KEY_SECRET` every publish proves a key — so an encoder that stopped and came back resumes
whatever its address did in between. An announce against an incumbent nobody can name resumes if it
proved the key, and two announces that proved nothing resume unless their addresses are both known
and different. What is left is a provably different publisher — a key holder taking the id from an
incumbent that proved nothing, or a stranger admitted because the incumbent went quiet for the stall
window — and that one finalizes the session it displaces and starts its own, so no publisher's
recording ever opens with somebody else's media.

⚠️ **Without a publish key, a broadcaster returning from a CHANGED address starts a new session.** The
two are indistinguishable there — an address is all the evidence a keyless deployment has — and a
stranger must never join a live recording, so the stall window lets the owner retake the ID rather
than rejoin the broadcast. Configure `PUBLISH_KEY_SECRET`, or run in admin mode, and every publish
proves a key: the same broadcaster then resumes across an address change, which is what cases 1 and 2
ask for and what the owner's deployments do.

The operator stop (`POST /stream/stop`), the recovery timeout and the reap expiry all finalize
immediately and are unchanged, and so is OME's closing webhook. `/health` lists every id currently
held for a returning encoder under `disconnectedStreams`; it raises no reason, because a disconnect
is an ordinary event with a designed answer.

### A segment that was lost is said with `#EXT-X-GAP`, not with a break

⛔ **Owner ruling of 2026-09-06, "Option A, say the gap".** A segment nothing took leaves its sequence
empty, and the playlist lists every empty sequence between two held segments as an `#EXT-X-GAP` entry
carrying the same derived date-time, the deployment's declared fragment length and a URI of
`gap-<sequence>`. RFC 8216bis §4.4.4.7 defines the tag as an entry whose URI holds no media and which
a client should skip, and hls.js 1.6.15 reads it into `frag.gap` and skips the fragment.

The alternative was leaving the hole out, which is what the playlists did until then, and HLS numbers
the entries it lists consecutively from `#EXT-X-MEDIA-SEQUENCE`. So every entry behind a hole was
numbered one lower than its own sequence until the window's head crossed the hole, and one higher
after. Two things broke there: the rolling playlist renumbered media a viewer was already holding, and
a rung that lost one segment stopped agreeing with its siblings about which instant segment N covers,
which is the whole reason all four rungs derive their numbering from one anchor.

⚠️ **A hole is not a break.** A lost segment does not restart the encoder's clock, so the media behind
the hole is a continuation and the dates carry on from the media in front of them, charging one
declared fragment for each sequence nobody observed. The three loss paths, a failed upload, a loss the
OME puller reported and a hole inferred from the numbering, arm no `#EXT-X-DISCONTINUITY` and keep
their log lines unchanged.

⛔ A gap entry never starts a live window and never ends a playlist: the window is a slice of the
segments actually held, so `#EXT-X-MEDIA-SEQUENCE` is always a held segment's own sequence and a hole
behind the window's first held segment is not emitted. The window budgets the gap lines against
`LIVE_WINDOW_MAX_BYTES` too, and a hole too wide to afford stops the window at it rather than pushing
the published manifest past one bee chunk.

⭐ `#EXT-X-VERSION` stays at 3. RFC 8216bis §8 lists no minimum protocol version for `#EXT-X-GAP`.

### A gap in the engine's numbering is a loss nobody reported

⛔ **SRS posts each closed segment to `on_hls` once and never retries.** So every segment it closed
while this service was down or unreachable is simply gone, and nothing tells the uploader: the OME
puller is what calls `handleSegmentLoss`, and the SRS path only calls it for a segment it delivered
and had refused. Left unnoticed, the loss is never counted, never reaches the health signal and
never reaches an operator.

`StreamOrchestrator` therefore keeps the last index it accounted for per stream, and a segment
arriving more than one above it is a skip. The indexes in between that its duplicate filter does not
hold are the loss: they are counted into `swarm_hls_segments_lost_total`, they set the
`segment_loss` health signal, and their sequences stay empty so the playlist lists them as gap
entries.

⚠️ **Three things it does not do.** It does not report a hole the engine already reported, because a
reported loss moves the accounting too, so one hole is announced once on OME as well. It does not read
the engine's counter going backwards as a hole, which is the restart above. And a session recovered
from an entry holding no segments infers nothing on its first arrival, because a broadcast opens at
whatever number a warm engine's counter is on and there is nothing to measure a hole from.

⚠️ **A stamp costs the live window about 50 bytes per segment.** The window is a byte budget against
one bee chunk (`LIVE_WINDOW_MAX_BYTES`), so it now holds roughly 30 segments where it held about 50,
which at `HLS_FRAGMENT=1.0` is still well past both the engine's own `HLS_WINDOW` and the player's
`liveSyncDuration`.

### After an engine restart the dating re-anchors on the clock

⛔ **Owner decision of 2026-09-03.** The dating used to be one instant for the whole broadcast, so
the media after an engine restart carried a time behind real time by the whole length of the gap,
and nothing bounded that. A broadcast's dating is a list of epochs now, in `BroadcastAnchor.epochs`:

- The media published before the restart keeps the dates it went out with. Those segments are in a
  window a viewer is holding, and re-dating them would move media that has already been served.
- The first segment after the restart is dated at the wall clock it arrived at, and the segments
  after it carry on from the media each one holds.
- The first segment placed at or above an epoch's `fromSequence` takes that epoch's instant, under
  the newest epoch that reaches it. The broadcast's start is the implicit first epoch.

⛔ **The re-anchoring is minted once for the whole ladder**, by whichever rung crosses the restart
first, and every other rung lands on that same line rather than taking its own reading of the clock.
Four rungs dating one segment four ways is the disagreement the tag is here to prevent: hls.js reads
it as the rungs covering different media, and a level switch lands somewhere else. A rung whose
numbering is one sequence behind its siblings when the engine dies therefore dates its own resuming
segment one fragment earlier on that shared line, which is the same function of sequence all four are
reading.

**How "the same restart" is recognised**, in `reanchorDecision` in `src/libs/broadcastDating.ts`: a rung
takes the line an earlier rung minted when that line still dates the rung's own resuming sequence
within two minutes of now. A sibling crossing the same restart is asking about a sequence within a
fragment or two of the one the line was minted at, so the line dates it within a fragment or two of
now. A second, later restart is asking about a sequence the line reaches only after an outage in
which no sequence advanced at all, so the line dates it that whole outage ago and a fresh epoch is
minted. That one test separates both cases, where a clock window alone cannot: an engine that comes
back, publishes two segments and dies again re-anchors twice within a couple of fragments of media.

The broadcast's own start is never reused, so the first restart of a broadcast always re-anchors. A
minted epoch is never dated before the segment in front of it either, which matters where the
nominal dating had run ahead of the wall clock: a stamp moving backwards is what hls.js reports as a
parsing error rather than as a restart.

**Every restart path re-anchors, and every reconnect does, not only the first of a broadcast.** An
encoder re-announcing a stream this service still holds resumes that session, so its epoch starts at
the sequence the numbering continues from; so does one re-announcing a session this service rebuilt
after its own crash, and so do segments resuming inside one session after the engine's counter
restarted. The one path that numbers from zero again is a session announced while a stop of that id is
still finalizing, which is a genuinely new broadcast and takes its epoch at sequence 0
(`StreamOrchestrator.reanchorReplacedBroadcast`). A single-rendition stream is a ladder of one and
behaves identically.

⛔ **The rungs of one ladder share a line because they share a RETURN, not because their numbers look
alike.** A whole-encoder outage stops all four transcoders, so each rung announces its return
separately, seconds apart; the orchestrator is the only layer that sees those four webhooks as one
event, so it names the return and every rung of it asks the dating with that name. A rung joins a line
when the line carries its own return's name, and mints one otherwise, whatever sequence either of them
is at. The name is a uuid rather than a count, because the epochs it labels ride in the recovery entry
and the ladder group store and so outlive the process.

Two sequence-shaped rules were tried before this one and both were wrong, which is worth knowing
before anyone simplifies it. Recognising a return by the clock alone read a second outage on the same
rung as a sibling crossing the first, because nothing advances while an encoder is away: four fifty
second outages dated the second return 48 seconds behind and the third 96. Keying on "at or below the
sequence the line was minted at" fixed that for a lone rendition and failed on a ladder, because the
epoch list belongs to the whole broadcast and its newest line is usually a sibling's — a rung one
segment behind then joined the previous return's line about half the time. The engine's own counter
restarting is a different cause with no witness outside the rung, and it is still judged by the
clock.

The epochs ride with the group in `state/ladder/groups.json` and with each rung's recovery entry, so
a crash after a restart comes back on the re-anchored dating rather than re-dating everything after
the gap. The recording is built from the same function as the live playlists, so it carries the same
dates.

⚠️ Nothing has measured what a player makes of the step across the break, which is the length of the
outage rather than a whole number of fragments. The harness contract allows a forward step of any
size there and refuses one that does not move forwards.

### One Bee node per rung

A feed's address is a pure function of its signing key and topic — `makeFeedIdentifier` is
`keccak256(topic ‖ index)`, and bee-js signs the single owner chunk locally before POSTing it. So a
Bee node owns nothing here; it is a pipe with a wallet, and which pipe carries which rung is a
routing decision that `BeePublisherPool` holds.

Set `BEE_PUBLISHERS` to split it (see [.env.sample](../../.env.sample)); unset, one node serves
everything, exactly as before. The reason to split is that postage batches drain in proportion to
bitrate — 1080p burns roughly 7× the bytes of 360p, so equal batches expire hours apart — and one
node per rung makes that "a rung goes quiet and ABR steps down" instead of "the stage stops".

Because nothing about a feed's address depends on the node, all four rungs still publish under one
signing key and therefore one owner. Rung feeds differ only by topic, and moving a feed to a
different node later changes nothing a viewer sees.

The catalog and every master playlist are written through **the lowest rung's node**: its batch
outlives the others by roughly 7×, and those two feeds are the only addresses a viewer needs to open
a stage. Riding them on the 1080p node would take discovery down first, while three rungs were still
publishing fine.

## Prerequisites

- Node.js 22+
- pnpm
- A running Swarm Bee node with a valid postage stamp (see `pnpm stamp:setup`)

## Getting Started

From the monorepo root:

```bash
# Install and build
pnpm install
pnpm build

# Create .env from sample (if not done yet)
cp .env.sample .env
# Edit .env — fill in STREAM_KEY, run `pnpm stamp:setup` for STAMP

# Start the uploader
pnpm uploader:start
```

The API server starts on port 3000 (default).

> **Note:** Both packages share a single `.env` file in the **monorepo root**. See [.env.sample](../../.env.sample) for all available variables.

## Environment Variables (in root `.env`)

**Required:**

| Variable            | Description                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BEE_URL`           | Bee node API URL                                                                                                                                                              |
| `STAMP`             | Postage stamp ID (`pnpm stamp:setup`). Required on a single-node deployment. With `BEE_PUBLISHERS` set it is optional and unread, since each rung's batch is in its own entry |
| `STREAM_KEY`        | Private key (hex) for signing feeds                                                                                                                                           |
| `STREAM_LIST_TOPIC` | Feed topic for the stream catalog                                                                                                                                             |
| `API_AUTH_TOKEN`    | Bearer token for `/stream/*` and `GET /metrics`, minimum 32 characters. `openssl rand -hex 32`                                                                                |

**Optional:**

| Variable                 | Default              | Description                                                                                                                                                                                                                                        |
| ------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BEE_PUBLISHERS`         | _(empty)_            | One Bee node and batch per rung as `rung@url<batch>`. Empty is one node for everything, see `.env.sample`                                                                                                                                          |
| `PUBLISH_KEY_SECRET`     | _(empty)_            | Master secret for per-stream publish keys, minimum 32 characters. Empty leaves publishers unauthenticated. See below                                                                                                                               |
| `API_PORT`               | `3000`               | HTTP API port                                                                                                                                                                                                                                      |
| `STATE_DIR`              | `./state`            | Directory for crash recovery state                                                                                                                                                                                                                 |
| `MAX_QUEUE_SIZE`         | `100`                | Max queued segments per stream                                                                                                                                                                                                                     |
| `RECOVERY_TIMEOUT`       | `60000`              | Crash recovery timeout (ms)                                                                                                                                                                                                                        |
| `SEGMENT_STALL_MS`       | `30000`              | Silence after which `/health` reads degraded                                                                                                                                                                                                       |
| `ORPHAN_REAP_MS`         | `60000`              | Silence after which a live stream is finalized, and so the reconnect window                                                                                                                                                                        |
| `UPLOADER_START_GATES`   | `chequebook-warn`    | Which startup gate stops the boot, and on which reading. `chequebook-warn` warns on the chequebook and refuses on a postage batch the node answered about, warning on one it could not read at all. `warn` warns on both, `refuse` refuses on both |
| `START_GATE_TIMEOUT_MS`  | `20000`              | How long one startup gate's read of one node may take, 600000 at most. Separate from `BEE_REQUEST_TIMEOUT_MS`, which the upload loop derives                                                                                                       |
| `CHEQUEBOOK_MIN_BZZ`     | `0.5`                | Available chequebook balance every node must hold for the chequebook gate to call it funded, 1000 at most                                                                                                                                          |
| `CHEQUEBOOK_RECHECK_MS`  | `60000`              | How long to wait between reads of a chequebook the boot warned about, 1000 to 3600000. The warning leaves `/health` on the first read that finds every node funded, and nothing is read while no chequebook warning stands                         |
| `STAMP_MIN_TTL_HOURS`    | `12`                 | Hours a postage batch must have left for the postage gate to call it usable                                                                                                                                                                        |
| `STAMP_MAX_UTILIZATION`  | `0.9`                | How full an immutable batch may be, as a ratio, for the postage gate to call it usable. A mutable batch overwrites its oldest chunks when full rather than refusing, so it is never held to this                                                   |
| `BEE_REQUEST_TIMEOUT_MS` | `4000`               | Per-request deadline on every upload-loop call to a Bee node, derived from the retry windows                                                                                                                                                       |
| `HLS_FRAGMENT`           | `0.5`                | Nominal seconds per fragment, the grid a segment's date snaps to within one percent. Same variable the engine reads                                                                                                                                |
| `SEGMENT_DEDUP_WINDOW`   | `10000`              | Segment indexes remembered per stream, twice this many held at most                                                                                                                                                                                |
| `SEGMENT_REDUNDANCY`     | `1`                  | Erasure-coding parity on segment uploads, `0` turns it off                                                                                                                                                                                         |
| `ENGINE`                 | _(empty)_            | Engine plugin to load (`srs`, `ome` or empty)                                                                                                                                                                                                      |
| `ABR_ENABLED`            | `false`              | Whether the engine publishes a ladder, read here to group the rungs                                                                                                                                                                                |
| `ABR_LADDER`             | the engine's default | The rungs, `name:width:height:kbps`, see `engines/srs/.env.sample`                                                                                                                                                                                 |
| `ABR_VHOST`              | `abr`                | The vhost rungs arrive on                                                                                                                                                                                                                          |
| `ADMIN_API_URL`          | _(empty)_            | Admin service base URL. Setting it turns on admin mode. See below                                                                                                                                                                                  |
| `ADMIN_API_TOKEN`        | _(empty)_            | Bearer token for the admin's internal routes, minimum 32 characters. Required when `ADMIN_API_URL` is set                                                                                                                                          |
| `LOG_LEVEL`              | `debug`              | `debug`, `log`, `info`, `warn`, `error` or `silent`. `log` is per segment, `info` is per lifecycle event                                                                                                                                           |
| `LOG_FORMAT`             | _(empty)_            | `json` for one `{ts, level, msg}` object per line. Anything else keeps the readable format                                                                                                                                                         |

Admin mode changes who owns the stream catalog. It does not change the uploader's Bee startup
requirements. `BEE_URL`, `STREAM_KEY`, `STREAM_LIST_TOPIC` and `API_AUTH_TOKEN` remain required.
`STAMP` remains conditional on `BEE_PUBLISHERS`. Once `ADMIN_API_URL` is set,
`ADMIN_API_TOKEN` is required as well.

Engine-specific variables (e.g. `SRS_MEDIA_PATH` for SRS, `OME_*` for OME) live in `engines/<name>/.env` and are loaded only when that engine is selected via `ENGINE`. Copy the sample next to each engine to get started: [engines/srs/.env.sample](../../engines/srs/.env.sample), [engines/ome/.env.sample](../../engines/ome/.env.sample). Values in the root `.env` (or injected container env) take precedence over the engine file.

## API

### Generic API

Engine-independent HTTP interface for pushing segments directly.

| Endpoint               | Method                               | Description                                       |
| ---------------------- | ------------------------------------ | ------------------------------------------------- |
| `POST /stream/start`   | JSON body: `{ streamId, mediatype }` | Register a new stream                             |
| `POST /stream/segment` | Raw body + headers                   | Push a segment. `400` on an unusable `x-duration` |
| `POST /stream/stop`    | JSON body: `{ streamId }`            | End a stream, answered `202`                      |
| `GET /stream/status`   | Query: `?streamId=<id>`              | What became of a stream                           |
| `GET /metrics`         | —                                    | Prometheus exposition                             |
| `GET /health`          | —                                    | Service health, `200` ok or `503` degraded        |

All four `/stream/*` routes and `GET /metrics` require `Authorization: Bearer $API_AUTH_TOKEN`, checked in constant time before the body is parsed, so an unauthenticated request neither reaches the orchestrator nor costs the process a buffered body. `GET /health` is deliberately outside the gate: it is a liveness endpoint that accepts no input and spends nothing, and both the `stream-uploader` compose healthcheck and `deploy/scripts/health.sh` read it unauthenticated.

The `/engines/*` webhook routes are **not** behind this gate, because each carries its own. OME admission is verified by HMAC signature, and the two SRS routes by `SRS_WEBHOOK_TOKEN` in the hook URL, which is the only channel SRS 6 offers. Both fail closed on an empty secret rather than disabling the check. This paragraph described `POST /engines/srs/hls` as reachable by an anonymous caller until S1.2 closed it, and the gate on this pull request measured every shape of both routes answering 401 with the orchestrator untouched.

**Something reads `/health`.** The `stream-uploader` service declares a compose healthcheck that polls
it every 30 seconds and treats the `503` of a degraded service as a failure, so `docker ps` shows
`(unhealthy)` after three consecutive ones. Before that, every `503` this endpoint could raise was a
value in a response body nobody requested.

It reports and does not act, on purpose. Compose does not restart a container for failing its
healthcheck, and nothing declares `depends_on: condition: service_healthy`. Restarting on degraded
would be the wrong response anyway: most reasons describe media already lost or state already
unwritten, and a restart drops every live broadcast to re-run a recovery that changes none of it.

**Metrics.** `GET /metrics` serves Prometheus text exposition. These are process-lifetime totals and
they deliberately outlive the streams they count, which is the one thing `/health` structurally cannot
do: `/health` describes the streams registered right now, so at the moment a live session is wrongly
killed it answers `ok` with `activeStreams: 0`.

| Metric                                      | Type    | Meaning                                                     |
| ------------------------------------------- | ------- | ----------------------------------------------------------- |
| `swarm_hls_segments_uploaded_total`         | counter | Segments whose payload reached Swarm                        |
| `swarm_hls_rung_segments_uploaded_total`    | counter | The same, by ABR rung. Empty with no ladder, see below      |
| `swarm_hls_segments_dropped_total`          | counter | Segments never stored: window spent, or bee refused it      |
| `swarm_hls_rung_segments_dropped_total`     | counter | The same, by ABR rung. Empty with no ladder, see below      |
| `swarm_hls_segments_lost_total`             | counter | Segments the engine never obtained, or never posted at all  |
| `swarm_hls_segments_skipped_total`          | counter | Segments discarded on purpose at a puller handover          |
| `swarm_hls_opening_segments_withheld_total` | counter | Opening segments held back until the broadcast showed video |
| `swarm_hls_segments_never_named_total`      | counter | Segments in Swarm that no published manifest named          |
| `swarm_hls_auth_rejections_total`           | counter | Requests refused by a credential gate                       |
| `swarm_hls_takeovers_refused_total`         | counter | Announces refused because a live session still holds the id |
| `swarm_hls_manifest_publish_failures_total` | counter | Live manifest publishes that failed                         |
| `swarm_hls_streams_finalized_total`         | counter | Stops that published a VOD                                  |
| `swarm_hls_streams_failed_total`            | counter | Stops that did not. Those broadcasts have no recording      |
| `swarm_hls_streams_reaped_total`            | counter | Broadcasts finalized because their engine went silent       |
| `swarm_hls_segment_durations_unread_total`  | counter | Segments published on the engine's word, unreadable here    |
| `swarm_hls_postage_refused_publishers`      | gauge   | Rungs whose postage batch bee has refused. Never clears     |
| `swarm_hls_last_segment_timestamp_seconds`  | gauge   | Unix time of the newest segment that landed, 0 while none   |
| `swarm_hls_active_streams`                  | gauge   | Streams registered and expected to be producing             |
| `swarm_hls_queue_depth`                     | gauge   | Segments waiting to upload across every stream              |
| `swarm_hls_queue_backlog_seconds`           | gauge   | Playing time still queued for the worst stream              |

**The per-rung breakdowns are empty on a single-rendition deployment, and that is not zero uploads.** A
stream with no ABR ladder has no rung to attribute a segment to, so it is counted in
`swarm_hls_segments_uploaded_total` alone. The two therefore do not have to sum, and both can be live
at once: a ladder broadcast and a single-rendition one running together contribute to the total, and
only the first to the breakdown. Difference two scrapes to get a rate. Each rung needs
`1 / HLS_FRAGMENT` uploads a second and the ladder needs `rungs / HLS_FRAGMENT` between them, so
1.00 each and 4.00 total at the 1.0s a four-rung ladder runs.

**`swarm_hls_rung_segments_dropped_total` is the same breakdown for what a rung lost**, and it is read
against the uploads on the same label. Each rung publishes through its own bee with its own prepaid
postage batch, so a batch that runs out stops that rung and leaves the other three publishing: one
rung's drops climbing while its uploads slow down is that batch, and the uploader writes one
`Postage batch <id> of <stream> refused by bee (<status> <message>), the rung thins out as the batch
fills and this is the first refusal bee answered with this status` line at error level naming it.
Once per answer bee gives, per stream, for the life of the process, so a status bee has not answered
with before gets a line of its own and a reader counting these is not counting drained rungs. Never
re-armed by a segment that lands, because a batch that is filling refuses a growing share of
segments rather than all of them: measured live on 2026-09-04, four refusals in about fifty seconds
with segments landing in between. Which batch a rung spends is read once at start, so only a redeploy replaces it
and a redeploy is a new process. `swarm_hls_segments_dropped_total` climbs the same whether one rung
of four lost everything or all four lost a little, which is what the breakdown separates.

⭐⭐⭐ **One rung reading zero while the others hold is the signature to watch for**, and it is
invisible in `swarm_hls_segments_uploaded_total`. It means SRS is deleting that rung's segments
before it announces them, because the ladder is asking for more announcements a second than SRS can
deliver. That is why the ladder runs at 1.0s and not the 0.5s the gateway path measures best at. See
the block above `HLS_FRAGMENT` in `engines/srs/entrypoint.sh`.

**Who may take a stream id that is already live.** An announce for an id a live session holds is
refused when both publisher addresses are known and different and something is still publishing into
it. Everything else is allowed, because not every engine reports a publisher address and a missing
field must not take a broadcaster off the air. A stream nothing has published into for
`SEGMENT_STALL_MS` can be claimed by anyone, which is what stops a refusal being permanent.

Two consequences worth knowing before you deploy it.

The guard is symmetric, so **it protects whoever got there first**. Someone who claims a stream id
before your broadcaster does, and keeps feeding it, holds it: your broadcaster is refused for as long
as that continues. `POST /stream/stop` on the id is the operator override, and it is authenticated.
The complete answer is a publish credential the broadcaster presents to the engine, which neither
engine is configured for here.

An attacker who publishes from the same address as your broadcaster is not distinguished from them.
The same host, the same NAT and one shared VPN egress all produce that.

`swarm_hls_takeovers_refused_total` counts every refusal, and it **cannot tell those cases apart**:
an attack and a locked-out broadcaster produce the identical count. Read it as a reason to check who
holds the stream, not as a verdict.

Unlike `/health`, `/metrics` is behind the bearer gate, and the honest reason is narrower than it first
looks: `/health` already discloses `activeStreams`, `queuePressure` and `msSinceStreamActivity` to anyone
who asks, so the gate is really protecting the fifteen process-lifetime counters, which say how many
broadcasts have run, how many were lost, and how many requests this deployment turned away. Point a scraper at it
with an `authorization` credential:

```yaml
# `stream-uploader:3000` is the default only. `API_PORT` sets both sides of the compose port map,
# and `deploy.sh --portSlot` shifts it, so a second instance listens on 10010 rather than 3000.
scrape_configs:
  - job_name: swarm-hls-stream
    authorization:
      credentials: <API_AUTH_TOKEN>
    static_configs:
      - targets: ['stream-uploader:3000']
```

**Stop is asynchronous.** `POST /stream/stop` answers `202` with `{ ok, accepted, streamId, statusUrl }`
and drains in the background, because a drain has five minutes to publish its VOD and no media server
will hold a webhook open that long. The outcome is read from `GET /stream/status?streamId=<id>`, which
answers one of:

| `state`     | Meaning                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| `live`      | Registered and accepting segments                                                          |
| `draining`  | Stopping, the VOD has not settled yet                                                      |
| `finalized` | The VOD manifest was committed and the catalog entry published                             |
| `failed`    | The finalize did not complete, with a `reason`. There is no VOD, and no retry is scheduled |

A stream the service has never seen, or one whose stop settled more than fifteen minutes ago, answers
`404` rather than a state, so a caller polling a mistyped id is not told its broadcast is fine.

**A finalize that resumes after a crash publishes nothing twice.** `finalize` writes the closing
playlist, then the VOD manifest, then the catalog entry, and deletes the recovery entry last of all,
so a crash between the recording and the catalog leaves a recording that is already bought under an
entry still saying the broadcast is recoverable. A recovered session therefore reads the head of its
own manifest feed first, which is a retrieval and costs no postage: finding its finished recording
there it logs `Resuming the finalize of <stream> at the catalog write`, publishes nothing, and
completes only the catalog write and the entry delete. A head that did not read is not taken for an
empty feed, so the finalize is deferred to the next boot rather than risking a second recording.

**Health status:** `GET /health` answers `200` with `status: "ok"`, or `503` with `status: "degraded"` or
`status: "waiting_for_node"` and a `reasons` array:

| Reason                   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `segment_upload_failure` | A segment reached the uploader and was never stored, either because its upload retry window was spent or because bee refused it with a status the uploader does not retry, which is a postage batch filling up, so that data is gone                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `segment_loss`           | A segment never reached the uploader: the engine could not obtain it from its origin, or it skipped the index and never posted it at all. Stays reported for `SEGMENT_STALL_MS` after the loss, because a loss is permanent and the stream usually keeps flowing around it                                                                                                                                                                                                                                                                                                                                                                                                                |
| `stale_manifest`         | Three consecutive live-manifest publish failures, so the live playlist is not moving                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `queue_pressure`         | Either a segment queue above 80% of `MAX_QUEUE_SIZE`, where the next segments start being refused, or a backlog holding more than `SEGMENT_STALL_MS` of playing time, which is how far behind live a viewer is                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `segment_stall`          | A stream that should be producing has sent nothing for `SEGMENT_STALL_MS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `unlisted_stream`        | A live stream is absent from the catalog, so no viewer can find it. Reported from the first failed announce, with no threshold, because `StreamCatalog` has already spent its own 10 second retry window by then                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `state_not_persisted`    | A write into `STATE_DIR` is failing, so the next restart resumes a stream from stale segments or the catalog feed from an index readers have already passed. Nothing is wrong with the running process, which is why it needs saying                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ingest_refused`         | A credential gate has turned a request away and no segment has ever reached Swarm in this process's lifetime, which is what a wrong `SRS_WEBHOOK_TOKEN` or `OME_ADMISSION_SECRET` looks like from startup: no stream registers, so every counter stays at zero and no threshold above can be reached. The only reason about the media that can fire while nothing is registered, since `node_unavailable` and `start_gate_warned` are about the boot rather than about a stream. Latched until the first segment lands rather than aged out, because on a service that has never ingested anything a window would let exactly that case fade back to `ok` between a broadcaster's retries |
| `unrecoverable_stream`   | A recovery entry could not be parsed at boot, so a broadcast that was live when this service last died cannot be finalized: its recording stays unsealed and its catalog entry says `live`. The entry is kept as `<id>.json.corrupt` for repair rather than deleted. Latched for the life of the process, since only an operator clears it                                                                                                                                                                                                                                                                                                                                                |
| `fragment_mismatch`      | A rung's segments are not the length `HLS_FRAGMENT` says they are. The dating follows the media, so the recording keeps the right clock, but the declared length is what every `#EXT-X-GAP` entry is dated and sized at and what the rung GOP is pinned on, so a lost segment leaves a hole of the wrong size on a stage that is not what its configuration says. Raised only under `ABR_ENABLED`, once eight measured segments of a stream miss the configured length by over 5%. One of the two containers is running an older deploy, so redeploy the stale one                                                                                                                        |
| `fragment_publisher_gop` | Segments longer than `HLS_FRAGMENT` with no ladder running. Nothing transcodes there, so the publisher's own keyframe interval decides the segment and the configured value is a floor. Raised once eight measured segments run over it by over 5%. Nothing is stale, and the dating follows the media so the recording's clock stays right. What it names is a stage cutting longer than the deployment declared, with the same wrong-sized gap entries as the row above: set `HLS_FRAGMENT` to the publisher's keyframe interval, or turn the ladder on                                                                                                                                 |
| `postage_refused`        | Bee refused a paid write on a rung's postage batch with a status nothing retries, usually because the batch has filled or expired. Latched for the life of the process and never cleared by a segment that lands, because the batch a rung spends is read once at start: only a restart clears it, so redeploy once the batch pays again, a new batch or the same one diluted or topped up                                                                                                                                                                                                                                                                                                |
| `node_unavailable`       | The boot has not finished, because the half of it that needs a Bee node is still waiting for one to answer. The only reason that is not a reading about this process at all, and the only one reported alone by construction: the waiting branch returns it before any other signal is looked at. See the waiting state below                                                                                                                                                                                                                                                                                                                                                             |
| `start_gate_warned`      | A startup gate could not clear a node and the uploader started anyway, which is what `UPLOADER_START_GATES` asks for on that gate. Latched from the pass that finished the boot, and `startGateWarnings` on the same body names which gate and which rung. A postage warning stays until a restart. A chequebook warning is read again every `CHEQUEBOOK_RECHECK_MS` and goes by itself once every node holds its floor. The gate's own message is in the log and deliberately not here: this endpoint takes no credential and those messages carry node URLs and batch ids                                                                                                               |

**The waiting state, `status: "waiting_for_node"`** (decision D16, the owner on 2026-09-17: "we should be
able to start the uploader but maybe say its node not available, try to reconnect or something"). The API
server listens before anything reads a Bee node, so `/health` answers from the first second of the
process. While the node-dependent half of the boot has not finished, that answer is `503` with
`status: "waiting_for_node"`, the single reason `node_unavailable`, a `waitingSince` timestamp for the
whole wait rather than the current attempt, and a `node` object carrying `url`, `attempts` and, once
something has failed, `lastError`. No other reason is reported beside it: nothing has run, so every
signal on the body is the zero it was initialised with and reading one as health would be wrong in the
direction nobody checks.

What the service is doing meanwhile is in `libs/NodeWait.ts`: a liveness check of the coordinator, then
the two start gates, the catalog feed lookup and the recovery pass, retried with one log line per
attempt, backing off from 1s, doubling, and holding at 30s, for as long as the node takes. The liveness
check is first so that a node which is not there costs one question rather than both gates' budgets,
and so that nothing further down has to tell "this feed is empty" apart from "this node cannot say". A failure that says the node is not answering is waited on. A
failure that says anything else, a feed whose payload will not parse or a key this deployment cannot
sign with, still ends the boot with exit 1, because waiting on those is a service that never starts and
never says why. Before this the whole boot ran ahead of the listener, so a node that was not there meant
nothing answered at all, the container exited, and a deploy refused on a restart count that was climbing
for a reason nothing about this service could fix.

While it waits, `/stream/*` and every engine prefix answer `503` naming the node, with `Retry-After: 5`,
rather than reaching an orchestrator whose catalog has never been read. `/metrics` keeps answering,
since its counters describe this process and not the node.

**What a warned gate leaves behind.** A gate that warns reads every node rather than stopping at the
first that refuses, so one boot names every rung an operator has to fix rather than one per restart,
and the outcome of the pass that finished the boot is latched into `startGateWarnings`. Under the
shipped `chequebook-warn` that is the chequebook gate, and the postage gate on a batch it could not
read at all: a batch the node answered about and the gate will not accept still ends the boot,
because every write against it fails while the broadcast looks live to the room, the viewer and the
catalog, while a rung whose node answered nothing has said nothing about any batch. That second half
is the owner's decision 7 b of 2026-09-17. The
service is degraded from then on, which is what the container's healthcheck reads and what
`deploy/scripts/assert-started.sh` reports. A later pass replaces an earlier one, because the gates
are read again on every attempt while the uploader waits for its node and only the last of those
describes the service that is now running.

`segment_stall` is measured per stream and reported for the worst one, so a busy stream does not mask a dead
one. A draining stream and a stream awaiting a post-crash reconnect are both excluded, because neither is
expected to be sending. The route spreads the whole signal set rather than picking from it, so every
reading a reason above is derived from is on the same body: `activeStreams`, `staleManifestStreams`,
`maxConsecutiveManifestFailures`, `maxConsecutiveSegmentFailures`, `queuePressure`, `msSinceStreamActivity`,
`msSinceSegmentLoss`, `msSinceCatalogAnnounceFailed`, `msSinceStatePersistFailed`, `queueBacklogSeconds`,
`msSinceAuthRejection`, `disconnectedStreams`, `hasIngestedMedia`, `segmentsSkipped`, `openingSegmentsWithheld`,
`segmentsNeverNamed`, `quarantinedRecoveryEntries`, `fragmentMismatchStreams`, `publisherGopStreams`,
`postageRefusedPublishers`, `startGateWarnings`, `publishers`, `refusedPublishers` and `engines`. `disconnectedStreams`
names every live stream whose encoder has gone and has not come back, and raises no reason of its own:
a disconnect is held for one reap window on purpose, so flagging it would turn every ten second OBS
restart into `degraded`, while one that never returns already reaches `segment_stall` on the ordinary
clock. It is a list rather than a count because on a ladder all four rungs appear together for a
whole-encoder outage and one rung alone is a dead transcoder, which is a different fault.
`queueBacklogSeconds` is the
only field that says which of `queue_pressure`'s two triggers fired. `msSinceAuthRejection` beside
`hasIngestedMedia` is the pair `ingest_refused` is read off, which is what tells a deployment that has
never worked apart from one whose broadcaster mistyped a key once. `publisherGopStreams` names every
stream behind `fragment_publisher_gop`, each with `configuredSeconds` beside `measuredSeconds`, because
how far apart the two are is what decides whether to move `HLS_FRAGMENT` or to turn the ladder on.

**Neither fragment reason is a brake.** Nothing either of them raises changes a date, refuses a segment or
ends a broadcast. They report a stage cutting a length the deployment never declared, which is a repair an
operator makes on the stage rather than anything this process can do about the media already published.

**`segment_upload_failure` and `postage_refused` answer different questions and both are needed.** The
first is a consecutive counter over the streams registered right now, so it clears on the next segment
that lands and it disappears entirely when the broadcast ends. A filling batch refuses only the chunks
whose own bucket is full, so it loses a growing share of segments over a minute or two rather than all
of them at once, which made that counter flap. A batch that was dead when the broadcast stopped then
took the last alarm with it, while the finalize failed on that same batch, no recording was published
and the catalog went on saying `live`. `postage_refused` is a fact about a node and a batch id rather
than about a broadcast, so it survives the stream that found it.

**`refusedPublishers` on the same body says which rung**, because on a four rung ladder the reason on
its own leaves four batches to go and read, and each one is bought and topped up separately. Each
entry is that rung's line out of the `publishers` block, the node url minus any credential and the
batch id truncated, plus `statuses`, every distinct status bee answered with on it, and
`firstRefusedAt`, the epoch milliseconds of the first one, which is what dates it against the
`Postage batch … refused by bee` lines in the log. Empty on a healthy service.

**Segment headers:**

- `x-stream-id` — Stream identifier
- `x-segment-index` — Segment sequence number
- `x-duration` — Segment duration in seconds

**Error responses:**

- `429`: queue full, retry after the `Retry-After` header
- `404`: unknown stream
- `400`: missing required fields, or an `x-duration` that is not a usable segment length
- `409`: another session holds the id on `POST /stream/start`, or the stream is finalizing and accepts
  no more segments on `POST /stream/segment`. No retry of either can succeed
- `401`: a missing or wrong bearer token, on any `/stream/*` route and on `GET /metrics`

A segment whose index this stream has already taken is **not** in that list. It is answered
`200 {ok: true, queued: true}` and nothing is queued, which is what makes a sender's own retry after
a network timeout safe. A caller counting what reached Swarm from its own `200`s therefore counts
every retry, and the service's `swarm_hls_segments_uploaded_total` is the number that does not.

## Engine Plugin Architecture

The uploader supports pluggable media server engines. Each engine implements the `EnginePlugin` interface:

```typescript
interface EnginePlugin {
  name: string;
  prefix: string;
  createRouter(streamOrchestrator: StreamOrchestrator): Router;
}
```

Engines are thin adapters that translate media server events into `StreamOrchestrator` calls. The generic API and engine routes coexist — both feed into the same orchestrator.

Each engine owns its configuration: a `create<Name>EngineFromEnv()` factory reads the engine's env vars, and `src/engines/registry.ts` maps the `ENGINE` value to that factory. To add an engine, create its module under `src/engines/`, register it in the registry, and add an `engines/<name>/.env.sample` with its variables — the uploader loads `engines/<name>/.env` automatically when the engine is selected.

Currently supported: **SRS** (SRT/RTMP to HLS) and **OME** (OvenMediaEngine, MPEG-TS HLS).

## Supported Engines

Neither engine transcodes as this repository configures them. OME's output profile sets
`<Bypass>true</Bypass>` on both the video and the audio encode, and the SRS config carries no
`transcode` section at all, so both engines remux the broadcaster's own elementary streams into HLS
and the picture a viewer gets is the picture that was published. Changing the resolution or the
bitrate is therefore the broadcaster's to do, not the deployment's, which is the same fact
`docs/bench/profiles.md` records from the other direction.

### OME Engine - OvenMediaEngine :

When `ENGINE=ome`, webhook endpoints are mounted:

| Endpoint                      | Description                           |
| ----------------------------- | ------------------------------------- |
| `POST /engines/ome/admission` | Publish start and stop, HMAC-verified |

1. **Ingest** — broadcaster pushes SRT into OvenMediaEngine, which remuxes it into MPEG-TS HLS.
2. **Admission** — OME calls the `/engines/ome/admission` webhook on publish start/stop; the uploader verifies the HMAC signature and starts/stops the stream.
3. **Pull** — an `HlsPuller` polls `{app}/{stream}/ts:playlist.m3u8` and fetches new segments over HTTP (one
   puller per stream). That is OME's **MPEG-TS** playlist, not its fMP4 one, so the segments are
   `.ts` and nothing downstream ever sees LL-HLS.
4. **Upload** — the orchestrator uploads segments to Swarm, updates the live manifest feed (SOC), and finalizes a VOD manifest + catalog entry on stop.

### SRS Engine

When `ENGINE=srs`, SRS webhook endpoints are mounted:

| Endpoint                    | Description                                    |
| --------------------------- | ---------------------------------------------- |
| `POST /engines/srs/streams` | Handles `on_publish` / `on_unpublish` webhooks |
| `POST /engines/srs/hls`     | Handles `on_hls` webhook (new segment ready)   |

SRS writes segments to the shared media volume. The uploader reads segments from disk, uploads to Swarm, and deletes the file after upload.

## Publisher Authentication

Without `PUBLISH_KEY_SECRET`, anyone who can reach the engine can publish under any stream name, and
the name is public because it is in every HLS URL. Ownership of a live stream id is then decided only
by the address the engine reports, which cannot separate two publishers behind one egress address and
wrongly separates one publisher whose address moved.

Setting `PUBLISH_KEY_SECRET` turns on a per-stream publish key. It is derived from the secret and the
stream id, so a broadcaster's key authorises their stream and no other, and a leaked key is one
compromised broadcast rather than the run of the deployment.

```bash
# Generate the secret once, put it in the root .env, and redeploy the stream-uploader.
openssl rand -hex 32

# Then issue a key per stream. It prints the publish URL for both engines.
./deploy/scripts/publish-key.sh video/demo
```

**Turning it on refuses every publisher that does not present a key**, so issue the keys before
setting the secret. With it set, an announce carrying a valid key takes its stream id back
immediately from any address, and an announce without one can never take a stream whose owner proved
the key, however long that stream has been quiet.

The key travels as a `key` query parameter, which was measured on `ossrs/srs:6` and
`airensoft/ovenmediaengine:latest` rather than read off their documentation:

| Publish path | Where the key goes                                                          |
| ------------ | --------------------------------------------------------------------------- |
| SRS, RTMP    | `rtmp://<host>:<SRS_RTMP_PORT>/video/demo?key=<key>`                        |
| SRS, SRT     | `srt://<host>:<SRS_SRT_PORT>?streamid=#!::r=video/demo?key=<key>,m=publish` |
| OME, SRT     | `srt://<host>:<OME_SRT_PORT>?streamid=<percent-encoded publish url>`        |

**Take the ports from `publish-key.sh` rather than from here.** At slot 0 SRS uses the stock 1935
(RTMP) and 10080 (SRT), but `--portSlot N` shifts every host port into a per-slot band in the
10000-19999 range instead of using those, and `engines/ome/.env.sample` sets `OME_SRT_PORT=10081` so
OME's SRT does not collide with SRS's. The script resolves them the same way the deploy does, so what
it prints is what the deployment is actually listening on.

OME's streamid has to be percent-encoded, because the key sits inside a value that is itself inside a
query and the publisher's own URL parser otherwise splits on the inner `?`. `publish-key.sh` prints
the encoded form.

Rotating `PUBLISH_KEY_SECRET` invalidates every key at once. There is no per-stream revocation, which
is the price of deriving keys instead of storing them.

## Admin mode

Setting `ADMIN_API_URL` — and nothing else — turns admin mode on. Leave it empty and nothing about
this service changes.

With it set, a stream must be **declared in the admin before anything may publish to it**. The admin
mints the feed topic and the publish key; this service stops deciding either:

| Without `ADMIN_API_URL`                            | With it                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| Any publisher with the right derived key may start | Only an ingest id the admin has declared, presenting that declaration's key   |
| A lone rendition mints a random feed topic         | A lone rendition publishes on the declared topic, resuming from its feed head |
| This service writes the Swarm stream catalog       | It writes none, and reports `live` then `vod` to the admin instead            |
| `PUBLISH_KEY_SECRET` authenticates publishers      | `PUBLISH_KEY_SECRET` is ignored                                               |
| A ladder merges its rungs in the catalog feed      | The admin merges them, and the declared topic is the ladder's master feed     |

A publish is refused when the ingest `app/stream` is not declared, when the admin cannot be reached,
when the presented `key=` is not the declaration's, when the declaration is owned by a feed key this
service does not sign with, or when the ingest `app` and the declared media type disagree. Each
refusal says which it was in the log.

Both services have to sign as one owner. The admin's catalog entry points a viewer at `owner/topic`,
and every feed this service writes at that topic is signed with `STREAM_KEY`, so the admin's
`FEED_PRIVATE_KEY` must derive the same address or the entry resolves a feed nobody wrote — while every
report answers 200 and nothing says so. Nothing on the wire carries a key, so the address is what is
compared: once at boot, off the admin's public `/api/config`, where a mismatch refuses to start and an
admin that cannot be reached yet only warns; and again on every publish, against the declaration's
`owner`.

| Variable          | Description                                                                        |
| ----------------- | ---------------------------------------------------------------------------------- |
| `ADMIN_API_URL`   | Base URL of the admin service. Empty (the default) is the standalone deployment    |
| `ADMIN_API_TOKEN` | Bearer token for the admin's internal routes. Required when the URL is set, min 32 |

### The ABR ladder in admin mode

`ABR_ENABLED` and `ADMIN_API_URL` run together, and what reconciles them is that **the declared topic
becomes the ladder's master playlist feed**. It has to be: the master's feed topic is the group id,
and the declared topic is the one address the admin hands a viewer before anything has published.

Everything else follows. Each rung publishes its own media playlists on a topic **derived from the
group and its rung name** — four rungs sharing the master's feed would write over each other and over
the master, and a rung's feed has to be found again by name after a restart rather than re-minted.
That topic is stable for the life of the declaration, so a rung that restarts continues the same feed
above its own last session's head, and the recording it finalizes opens with the one that was already
there — so the entry the admin holds points at a recording of the whole broadcast, seams marked,
however many times it was restarted. **The admin therefore accepts `live` after `vod`**: a
broadcaster who stops and comes back is
a stream going live again under a declaration the admin already holds as a recording. (That admin
change ships from the `feat/ladder-feed-sessions` branch of the streaming-monorepo repository.)

The ladder's merge state, one record per rung, moves out of the catalog feed and into the admin: each rung posts its own
`Rendition` to `POST /api/internal/streams/:id/renditions` (bearer `ADMIN_API_TOKEN`, the same
internal-route auth as the state route, and **the admin must serve it**), the admin merges it by the
same "a rung that has already finished stays finished" rule `StreamCatalog.keepingWhatFinished`
states — additionally requiring the report to name the rung's own feed, which is true of every
report a well-formed ladder sends — writes `renditions` into the catalog entry it already owns, and
answers with the merged ladder. The uploader writes the master from that answer, filtered by the same `LadderLiveness` rule
as ever, and rewrites it when a rung stops without asking the admin again. Answers are applied in the
order the admin merged them, by the catalog write index each one carries, so four rungs whose answers
land out of order cannot leave an older merge on the master.

`live` and `vod` are then reported for the **ladder** rather than for a rung. `live` goes out once the
first master has landed, which may be said more than once and is accepted. `vod` goes out from the
rung whose own report finished the ladder, or from the failed stop of a rung that could not finish
when that is what finishes it. The admin cannot hold that a rung will not finish, because its
rendition route refuses fields it does not know, so this service judges such a ladder itself. Its
`index` is **the final master's index in the
declared topic's feed** — never a rung's own VOD index, which names a position in a feed no viewer
opens. Its `duration` is the ladder's. It is said again by any later announce that finds the ladder
finished while the admin still holds the stream as anything but `vod`: the admin answers the flip
once, and if the master write behind that one report failed, the next announce is the only chance
left to list the recording. `vod -> vod` is accepted, so the repeat is harmless.

Two things a declared stream does that a **standalone single-rendition** stream does not: resume its
SOC index and its media sequence from its topic's feed head, and hold its publishes for a re-announced
predecessor's drain. Both exist because two sessions share one feed there. A rung now owes both as
well, in either deployment, because its derived topic outlives its session in exactly the same way —
the standalone lone rendition, whose topic is a fresh uuid per session, is the only one that owes
neither. The master feed writer still establishes its own index.

### Local loop with the admin API

SRS in Docker, the uploader from source on the host. Run the admin API separately on `:9877`.

**1. SRS.** From `engines/srs`, with `.env` beside the compose file:

```bash
cd engines/srs
cp .env.sample .env
```

```ini
# engines/srs/.env — the values the local overlay needs
SRS_WEBHOOK_TOKEN=<same value the uploader gets>   # openssl rand -hex 32
SRT_PASSPHRASE=<10-79 chars, or empty for no SRT encryption>
SRS_ADAPTER_HOST=host.docker.internal              # the uploader is on the host, not in the network
SRS_ADAPTER_PORT=3000                              # must equal the uploader's API_PORT
SRS_RTMP_PORT=1935
SRS_SRT_PORT=10080
SRS_HTTP_PORT=8080
SRS_HTTP_API_PORT=1985
```

```bash
# The `local` overlay is the one for a uploader running natively: it points SRS's webhooks at
# host.docker.internal. `srs:host` puts the container on the host network instead, and the base file
# alone leaves the webhooks pointing at a `stream-uploader` container that is not running.
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
# or, from the monorepo root:  pnpm srs:local
docker compose logs -f
```

Published ports: `1935` RTMP, `10080/udp` SRT, `8080` HLS, `1985` SRS HTTP API. Each is published on
the same number it binds inside the container, so changing one in `.env` moves both sides together.

**2. The uploader**, from the monorepo root, with the root `.env` carrying:

```ini
BEE_URL=http://localhost:1633
STAMP=<batch id, pnpm stamp:setup>
STREAM_KEY=<32-byte hex private key>
STREAM_LIST_TOPIC=swarm-stream
API_AUTH_TOKEN=<min 32 chars>
STATE_DIR=./state
ENGINE=srs
API_PORT=3000
ADMIN_API_URL=http://localhost:9877
ADMIN_API_TOKEN=<min 32 chars, the admin's internal token>
```

`SRS_WEBHOOK_TOKEN` is read from `engines/srs/.env`, which the uploader loads because `ENGINE=srs`.
It has to be the same value on both sides.

```bash
pnpm install
pnpm --filter @swarm-hls-stream/stream-uploader build
pnpm --filter @swarm-hls-stream/stream-uploader start
```

The boot log says which mode it came up in: `[Admin] Admin mode against <url>` or `[Admin]
ADMIN_API_URL is not set, running standalone`.

**3. Declare the stream in the admin**, then push to the ingest id it filed the draft under. web2-admin
uses the stream's topic (a UUID) as `<stream>` and shows the finished URLs and key on the stream's
details page; `<app>` is `video` or `audio` and has to match the declaration's media type.

```bash
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine \
  -c:v libx264 -preset veryfast -g 60 -keyint_min 60 -c:a aac \
  -f flv "rtmp://localhost:1935/video/<stream>?key=<publishKey>"
```

SRT instead of RTMP, same key, inside the `r=` value:

```bash
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine \
  -c:v libx264 -preset veryfast -g 60 -keyint_min 60 -c:a aac \
  -f mpegts "srt://localhost:10080?streamid=#!::r=video/<stream>?key=<publishKey>,m=publish"
```

The same push from OBS (Settings → Stream, Service: **Custom...**):

| Field      | Value                         |
| ---------- | ----------------------------- |
| Server     | `rtmp://localhost:1935/video` |
| Stream Key | `<stream>?key=<publishKey>`   |

In Settings → Output, set Keyframe Interval to 2s (OBS's `0` lets the encoder choose, and the
segment length is `ceil(HLS_FRAGMENT / GOP) * GOP`, so an unknown GOP is an unknown segment length).
For SRT, Server is `srt://localhost:10080?streamid=#!::r=video/<stream>?key=<publishKey>,m=publish`
and Stream Key is left empty.

A refused publish is refused by SRS itself, so the encoder reports the connection as rejected. The
reason is in the uploader's log, never in the reply.

## Testing with FFmpeg

> **With `PUBLISH_KEY_SECRET` set these commands are refused**, because publisher authentication
> applies to them like any other publish. Append the stream's key inside the `r=` value:
> `streamid=#!::r=video/test?key=<key>,m=publish`, taking the key from
> `./deploy/scripts/publish-key.sh video/test`. The ports below are the upstream defaults rather than
> this repo's, for the same reason as the table above.

Video + audio test pattern (requires SRS running with `ENGINE=srs`):

```bash
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=1000 \
  -c:v libx264 -preset veryfast -g 45 -c:a aac -b:a 128k \
  -f mpegts "srt://localhost:10080?streamid=#!::r=video/test,m=publish"
```

Audio only:

```bash
ffmpeg -f avfoundation -i ":0" -ac 1 -c:a aac -b:a 128k \
  -f mpegts "srt://localhost:10080?streamid=#!::r=audio/test,m=publish"
```

Or push segments directly via the generic API (no engine needed):

```bash
# Start a stream
curl -X POST http://localhost:3000/stream/start \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"streamId": "test/mystream", "mediatype": "video"}'

# Push a segment
curl -X POST http://localhost:3000/stream/segment \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H 'x-stream-id: test/mystream' \
  -H 'x-segment-index: 0' \
  -H 'x-duration: 1.5' \
  --data-binary @segment-0.ts

# Stop the stream
curl -X POST http://localhost:3000/stream/stop \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"streamId": "test/mystream"}'

# The stop is accepted, not completed. Poll for what became of it.
curl -G http://localhost:3000/stream/status \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  --data-urlencode 'streamId=test/mystream'
```

## Core Components

| Module               | Description                                                                      |
| -------------------- | -------------------------------------------------------------------------------- |
| `StreamOrchestrator` | Central coordinator — manages stream lifecycle, queue, backpressure, recovery    |
| `StreamUploader`     | Per-stream upload session — uploads segments, updates manifests via Swarm feeds  |
| `StreamCatalog`      | Maintains the stream directory as a Swarm feed                                   |
| `RecoveryStore`      | Persists stream state to disk for crash recovery                                 |
| `ManifestManager`    | Builds and updates HLS manifests                                                 |
| `AbrLadder`          | The rung list from `ABR_LADDER`, and what maps a stream name back to its rung    |
| `BeePublisherPool`   | Which Bee node and postage batch each rung publishes through                     |
| `MasterPlaylist`     | Builds a ladder's multivariant playlist                                          |
| `MasterFeedWriter`   | Publishes that master to a feed per ladder, topic = the ladder's group id        |
| `BitrateMeter`       | Measures each rung's real bitrate, which becomes the master's `BANDWIDTH`        |
| `LadderLiveness`     | Which rungs are still producing, so the master stops advertising one that is not |

## Scripts

| Script           | Description                 |
| ---------------- | --------------------------- |
| `pnpm build`     | Compile TypeScript          |
| `pnpm start`     | Start the server            |
| `pnpm lint`      | Run ESLint                  |
| `pnpm typecheck` | Type check without emitting |
