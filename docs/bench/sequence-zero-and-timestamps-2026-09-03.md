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

## Open, the owner's calls

1. A stamp costs about 50 bytes per segment of the 4096 byte live window, so the window holds about 30
   segments where it held about 50. At 2.0 s that is 60 s, past the engine's own window and the player's
   6 s target.
2. On a single-rendition stream the stamp steps by `HLS_FRAGMENT` while the segment can be longer, since
   the engine cuts at the next keyframe. Under a ladder the two agree.
3. After an engine restart inside a broadcast the numbering re-anchors forward with a discontinuity and
   the date stays anchored to the broadcast's start, so the rungs keep agreeing while the absolute time
   lags by the length of the gap.
4. ✅ **Decided and built.** Seven live suites now fetch the playlists a broadcast published and assert
   the contract on them: `service/happy-path`, `service/abr-ladder`, scenarios E, F, H and I, and the
   ABR engine restart. No uploader change was needed. One `STREAM_KEY` signs the catalog, every master
   and every rung's manifest feed, so the owner is the address `discoverCatalogFeed` already reads out
   of the `[StreamCatalog]` line, and the topic comes from the rung announce. See
   `e2e/src/harness/manifestContractLive.ts`.
5. Abel's player needs telling that the history starts at 0 now and that stamps are present. The owner
   does that.
