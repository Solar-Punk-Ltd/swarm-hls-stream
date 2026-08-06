# Roadmap

**2026-08-05.** Ordered by what unblocks what, not by appeal. Every claim below is either measured and
linked, or marked as a guess. Items already tracked carry their task number.

## Where the product actually is

|                     | state                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine              | **SRS works.** OME is at **6 of 11** e2e and must not be called working.                                                                                                                                                                                                                                                                                          |
| LL-HLS              | **Not implemented and not configured.** `OmeHlsPuller` reads `ts:playlist.m3u8`, OME's MPEG-TS playlist. No `<LLHLS>` publisher exists in `Server.xml.template`. Neither engine transcodes: both set bypass and remux the broadcaster's own streams.                                                                                                              |
| Live latency        | **1.074s** capture-to-fetchable at 720p 2500kbps, 0.25s GOP, [gated over three 10-minute runs](../bench/ten-minute-gate-2026-08-05.md) with a 29ms spread and no drift. ✅ **Glass to glass at a viewer is 6.4 to 7.3s and flat**, read off a burned-in clock, [after the client fix](../bench/the-loop-fixed-2026-08-05.md). It was 17.9s and growing before it. |
| What a viewer sees  | ✅ **1.000 and 1.003 media seconds per wall second at 0.25s, nothing frozen, no rebuffers**, holding 5.86s behind live against a 6s target. It was 0.82x and 17.3% frozen: the client took one feed slot per playlist reload. [Fixed and measured](../bench/the-loop-fixed-2026-08-05.md), [diagnosed](../bench/what-starves-the-viewer-2026-08-05.md).           |
| Which profile ships | ✅ **0.25s GOP.** The morning's "ship 1.0s" is reversed: its whole reason was 7x the freezing, and the freezing was the client. Both are stable now, 0.25s is no worse on any axis and better on two. ⚠️ Not gated at ten minutes at a viewer.                                                                                                                    |
| Seeking             | VOD manifests carry every segment plus `#EXT-X-ENDLIST`, so hls.js should seek natively. **Nobody has watched it work and nothing tests it.**                                                                                                                                                                                                                     |
| Live DVR            | One chunk of manifest. On latbench at the best profile that is **9.0 seconds**, up from 2.5.                                                                                                                                                                                                                                                                      |
| Crash recovery      | 6 e2e scenarios pass on the **uploader's** side. ✅ A viewer has now been watched through one: `browser:crash` reports what the picture did and what the client said. ⚠️ **Recovery is dominated by the client's own backoff, not by the outage** (task #85).                                                                                                     |
| Browser validation  | ✅ **Unblocked 2026-08-05.** `pnpm browser:selfcheck` proves the browser is a valid instrument in ten seconds for no cost, and `browser:watch` reports VOID rather than a number when it is not.                                                                                                                                                                  |

---

## Phase 0 — finish what today's measurement started

Cheap, no new infrastructure, and the first item blocks shipping the profile we just chose.

### 0.1 ✅ done — the live window is budgeted in bytes, not counted in segments

`LIVE_WINDOW_SIZE = 10` counted segments, so the media a joining viewer could hold was
`10 × segment length` and collapsed exactly where a viewer had least time to recover.

**The binding constraint turned out not to be a count at all, it is one chunk.** bee-js writes a feed
payload straight into the single-owner chunk while it fits and otherwise uploads it separately,
fetches the root chunk back and wraps that, so crossing **4096 bytes** turns one round trip per
publish into three. Ten segments spent **864** of those bytes, so 79% of the chunk was already paid
for and unused.

The window is a byte budget, so what it holds depends on how long a segment line is. On **latbench**
`MANIFEST_ACCESS_URL` is set and each line costs 111 bytes against the 79 a bare Swarm reference
costs, so a deployment that leaves it empty gets 50 segments where this one gets 36.

| segment   | window before | window now (latbench) | bare ref | required | old verdict            |
| --------- | ------------: | --------------------- | -------: | -------: | ---------------------- |
| **0.25s** |     **2.50s** | **9.00s** (36 seg)    |   12.50s |    2.67s | **short by 172-550ms** |
| 0.5s      |         5.00s | 18.00s (36 seg)       |   25.50s |    4.91s | fits, by **91ms**      |
| 1.0s      |        10.00s | 37.00s (37 seg)       |   52.00s |        — | fits                   |
| 2.0s      |        20.00s | 74.00s (37 seg)       |  104.00s |        — | fits                   |

`required` is the worst edge-to-fetchable delay in that configuration's clean runs, plus the cadence
hls.js reloads a live playlist at, plus one segment of margin. **The ten-segment window was adequate
at every segment length except the one the campaign just chose**, and at 0.5s it was adequate by 2%.

Same one chunk, same one SOC write, so the postage cost per publish did not move.
`playerConfig.ts` was re-derived on the same runs and **stays at 6 seconds**, clearing the worst
requirement by 1.09s. A test reads it out of the client's source and fails if the window stops
covering it.

⚠️ **Left open, and it is new: the window is also the client's gap-repair budget.**
`uploadLiveManifest` coalesces behind `liveManifestQueued` and `MANIFEST_UPLOAD_RETRY_WINDOW_MS` is
**15 seconds**, so a stalled publish can advance the window by more segments than it names. Those
segments appear in no manifest any viewer reads and no discontinuity tag is armed, so the loss is
silent. Five times the window is five times the tolerance and it does not close the hole.

### 0.2 ✅ diagnosed — the encoder never missed its GOP, the publisher was throttled

Filed twice with the wrong cause, first as a 1080p limit and then as an encoder that misses its GOP.
[It is neither.](../bench/publisher-backpressure.md) `-g` is set in **frames** and is honoured exactly
in every run: 8 packets at a 0.25s request, 15 at 0.5s, good runs and bad alike. What moves is the
**delivered frame rate**, 30.1 in the good runs against 12.0 and 23.7 in the bad, and the segment
length follows from it.

The recipe stamps timestamps at the demuxer and paces inside the filter graph, so a blocked muxer
stops the demuxer pulling while the wall clock runs on, and media time stretches to match the
consumer. Reproduced with no engine, no SRT and no postage by feeding the encode to a pipe read at a
fixed rate: **30.0 / 29.7 / 19.8 / 12.2 fps** at unthrottled / 400 / 250 / 150 kB/s, against a run
that measured 12.0. The knee sits at the stream's own bitrate, which is why 1080p at 6000kbps met it
far more often. **Resolution was never the variable, bitrate is.**

`check-axis.py` now names the cause instead of blaming the encoder, and prints the delivered frame
rate on passing runs so a mildly throttled one is visible rather than silent.

⚠️ **Which consumer is slow is still open, task #82.** The reports carry no segment byte size, so the
throttle cannot be read out of any run already taken. Recording it costs nothing extra, since the
probe already downloads each segment and discards the size.

### 0.3 ✅ done — the 0.25s winner holds at 10 minutes

[Six 10-minute runs, 6 of 6 usable.](../bench/ten-minute-gate-2026-08-05.md) **0.25s measured 1055,
1081 and 1084ms, a 29ms spread and the tightest repeatability this project has recorded**, against
1502-1596ms for the 0.5s reference. No run drifted: every one has `msPerMinute` below its own scatter.
The encoder delivered 30.0-30.1fps in all six, so the publisher throttle of 0.2 did not appear once.

⚠️ **The gap narrowed from the ~650ms the 3-minute screening claimed to 462ms.** The ordering holds.

⚠️ **Two things the 0.25s profile pays, absent at 0.5s, and they turned out NOT to be one fact.**
The reader spends its whole walk budget on half its polls in **all five** runs of this configuration,
so that is the profile. The refusal share ranges **0% to 22.6%** across those same five, so that is
the afternoon. **Refused is not lost**, and two attempts to time the wait have not landed: the
in-loop version could not reach past two seconds and made the refusals worse by loading the gateway,
and the off-loop watcher drew a run with nothing to watch. Task #83.

---

## Phase 0.5 — the long-run campaign, now that it is funded

**Funded 2026-08-06.** Postage batch `7849851f…` at depth 24 is 256 buckets and 30 days, immutable,
which is about **1100 broadcast-minutes** at the 0.22 buckets a minute measured on 10-minute runs.
Uploader chequebook 9.98 BZZ against a measured **0.0214 BZZ/min**, so about 460 minutes. Neither
binds the plan below, which is roughly 260.

⚠️ **The gateway spends essentially nothing on this topology**, 0.0002 BZZ/min measured, 174x under
the constant `sweep-interleaved.sh` prices it at. It has never been the binding node and quoting the
constant asked for a deposit that was not needed.

Every run now reports what it consumed and warns at 80% full, so this table is the plan and the runs
themselves are the check on it.

|      | run                                               | why it is on the list                                                                                                                                                                                                                                                                                                                                          | broadcast-min |
| ---- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: |
| 0.5a | 10-minute viewer gate at 0.25s, ×2                | The loop fix is gated on two 150s runs. This project's own discipline is screen at 3, gate at 10.                                                                                                                                                                                                                                                              |            26 |
| 0.5b | **60-minute viewer run at 0.25s**                 | The one that matters. The client's manifest state **never trims**: it appends every segment it has seen and rebuilds the whole playlist on every poll, which at 0.25s is four a second and ~14,000 in an hour. The loop fix made it consume **more** slots, so if that costs anything this is where it shows. Nothing here has ever streamed past 150 seconds. |            63 |
| 0.5c | 60-minute run at 1.0s                             | The control. Same hour, a quarter of the segments, so a degradation that tracks segment count separates from one that tracks wall clock.                                                                                                                                                                                                                       |            63 |
| 0.5d | #71 and #85 fixed, each verified before and after | Both are measured, both have a named number to move (46.7s and 16.2s), and both are recovery rather than steady state.                                                                                                                                                                                                                                         |            50 |
| 0.5e | The five remaining crash scenarios, ×2            | Phase 2's list, now that a viewer can be watched through one.                                                                                                                                                                                                                                                                                                  |            60 |

**Read the windows, not the median.** A run that is perfect for its first half and rebuffering
through its second has a respectable median and is a broken stream, which is why `stability.ts` cuts
a run into five-minute windows and reports each on its own.

## Phase 1 — the viewer features

### 1.1 ✅ done — browser validation is unblocked, and it found something

Real Chrome, headed against an Xvfb display on the deployment host, driven by `playwright-core`.
The page is genuinely foregrounded, so the hidden-pane failure that produced the 578-second reading
of 2026-08-03 cannot recur silently: `visibilityState`, timer fidelity and codec support are checked
on **every sample**, and a run that fails any of them reports **VOID** instead of a number.

`pnpm browser:selfcheck` answers "is this browser a usable instrument" on its own, in ten seconds,
with no broadcast and no BZZ. It is the cheap first call after any change to the image or the host,
and it earned its keep immediately by catching a clock overlay that silently never rendered.

**[What it found is worse than what it unblocked.](../bench/viewer-in-a-browser-2026-08-05.md)** The
byte-budgeted window works, twice measured at 5.96 and 5.97s against a 6s target. But the player
cannot hold it: 12-17% of the wall clock frozen in 3 of 3 sessions, and a true glass-to-glass gap
that reached **17.9s while the player reported 1.16s**.

### 1.1b ✅ diagnosed — [the client asks for segments one at a time](../bench/what-starves-the-viewer-2026-08-05.md)

Both obvious causes are **refuted by the request log**: 0 refusals in 469 segment requests, 0ms spent
on retry delays, and a 125ms median transfer from a gateway that served everything asked of it.

The client's live loop walks **one feed slot per segment**, serially, with at most 2 requests in
flight: 469 segments against 455 feed reads. Each cycle pays a 51-72ms feed round trip on top of the
segment's own duration, and gains one segment of media. So the advance ratio is
`duration / (duration + round trip)`, which is 0.82 at a 0.267s segment and 0.99 at a 1.0s one.
**Shorter segments do not make the client faster, they make it ask more often.**

⬅ **The fix is in the client, and it is the highest-value change on this roadmap**: ask for the next
slot while the current segment is still downloading, or fetch several announced segments at once. The
client already addresses segments by computed slot, so neither needs new information.

⬅ **1.2 and 1.3 are now measurable.** They were the reason this came first, and they are also now
lower priority than #84, because a seek feature on a stream that freezes a sixth of the time is not
the thing to build next.

### 1.2 Seeking

The VOD path looks correct by construction: `buildVODManifest` emits every segment with `PLAYLIST-TYPE:VOD`
and `ENDLIST`, the client resolves the head once and gets that manifest whole, and hls.js seeks
natively over it. **That is a reading, not a result.** What is untested: seeking past a discontinuity,
seeking into a region whose chunks have left the local gateway, and seek latency, which is a fresh
retrieval per target and has never been measured.

Live seeking is a different feature and belongs in 1.3.

### 1.3 A real DVR window

A live viewer can now seek back **9.0 seconds** at the best profile rather than 2.5, and 0.1 spent
what was free to get there. Past that the manifest leaves one chunk and every publish costs three
round trips instead of one, so **the next second of DVR is not free and this is where it stops being
a constant**. A useful DVR means the client addressing segments the live manifest no longer names. It
already has the machinery, since it walks feed slots by computed address, so this is a design
question rather than a hard one: decide whether the client keeps its own history, or whether the
uploader publishes a rolling index.

⚠️ Related and already known: the client's manifest state **never trims**, so a long broadcast grows
it without bound. Fix these together.

### 1.4 Resync on a stalled feed — task #71

`handleFollowupFetch` pins its slot, and on a miss re-asks that same slot forever. After 30 polls the
UI says `stalled` and nothing else happens. The recovery that exists (`restartStream`) fires on a
**parse** error, which a stuck feed never produces.

**The trigger was measured and is absent: [692 of 692 slots answered](../bench/feed-hole-scan.md), 4ms
median, zero holes.** So this is insurance rather than a live bug, and it is ~20 lines: on `stalled`,
drop the index and re-anchor through the head lookup, which is already proven by
`ManifestFetcher.test.ts`. ⚠️ Still not to be edited on reading alone.

---

## Phase 2 — crash recovery, the scenarios that are missing

**Covered today** (`e2e/suites/scenarios/`): uploader hard crash resumes without a spurious VOD;
engine restart yields a fresh stream on reconnect; an 8s bee outage loses nothing and arms no
discontinuity; a long bee outage arms one and resumes; a viewer-gateway outage does not stop uploads;
a clean stop finalizes a VOD.

⚠️ **Every one of those reads the uploader's log.** They answer whether the publisher did the right
thing, and all six pass. **`pnpm browser:crash` asks the other question**: what a viewer saw, from a
real browser watching while the fault is injected. Two scenarios run so far
([report](../bench/crash-at-a-viewer-2026-08-05.md)), and both found something the six could not see:

- ✅ **`FeedStateOverlay` works.** Both states rendered within a second of their fault and both were
  correct. Nothing had ever watched it render.
- ⛔ **A viewer's recovery is bounded by the oldest slot they cannot retrieve, not by the outage.**
  The uploader was healthy again in 3.4s and the viewer waited 46.7s more, because the walk asked for
  one slot address 112 times over sixty seconds. Task #71, upgraded from the downgrade a 692-slot
  scan gave it.
- ⛔ **The client's manifest backoff overshoots the outage** by about ten seconds after a twenty
  second one, and by up to thirty at its cap. Task #85.

**Missing, ordered by likelihood times damage:**

| #   | scenario                                                | why it ranks here                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | **Chequebook exhausted mid-stream**                     | **Known to occur.** It emptied at run 7 of 12 on 2026-08-05 and 64 of 247 peers went past -9.0e6 debt. Runs on either side were not comparable and nothing said so. The sweep now has a preflight, but the **uploader itself** has no behaviour for it. |
| 2.2 | **Postage batch full or expired mid-stream** — task #62 | A batch went 9.4% to 64/64 in one day. Mutable batches then evict **silently**.                                                                                                                                                                         |
| 2.3 | Crash during `finalize`                                 | `notifyStop` is memoized and deletes the recovery entry at the end. A crash inside it is the one window where the entry is gone and the VOD is not published.                                                                                           |
| 2.4 | Whole-stack restart                                     | Every scenario today restarts one container. Nothing tests all of them together, which is what a host reboot does.                                                                                                                                      |
| 2.5 | Recovery entry corrupt or hand-edited                   | `readinessFromPersisted` has a documented repair path. Unit-covered, never driven end to end.                                                                                                                                                           |
| 2.6 | Disk full                                               | `ENOSPC` appears in uploader unit tests. `persistState` swallows it, which is the quietest way to lose a broadcast.                                                                                                                                     |
| 2.7 | Two uploaders on one stream id                          | The reconnect-during-drain race. Unit-tested, and it is exactly the shape that unit tests model badly.                                                                                                                                                  |

---

## Phase 3 — OME, then the engine comparison

### 3.1 OME to parity

**6 of 11.** Still failing: engine restart, gateway outage, catalog-via-gateway, happy-path,
multi-stream. ⚠️ **Swap the existing profile rather than standing up a second stack** — a second stack
needs a new bee identity, which is owner-only on-chain funding. Three blockers were already cleared to
reach 6.

### 3.2 Engines compared honestly

⚠️ **Engines cannot be compared across sittings** (1.05s of drift, larger than most effects), and
swapping engines needs a redeploy. So a fair comparison means interleaving **with** redeploys: SRS,
OME, SRS, OME in one sitting with a reference in each round.

Worth adding as the **control**: ffmpeg's own HLS muxer with no engine at all. Whatever a real engine
adds over raw ffmpeg is what the engine costs.

---

## Phase 4 — LL-HLS, and why it is last

**LL-HLS attacks the `segment` hop, which today's data confirms is the largest single hop.** So it
looks like the obvious next move. The measurements say otherwise, and the argument is now sharp enough
to be worth writing down.

LL-HLS publishes parts every ~200ms, so 5 per second. On this architecture every part a viewer fetches
has to be addressable, which means a feed slot per part. Measured today, per hop:

|                                                   |              measured |
| ------------------------------------------------- | --------------------: |
| `manifestPublish`, the SOC write                  |             215-226ms |
| `feedPropagation`, announce to a reader seeing it |               39-52ms |
| **one slot read at the live edge**                |            **~260ms** |
| **so a reader sustains**                          | **~3.8 slot reads/s** |

**A 5-part-per-second stream outruns the reader before it outruns the encoder.** The ceiling is the
read side, not the encoder, and LL-HLS does nothing about the read side. Adding parts to this
architecture makes the reader fall behind, which is exactly the failure that made the 0.25s rows
unreadable until today.

**A second bound came out of 0.1, and it is close rather than already binding.** One chunk of
manifest names about **50** media lines with a bare Swarm reference and about **37** once
`MANIFEST_ACCESS_URL` is set. A window has to hold the buffer the client asks for, so at a 6 second
target the shortest media unit a one-chunk manifest can name is **0.12s** bare and **0.162s** with a
gateway URL. Parts of 200ms clear that, and a manifest naming parts **and** the segments they belong
to does not. Past one chunk every publish costs three round trips instead of one, at the moment the
publish rate is going up.

**So the question worth answering is not "does OME do LL-HLS".** It is: **can a segment be fetched
without being announced?**

The concrete proposal to test, and it is a proposal rather than a finding: segments are content
addresses today and therefore unpredictable, but they could be written as SOCs at computed addresses
exactly as manifests already are. A client that walks the _segment_ feed skips the manifest entirely
at the live edge. The walk machinery already exists on both sides and this session proved it tracks a
publisher writing 3.8 slots per second. Cost: a SOC write per segment instead of a plain upload.

**Measure the announcement floor before building either.** If it stands where it looks, LL-HLS buys
far less than its reputation, and the cheaper change buys more.

---

## Parked, deliberately

- **65 vulnerabilities** on the default branch, 33 high. Owner's decision: separate PR, later.
- **The upstream bee report** is written and unfiled. Filing is public and under an identity, so it is
  the owner's call.
- **The audio-only path has never been measured.** `MEDIA_TYPE_AUDIO` is shipped and every bench run
  in this repository is video. Not urgent, but it is an untested product surface rather than a missing
  feature.
- **No ABR ladder exists.** The client plays one rendition and neither engine transcodes, so adaptive
  bitrate is a product decision with a real cost, not a tuning knob.
- **Task #22**, sweeping the register for stale rows.
