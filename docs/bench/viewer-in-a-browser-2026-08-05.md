# A viewer, finally watched

**2026-08-05. Three broadcasts, three sessions, 376 samples, Chrome 151 headed on a real X display on
the deployment host. All three instrument-sound.**

Every latency this project has published stops at **capture to fetchable**: the instant a segment
could first be pulled from the gateway. The gated figure is
[1.074s at a 0.25s GOP](./ten-minute-gate-2026-08-05.md). A viewer does not watch the fetchable edge.
This is the first measurement of what one actually sees, and the headline is that the two numbers are
not close.

## The blocker is cleared, and that is a result on its own

Browser validation has been blocked since 2026-08-03, not for want of a browser but because the only
one available degraded what it measured: the pane was permanently `visibilityState: hidden`, and
Chromium answers a hidden page by pausing muted video and throttling timers to about one a minute
once playback stalls. hls.js loads fragments off those timers. The player drifted 578 seconds behind
live and nothing in that number said it was the harness.

`pnpm browser:selfcheck` now answers the question on its own, in about ten seconds, with **no
broadcast, no postage and no BZZ**:

```
visibilityState  visible
timer drift      1.00x requested
viewer clock     viewer 1785942000.3
decodes  video/mp4; codecs="avc1.42E01E"
decodes  video/mp4; codecs="mp4a.40.2"
```

The run repeats those checks on **every sample** and reports **VOID** rather than a number if any
fails, because throttling is a consequence of the first stall rather than a property of the page at
load: a preflight alone would have passed on 2026-08-03 too.

## The window works. The delivery does not.

| | run 1 | run 2 | run 3 |
| --- | ---: | ---: | ---: |
| watched | 99.4s | 179.4s | 119.5s |
| **behind live on joining** | **5.96s** | **5.97s** | 11.57s |
| behind live, median | 2.28s | 1.94s | 2.10s |
| behind live, best | 0.77s | 0.55s | 0.48s |
| **media seconds per wall second** | **0.845** | **0.830** | **0.854** |
| rebuffers | 6 | 11 | 7 |
| wall clock spent frozen | 15.5% | 17.0% | 12.2% |
| buffered ahead, median | 1.60s | 1.57s | 1.56s |

✅ **`LIVE_SYNC_DURATION_S = 6` is reachable, and this is the first evidence of it.** Two runs joined
at **5.96s and 5.97s**, which is the byte-budgeted live window doing exactly the job
[phase 0.1](../reviews/roadmap.md) built it for. hls.js pins its sync position to the start of the
playlist, so a short first manifest would have shown up here as a short join and did not.

⛔ **The player cannot hold it.** In all three runs the latency decays from the join toward the live
edge, the buffer drains from ~2.9s to near zero, playback stalls, latency jumps back, and it repeats.
Six to eleven times per run. A viewer spends **12-17% of the wall clock looking at a frozen frame**.

**The publisher is not the cause and that is measured, not assumed.** Run 1's broadcast wrote segment
0 at 14:34:43.631 and segment 1574 at 14:41:43.248. At `-g 8` on 30fps a segment is 8/30 = 0.2667s,
so that is **420.0s of media in 419.6s of wall clock, or 1.001x**. The media was produced in real
time. The deficit is entirely on the viewer's side of the gateway.

## What a viewer actually sees, in one frame

The publisher burns the host clock into the picture as epoch seconds and the harness paints the
browser's clock into the same screenshot, so one image carries both ends with nothing crossing the
wire between them. The player's own QoE panel covers the burned-in clock, so the harness presses `q`,
the overlay's own shipped toggle, before each shot.

| screenshot | in the picture | in the browser | **behind reality** | the player said |
| --- | ---: | ---: | ---: | ---: |
| sample 31 | 1785942092 | 1785942102.1 | **10.1s** | 1.05s |
| sample 61 | 1785942116 | 1785942132.5 | **16.5s** | 1.69s |
| sample 91 | 1785942145 | 1785942162.9 | **17.9s** | 1.16s |

⛔ **It grows, and it grows by the frozen time.** The gap widened 6.4s across the 30 samples that
contained three rebuffers, and 1.4s across the 30 that contained none. Playback runs at 1.0x and
never recovers what a stall cost it.

⛔ **And `hls.latency` cannot see any of it.** The last column is the same instant read off the
player: while the viewer was **17.9s** behind reality it reported **1.16s** behind live, and it never
moved outside 1.05-1.69s while the true gap nearly doubled. That is not a bug in the player. hls.js
measures against the live edge *it knows about*, and that edge is itself falling behind. **Every
behind-live figure this project holds, including the shipped QoE overlay's, is blind to this**, and
so is the sawtooth in the table above it.

⚠️ The absolute offset may carry a constant instrument bias: `drawtext` stamps the frame before the
`realtime` filter paces it, so the burned clock can run slightly early. That would shift all three
rows equally. **The growth is the finding, and a constant bias cannot produce it.**

## What this does not say

**Which layer starves the player is not established.** The publisher is ruled out. Beyond that, the
candidates are the gateway's sustained read throughput, the client's fetch concurrency, and hls.js's
retry delay meeting the known 404-on-the-newest-segment behaviour: its `fragLoadPolicy.errorRetry`
waits **1000ms** before retrying, which is roughly four segment intervals at this profile. That is a
hypothesis with a mechanism, not a measurement. Task #84.

**Three runs on one profile, one afternoon, one machine.** 720p 2500kbps at a 0.25s GOP, and this
project has already been caught twice reading consecutive runs as a property of a configuration when
they were a property of the afternoon.

**Nothing here was watched for longer than three minutes**, and the one quantity that grows is the
one a long session would grow most.

**The catalog page reported `Failed to fetch app state` on all three mounts**, a 10s timeout against
`/bee/feeds/…`. It did not stop playback, and it is the known slow head lookup, but it means the
first thing a viewer's browser does on this deployment is wait ten seconds and give up.
