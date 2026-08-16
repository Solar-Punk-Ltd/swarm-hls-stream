# A2: our player, playing a recording with no gateway serving the video

> ## ⛔⛔⛔ WHAT THE CLIENT UNDER TEST ACTUALLY WAS, AND WHO CHOSE IT
>
> The `weeb3` arms here fetch **segment bytes only** from the in-tab node. The feed and every
> manifest still come from a **bee gateway**, in both conditions. Verified in source: `ManifestManagement`
> has no weeb-3 path, only `CustomManifestLoader` does.
>
> That split was my design decision in PR #183 and **nobody authorised it**. The owner's instruction
> of **2026-08-11T07:07Z** was *"Abel optimized the player as much as possible let's measure and
> experiment with his setup as it is"*, and this is not that.
>
> ⛔ **So any residual gateway load reported below is a floor THIS CLIENT imposes, not one weeb-3
> imposes.** Abel's own live page drives it to zero, proved free on 2026-08-16. Every saving figure
> here is a **lower bound** on what an in-tab node can do.
>
> ✅ **The arithmetic and the arm-to-arm contrasts are unaffected.** Both conditions read the
> manifest the same way, so the comparison is clean. What is limited is the **subject**, not the sums.
>
> See [`abel-gateway-less-live-2026-08-16.md`](abel-gateway-less-live-2026-08-16.md).

**2026-08-13. Three arms, `gateway → weeb-3 → gateway`, one recording, free.** No broadcast, no
postage, 0 BZZ. Task #92 phase A2, on the code merged in PR #183.

## The answer

**Our player plays a full recording with every segment byte coming from a Swarm node inside the
viewer's tab. It seeks, it resumes, and it holds real time. What it does not do is buffer as far
ahead: about 42% of the gateway's lead in the same window.**

| | A1 gateway | **B weeb-3** | A2 gateway |
| --- | ---: | ---: | ---: |
| instrument | SOUND | **SOUND** | SOUND |
| duration reported | 3283.77s | **3283.77s** | 3283.77s |
| **HTTP `/bytes/` requests** | 118 | **0** | 144 |
| **HTTP segment payload** | 20,037,604 | **0** | 24,892,892 |
| `/feeds/` reads (the manifest) | 2 | **2** | 2 |
| buffered ahead after settling | 47.98s | **19.99s** | 60.95s ⚠️ |
| position after settling | 8.09s | **7.99s** | 8.09s |
| appends | 232 | **102** | 288 |
| bytes appended | 19,275,791 | **8,463,904** | 23,944,666 |
| seeks landed and resumed | 3/3 | **3/3** | 3/3 |

⚠️ **A2's 60.95s is censored**, not measured: `maxBufferLength` is 60, so that arm saturated its own
ceiling. The honest comparison is A1's uncapped 47.98s against weeb-3's 19.99s.

## ⛔⛔⛔ The gate: zero segment bytes crossed HTTP

This is the whole reason the arm means anything. On 2026-08-13 an earlier smoke had both arms fetching
every segment from one node while the client honestly reported two, so a readback is not evidence.

The weeb-3 arm made **nine requests in total**, and here is every one of them:

| bytes | what |
| ---: | --- |
| 496 | the page |
| 9,929 | its CSS |
| 1,003,696 | the entry chunk |
| 6,478 + 496 | logo, favicon |
| 82,158 | `/feeds/…` the catalog |
| 512,420 | `/feeds/…` the recording's manifest |
| **41,375** | **`weeb_3-DMGH0K7X.js`, the lazy chunk** |
| **4,491,557** | **`weeb_3_bg-CGW4ecJL.wasm`** |

⭐⭐⭐ **No `/bytes/` at all**, against 118 and 144 in the gateway arms. The wasm was genuinely fetched,
so the backend engaged rather than silently falling through. The two `/feeds/` reads are the design
working as intended: **the manifest still comes from the gateway on both paths**, and only the media
moved.

⭐ Which two feeds, checked rather than assumed. `Topic.fromString` reproduces both hashes exactly, so
the 82 kB read is the catalog and the 512 kB read is **this recording's own manifest** rather than
some other feed that happened to be polled:

| observed | `Topic.fromString(…)` of | |
| --- | --- | ---: |
| `cf0eccedb796e2a0d60f0bb03d2f578f441afc…` | `swarm-stream-latbench` | 82,158 |
| `6d5ea96472f6ead0aa7dbd556e82b4db112745…` | `e8950c8b-33d4-49d3-8e3f-ddac5d9c47ca` | 512,420 |

512 kB is also the right size for the manifest of a 3283.77s recording at the 0.5s profile: about
6,570 segments at a 79-byte bare-reference line.

## What playback actually looked like

Both arms built both source buffers (`mp4a.40.2` and `avc1.64001f`) and reported a finite duration,
which is what says a finished playlist arrived rather than a live window.

| seek | A1 gateway | **B weeb-3** | A2 gateway |
| --- | ---: | ---: | ---: |
| to 50%, landed | 183ms | **596ms** | 219ms |
| to 90%, landed | 166ms | **366ms** | 171ms |
| to 20% (backwards), landed | 203ms | **230ms** | 179ms |
| resumed, worst of three | 346ms | **345ms** | 354ms |

⭐ **Resume time is indistinguishable** across all three, 326-354ms everywhere. The first seek costs
weeb-3 about 400ms extra and the third is within 30ms of the gateway arms, which is the shape of a
cache and a peer set warming rather than a standing penalty.

## ⭐ The service worker failed to register, and playback did not care

The page logged, twice:

> SecurityError: Failed to register a ServiceWorker for scope `/weeb-3/` … unsupported MIME type

Our nginx serves the SPA's `index.html` for that path, so registration cannot succeed. **It played
anyway.** That confirms on the running deployment what PR #183 argued from reading the package: the
`/weeb-3/` worker exists to intercept `/bzz/` fetches for `attachStream` and `renderInterface`, and a
direct `retrieveBytes` needs none of it.

⚠️ It is still noise in the console on every load, and an operator reading logs would reasonably think
something is broken.

## ⚠️ What this does NOT establish

- **n=1 per arm.** Three runs, one each, not three of each.
- **VOD only.** A recording lets the player fetch ahead as fast as it can; a live edge does not. The
  20s lead is comfortably above the 6s `LIVE_SYNC_DURATION_S` target, which **suggests** live would
  hold, and suggesting is all it does. Live is a paid arm and has not been run.
- **The 4.5 MB wasm and the peer wait are a real join cost** that these numbers include but do not
  isolate. A viewer opening the page pays it once.
- **One machine, one recording, one profile**, and the box carries about forty other bee nodes whose
  load is in every arm including the controls.
- **Buffer lead is a throughput proxy, not a throughput measurement.** Both gateway arms were sampled
  against a 60s cap that one of them hit.

## Provenance

- Recording: owner `8d8a30ff…feb0`, topic `e8950c8b-33d4-49d3-8e3f-ddac5d9c47ca`, 3283.77s, published
  earlier the same day by the #93 sitting, so its manifest carries bare references and its content is
  known healthy.
- Reports `browser-vod-2026-08-13T09-55-22-502Z`, `…T10-02-21-787Z`, `…T10-06-40-691Z`.
- Client rebuilt and recreated three times with `--no-deps`, so **no bee node was restarted**: both
  gateways held 134 and 133 peers throughout, and the uploader, SRS and both bee containers kept their
  uptimes.
- Arm order `gateway → weeb-3 → gateway` brackets the treatment, and the two controls disagree with
  each other by more than a quarter (47.98s and 60.95s) while both sit far above weeb-3's 19.99s.
