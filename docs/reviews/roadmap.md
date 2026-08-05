# Roadmap

**2026-08-05.** Ordered by what unblocks what, not by appeal. Every claim below is either measured and
linked, or marked as a guess. Items already tracked carry their task number.

## Where the product actually is

|                    | state                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine             | **SRS works.** OME is at **6 of 11** e2e and must not be called working.                                                                                                                                                                             |
| LL-HLS             | **Not implemented and not configured.** `OmeHlsPuller` reads `ts:playlist.m3u8`, OME's MPEG-TS playlist. No `<LLHLS>` publisher exists in `Server.xml.template`. Neither engine transcodes: both set bypass and remux the broadcaster's own streams. |
| Live latency       | **1.00-1.06s** capture-to-fetchable at 720p 2500kbps, 0.25s GOP. [Measured today.](../bench/quarter-second-2026-08-05.md) 3-minute screening, never gated at 10.                                                                                     |
| Seeking            | VOD manifests carry every segment plus `#EXT-X-ENDLIST`, so hls.js should seek natively. **Nobody has watched it work and nothing tests it.**                                                                                                        |
| Live DVR           | One chunk of manifest. On latbench at the best profile that is **9.0 seconds**, up from 2.5.                                                                                                                                                         |
| Crash recovery     | 6 e2e scenarios pass. The gaps are listed in phase 2 and the top two are known to occur.                                                                                                                                                             |
| Browser validation | **Blocked.** Gates every claim about what a viewer sees.                                                                                                                                                                                             |

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

### 0.3 Gate the 0.25s winner at 10 minutes — task #72

Screening is 3 minutes by design. ⚠️ **A full 10-minute grid is ~120 minutes of publishing and would
exhaust the uploader chequebook**, so this one needs sizing with the owner before it starts.

---

## Phase 1 — the viewer features

### 1.1 Unblock browser validation — task #48 ⬅ **do this first, it gates the rest of the phase**

The automated pane is permanently `visibilityState: hidden`, which stops muted video and throttles
timers once playback stalls, starving hls.js's own loader. A measurement whose subject is degraded by
observing it is not a weak reading, it is not a reading.

**This blocks 1.2, 1.3, the catalog fix's product claim, and every future statement about what a
viewer sees.** Two candidate routes, neither tried: a headful Chrome session, or a Playwright
container on the deployment host where the page is genuinely foregrounded.

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
