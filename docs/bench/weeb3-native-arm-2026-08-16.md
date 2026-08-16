# Our broadcast, weeb-3's own page, no gateway: it plays at realtime

**2026-08-16, free. No broadcast, no BZZ.** Driver `e2e/browser/weeb3-native.ts`
(`pnpm browser:weeb3-native`), headful Chrome on the Mac, weeb-3's published deployment. Target is
our own 2026-08-11 shipping-profile recording, owner `8d8a30ff…`, topic
`7e87a2d9-82fe-422f-a66a-5b1e42281636`. Artefacts `weeb3-native-2026-08-16T06-33-22-925Z.*`.

This is what the owner asked for on **2026-08-11T07:07Z** and did not get. See
[`abel-gateway-less-live-2026-08-16.md`](abel-gateway-less-live-2026-08-16.md) for why.

## Result

| | |
| --- | ---: |
| **gateway-less** | ✅ **201 requests, zero off-shell bytes** |
| **realtimeRatio, once moving** | **1.0000** over 214 s |
| realtimeRatio, whole window | 0.8947 over 240 s |
| startup before the playhead moved | **26.1 s** |
| stalls | 2 |
| **segments** | **24 done, 0 failed**, mean **0.801 MB / 1.749 s** |
| resolution | 1920x1080 |
| peers | 200 |
| media ready after | 18 s |

⭐⭐⭐ **weeb-3's own page delivers and plays our 1080p stream at exactly realtime with no gateway in
the path.** Not one of the 201 requests carried bytes from any host outside the app shell.

⚠️ **Two numbers are published on purpose.** 0.8947 counts the 26.1 s startup inside the window.
1.0000 is what the session did once the playhead moved. **The steady figure is the answer and the
startup is a separate cost**, which is why both are in the table rather than one.

## ⭐⭐⭐ AND THE NODES AGREE, WHICH THE FIRST THREE RUNS COULD NOT SHOW

⛔⛔⛔ **The first three runs of this driver published "gateway-less" on the browser's own request log
and nothing else.** That is the shape of a defect this project has already paid for: a sitting once
reported two byte sources while both arms fetched every segment from one node, and the client's
readback was honest throughout. **The nodes keep a complete account and nothing was reading it.**

Replicate `weeb3-native-2026-08-16T07-26-24-975Z`, bracketed by a full snapshot of both bee nodes
either side, 484 uploader and 445 gateway metric keys, differenced over a **267 s** window containing
the arm:

| | |
| --- | ---: |
| **gateway, retrieval requests** | **0** |
| gateway, failed outright | 0 |
| uploader, chunks push-synced | 0 |
| **uploader spent** | **0.0000 BZZ** |
| **gateway spent** | **0.0000 BZZ** |
| postage `7849851f` | 357 → 357 of 512, unchanged |
| postage `46ad3454` | 50 → 50 of 64, unchanged |
| host load | 6.87 → 5.04 |

⭐⭐⭐ **Gateway-less is now proved from the other side of the wire.** Our gateway served zero
retrievals while the browser fetched and played 24 of our segments.

⭐ **The driver now refuses to start without this.** `WEEB3_NATIVE_METRICS_SSH=<host>` brackets the
run, or `ALLOW_NO_NODE_METRICS=1` records out loud that a run has no node-side evidence. The diff is
written into the run's own report rather than a directory somebody has to remember to read.

## Replicates

| run | steady ratio | startup | segments | off-shell bytes |
| --- | ---: | ---: | ---: | ---: |
| `06-33-22` | **1.0000** | 26.1 s | 24 done, 0 failed | none |
| `07-09-59` | **1.0000** | 28.1 s | 24 done, 0 failed | none |
| `07-26-24` | **1.0000** | 29.1 s | 24 done, 0 failed | none |

⭐⭐ **Three runs, the same answer on every column.** ⚠️ Same machine, same connection, same
recording, so this is repeatability and not independence.

## ⛔⛔ WHAT THIS IS NOT

⛔ **It is not a live-edge result and does not compare to the in-tab arms yet.** The mean buffer ahead
was **1,093.94 s**: hls.js pulled the whole finished playlist and buffered it. A live viewer has a
window of seconds, not the whole recording, and every hybrid in-tab figure this project holds was
taken at a live edge. **The comparison this sitting was built for still needs a live broadcast.**

⛔ **n=1**, one machine, one home connection, one recording, one profile.

⚠️ **The visibility check passes by construction**, because Playwright forces a visible page. It is
recorded, not relied on.

## ⛔⛔⛔ TWO DEFECTS IN THIS DRIVER, BOTH FOUND BY ITS OWN FIRST RUN

**1. The first run reported `realtimeRatio 0.068` and it was meaningless.** weeb-3 opens a finished
broadcast **at its live edge, which is the end of the recording**. The playhead reached 1190.08 of a
1190.3 s recording at t+40 s and sat there, paused, for the remaining 140 s. The number reads exactly
like a delivery failure and is the recording running out.

⭐ **The driver now refuses a window whose playhead reached the end** rather than printing the ratio,
and takes `WEEB3_NATIVE_START_S` to place the playhead where there is media ahead of it.

**2. The host gate refused the run over a logo.** Two requests to `docs.libp2p.io` for
`libp2p_color_symbol.svg`, both failed, both **0 bytes**. The gate said *"this is not a gateway-less
arm"*.

⭐ **It now fails on bytes served, not on contact**, and still reports contact. A gate that cannot
tell a failed logo from a content path is one the next person switches off.

## ⭐⭐⭐ What generalises

1. **A ratio computed from the first sample counts the startup.** This repository already knew that,
   in `Weeb3FetchBackend.prewarm`'s own comment: *"an arm that switches to this backend and
   immediately starts scoring is measuring the join rather than the backend"*. I wrote a new driver
   that did precisely this, in the same session in which I quoted the rule.
2. **Check what the playhead did, not only what the ratio says.** 0.068 and 0.895 came from the same
   apparatus on the same content minutes apart. The sample series distinguished them instantly and
   the summary statistic never could.
3. **A gate should fail on the harm, not on the proxy.** "Contacted an unexpected host" is a proxy.
   "Received bytes from an unexpected host" is the harm.
