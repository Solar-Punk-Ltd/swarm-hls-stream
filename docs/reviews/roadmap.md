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
| Live DVR           | 10 segments. At the best profile that is **2.5 seconds**.                                                                                                                                                                                            |
| Crash recovery     | 6 e2e scenarios pass. The gaps are listed in phase 2 and the top two are known to occur.                                                                                                                                                             |
| Browser validation | **Blocked.** Gates every claim about what a viewer sees.                                                                                                                                                                                             |

---

## Phase 0 — finish what today's measurement started

Cheap, no new infrastructure, and the first item blocks shipping the profile we just chose.

### 0.1 `LIVE_WINDOW_SIZE` makes the winning profile unshippable ⚠️ new today

`ManifestManager.ts:16` caps the live manifest at **10 segments**, so the media a player can hold is
`10 × segment length`. `playerConfig.ts` targets a **6 second** sync buffer.

| GOP       | media in the live manifest | against a 6s target                        |
| --------- | -------------------------: | ------------------------------------------ |
| 2.0s      |                        20s | fine                                       |
| 0.5s      |                         5s | already short                              |
| **0.25s** |                   **2.5s** | **the player cannot reach its own target** |

**Shortening the GOP shortens the buffer, and that is the whole reason a short GOP is worth having.**
The two constants were never related to each other and now pull in opposite directions. A window
counted in **seconds** rather than segments fixes it, and the number should come from the measured
`smallest buffer that would not have stalled` (1.15-2.10s across today's clean runs) rather than from
taste. One uploader constant, one client constant, and a test that the two cannot disagree.

### 0.2 The encoder misses its GOP in ~1 run in 3 — task #76

Right packet count for the request, declared duration up to 2.5x long. Not 1080p-only and not
GOP-specific, contrary to how it was filed. **It cost a third of today's sweep**, so every future grid
pays for it. Free to investigate: the reports are already on disk.

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

Today a live viewer can seek back **2.5 seconds** at the best profile. A useful DVR means the client
addressing segments the live manifest no longer names. It already has the machinery, since it walks
feed slots by computed address, so this is a design question rather than a hard one: decide whether
the client keeps its own history, or whether the uploader publishes a rolling index.

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
