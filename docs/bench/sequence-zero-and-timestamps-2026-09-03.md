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

## Open, the owner's calls

1. A stamp costs about 50 bytes per segment of the 4096 byte live window, so the window holds about 30
   segments where it held about 50. At 2.0 s that is 60 s, past the engine's own window and the player's
   6 s target.
2. On a single-rendition stream the stamp steps by `HLS_FRAGMENT` while the segment can be longer, since
   the engine cuts at the next keyframe. Under a ladder the two agree.
3. After an engine restart inside a broadcast the numbering re-anchors forward with a discontinuity and
   the date stays anchored to the broadcast's start, so the rungs keep agreeing while the absolute time
   lags by the length of the gap.
4. The live suites do not yet assert this contract. The check exists in the harness and is unit-proved.
   Wiring it needs the playlist text during a suite, which needs the owner and topic, and the log names
   the topic but not the owner.
5. Abel's player needs telling that the history starts at 0 now and that stamps are present. The owner
   does that.
