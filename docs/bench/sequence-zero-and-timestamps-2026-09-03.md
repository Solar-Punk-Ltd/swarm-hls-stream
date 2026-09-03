# Sequence zero and timestamps, proven on the stage (2026-09-03)

**What changed.** Every broadcast's playlists now open at `#EXT-X-MEDIA-SEQUENCE:0` whatever the engine's
own counter reads, and every segment carries an `#EXT-X-PROGRAM-DATE-TIME` derived from one anchor per
ladder: the instant the broadcast was admitted, plus the segment's sequence times the declared fragment
length. Never a segment's arrival time, so all four rungs date the same media alike. Built at `019c008`
and `68b2a62`, documented at `bed0608`, corrected at `3598254`. The client passes the stamp through
untouched. The uploader's log lines keep naming the engine's own index.

**Why the uploader does it.** Read in `ossrs/srs` branch `6.0release`: the HLS muxer's sequence counter
is set to 0 only in its constructor. Unpublish keeps it, `hls_dispose` keeps it, a config reload keeps it.
It goes back to 0 only when the whole live source is reaped after a few idle seconds. So a broadcast on a
warm engine opens wherever the previous one ended (six recordings here opened at 210, 317, 416, 580, 707
and 850), and no engine setting makes it start at 0. The uploader knows where a broadcast began, so it
numbers.

## The proof, two runs

Each run: redeploy the uploader with `HLS_FRAGMENT=2.0` exported (the stage cuts 2.0 s segments from a
shell export, not from any file), one two-minute four-rung broadcast through the gateway playback suite
(`pnpm e2e:vod` with `BROWSER_FETCH_BACKEND=gateway`), the live 1080p playlist captured off the gateway
every five seconds, the recording captured after finalize, and `manifestContractFailures` from
`e2e/src/harness/manifestContract.ts` run on the captures with fragment 2.0.

| | run 1, head `bed0608`, 11:25 WITA | run 2, head `3598254`, 11:35 WITA |
| --- | --- | --- |
| first live playlist | `MEDIA-SEQUENCE:0`, 1 segment | `MEDIA-SEQUENCE:0`, 1 segment |
| first stamp | **`1970-01-01T00:00:51.794Z`** | `2026-09-03T03:37:03.704Z`, captured 5 s later |
| window slide | at 31 segments, 0 → 1 → 6 → 12 → 17 → 23 → 28 | at 31 segments, 0 → 1 → 8 → 15 → 22 |
| stamp step | exactly 2.000 s | exactly 2.000 s, 61 stamps, 0 off |
| recording | 61 segments from 0, VOD, ENDLIST | 61 segments from 0, VOD, ENDLIST, last `EXTINF:1` |
| contract check | refused, on the 1970 stamp only | **holds**, first live playlist and recording |
| V4 gateway suite | pass | pass |
| cost | about 0.25 BZZ | about 0.25 BZZ |

**Run 1 found a defect the unit tests could not.** The anchor had been minted from the orchestrator's
injected clock, which is `performance.now()`: milliseconds since the process started, chosen so ages can
never go negative under an NTP step. Fifty-two seconds was how long the uploader had been up since its
redeploy. Every other check passed on those stamps, because they rose by exactly one fragment. Fix
`3598254`: the anchor comes from a wall clock (`Date.now`, injectable for tests), a unit test pins that a
monotonic clock at 51 s never becomes the anchor, and the contract refuses any stamp before 2025.

**Captures beside this document:** `manifest-2026-09-03T03-37-08Z-first-live-playlist.m3u8`,
`manifest-2026-09-03T03-45-01Z-recording.m3u8`, and run 1's
`manifest-2026-09-03T03-27-20Z-first-live-playlist-uptime-clock.m3u8` kept as the evidence of the defect.
Run 2's playback artifact is `browser-vod-2026-09-03T03-39-21-109Z.md`.

## The full sitting that followed

At 11:48 WITA the whole suite ran through the in-tab node on this uploader, head `93f12ff`: 9 of 9 gates and
**33 of 33 suites**, the first fully green sitting this project has had. The three engine-restart paths (the
ABR restart, E and V10) and the three crash-recovery paths (F, H, I) all passed with the numbering re-anchored
and the anchor restored. The previous best was 32 of 33, twice, the night before. About 1.8 BZZ.

## The gateway sitting, the same afternoon

At 13:46 WITA the whole suite ran again on the same uploader, head `54bf4fa`, with the viewers fetching through
the gateway instead of the in-tab node: 9 of 9 gates and **32 of 33 suites**. The one red is H, killed inside
finalize, which reported the recording had lost a rendition across the crash, 3 left of 4 announced. The
uploader log shows why, and it is the harness: its warmup counted segments across every rung merged, reached
its threshold on the three fast rungs, and killed the uploader before the 1080p rung had uploaded a single
segment. A recording that never held a fourth rendition cannot lose one. It is the ninth time a number summed
across rungs has read as a fault in this project. The warmup now waits for every rung on its own (`fad8290`). Its first proving run
was refused by the spend gate, correctly, because a 3 BZZ deposit landed on the 1080p node during the sitting and
the ledger's start balance for that node no longer read as a start. The gate's own words: "A deposit landed after
this authorisation was written". The owner wrote a fresh ledger at 15:19 WITA and H ran alone at 15:21 on head
`12f0d7c`: 9 of 9 gates, **H green**. All four recovery entries survived the kill and the finished entry carries
4 renditions from 4 announced rungs, one catalog write, nothing republished. 0.010 BZZ. With it, every suite has
now passed live on this uploader in both byte sources.

Everything else held through the gateway as it had in the in-tab node. V2 went 1080p to 480p under the
2800 kbps cap and climbed back to 1080p 28.4 s after the lift, 0.978 media seconds per wall second while
capped. V4 played the whole two-minute recording at 1080p with all four rungs offered, 61/61/61/62 segments.
Artifacts `browser-quality-2026-09-03T06-32-01-420Z.md` and `browser-vod-2026-09-03T06-44-21-952Z.md`.

The sitting cost 2.486 BZZ read across all five chequebooks, against about 1.8 for the in-tab sitting. The
difference is almost entirely the gateway node's own 0.619 BZZ, the retrievals the viewers made through it
and which the in-tab node pays for itself. The publishers' side was 1.867. The 1080p node's figure is the
reading with the 3.000 BZZ deposit removed, which its total balance shows to the plur.

| node | spent |
| --- | ---: |
| 360p, the coordinator, :10075 | 0.241 |
| 480p, :11071 | 0.189 |
| 720p, :11073 | 0.528 |
| 1080p, :11075 | 0.909 |
| gateway, :10077 | 0.619 |
| **all five** | **2.486** |

## The proving sitting for the two decisions, the same evening

At 17:50 WITA the whole suite ran through the gateway once more, on the uploader redeployed at head `9252186`, which
carries both decisions: the dating re-anchors on the wall clock at an engine restart, and seven live suites now fetch
the playlists a broadcast published and hold them to this contract. **9 of 9 gates and 36 of 36 suites**, the third
fully green sitting on this uploader and the first in which the contract is asserted by the suites themselves rather
than read by hand. Gate 8 accepted the redeployed uploader's new log line on the first try.

The re-anchor fired live in the first suite, the ABR engine restart. The uploader's own log has the 1080p rung minting
the line at 09:51:42.712Z, "re-anchored its dating at sequence 0: 09:51:25.917Z becomes 09:51:42.710Z", which is the
17 seconds of lag the decision set out to remove, and the other three rungs joining that same line within 800 ms. The
suite then re-announced all four rungs five more times over the next seventy seconds as the broadcaster reconnected
through the restart, a behaviour that predates today, and every one of those 20 announces joined the line minted
first, so the ladder never dated one segment two ways. The lag that sharing costs a session announced late is bounded
by the two minute tolerance in `broadcastDating.ts`, against the unbounded lag before. The other restart shape, an
engine counter resetting inside one session, was not exercised live, the log shows no "Continuing the playlist at
sequence" line all sitting, so that branch stands on its unit tests.

What the suites printed, one line per rung: H's recording carried all four rungs at `#EXT-X-MEDIA-SEQUENCE:0`,
5 segments each, dated 09:55:04.524Z to 09:55:12.524Z on every rung. I's recording the same at sequence 0. The
happy path and the ladder suite read live playlists at sequence 0 with 5 to 10 segments and one shared first date.
Scenario F read its post-crash playlists at sequences 15 to 18 with 31 segments each, dates continuous over 60 s,
which means the crash join had already slid out of the live window before the read, exactly as the wiring predicted.
So the segment-loss gap named under "Open" below is still unobserved live: F is green without having looked at it.

The sitting cost 2.494 BZZ across the five chequebooks, the same as sitting D to the hundredth, with no deposit and
no cheque cashed during it (every total balance unmoved).

| node | spent |
| --- | ---: |
| 360p, the coordinator, :10075 | 0.247 |
| 480p, :11071 | 0.199 |
| 720p, :11073 | 0.515 |
| 1080p, :11075 | 0.939 |
| gateway, :10077 | 0.594 |
| **all five** | **2.494** |

## Open, the owner's calls

1. A stamp costs about 50 bytes per segment of the 4096 byte live window, so the window holds about 30
   segments where it held about 50. At 2.0 s that is 60 s, past the engine's own window and the player's
   6 s target. ✅ **Decided, kept as built.**
2. ✅ **Decided, accepted as it is, with an operating rule and no code change.** On a single-rendition
   stream the stamp steps by `HLS_FRAGMENT` while the segment can be longer, since the engine cuts at
   the first keyframe at or after it. The rule: the stamps drift only when the source's keyframe
   interval does not divide `HLS_FRAGMENT`, and a single-rendition deployment must set the
   broadcaster's keyframe interval to divide it or its stamps fall behind by the excess of every
   segment, without bound. Under the ladder the engine re-GOPs every rung at `ABR_FPS × HLS_FRAGMENT`,
   so there is no drift. Written up in the uploader README.
3. ✅ **Decided, re-anchor, built and proven live** (the sitting above). After an engine restart inside a broadcast the date now re-anchors on the
   wall clock the engine came back at, so the media after the gap carries the time it really happened
   while the media published before it keeps the dates it went out with. The re-anchoring is minted
   once for the whole ladder, by whichever rung crosses the restart first, and every other rung lands
   on that same line, so the mapping from sequence to date stays one function for the ladder. Both
   restart paths do it, the recording uses the same function, and the epochs ride with the group record
   and with each recovery entry so a crash after a restart comes back on them.
4. ✅ **Decided, built and proven live** (the sitting above). Seven live suites now fetch the playlists a broadcast published and assert
   the contract on them: `service/happy-path`, `service/abr-ladder`, scenarios E, F, H and I, and the
   ABR engine restart. No uploader change was needed. One `STREAM_KEY` signs the catalog, every master
   and every rung's manifest feed, so the owner is the address `discoverCatalogFeed` already reads out
   of the `[StreamCatalog]` line, and the topic comes from the rung announce. See
   `e2e/src/harness/manifestContractLive.ts`.
5. Abel's player needs telling that the history starts at 0 now and that stamps are present. The owner
   does that.
