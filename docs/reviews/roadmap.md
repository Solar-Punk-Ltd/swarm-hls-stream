# Roadmap

**2026-08-05.** Ordered by what unblocks what, not by appeal. Every claim below is either measured and
linked, or marked as a guess. Items already tracked carry their task number.

## Where the product actually is

|                     | state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine              | **SRS works.** OME is at **6 of 11** e2e and must not be called working.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| LL-HLS              | **Not implemented and not configured.** `OmeHlsPuller` reads `ts:playlist.m3u8`, OME's MPEG-TS playlist. No `<LLHLS>` publisher exists in `Server.xml.template`. Neither engine transcodes: both set bypass and remux the broadcaster's own streams.                                                                                                                                                                                                                                                             |
| Live latency        | **1.074s** capture-to-fetchable at 720p 2500kbps, 0.25s GOP, [gated over three 10-minute runs](../bench/ten-minute-gate-2026-08-05.md) with a 29ms spread and no drift. ✅ **Glass to glass at a viewer is 6.4 to 7.3s and flat**, read off a burned-in clock, [after the client fix](../bench/the-loop-fixed-2026-08-05.md). It was 17.9s and growing before it.                                                                                                                                                |
| What a viewer sees  | ✅ **1.000 and 1.003 media seconds per wall second at 0.25s, nothing frozen, no rebuffers**, holding 5.86s behind live against a 6s target. It was 0.82x and 17.3% frozen: the client took one feed slot per playlist reload. [Fixed and measured](../bench/the-loop-fixed-2026-08-05.md), [diagnosed](../bench/what-starves-the-viewer-2026-08-05.md).                                                                                                                                                          |
| Which profile ships | ✅ **0.25s GOP, and 1080p at 6000kbps with it.** Gated at ten minutes at a viewer: 30.0fps, advance 1.000, nothing stalled, nothing rebuffered. Latency across a 2.4x bitrate range differs by 70ms, so the best picture costs bandwidth (2.24x the BZZ) rather than seconds.                                                                                                                                                                                                                                    |
| Seeking             | VOD manifests carry every segment plus `#EXT-X-ENDLIST`, so hls.js should seek natively. **Nobody has watched it work and nothing tests it.**                                                                                                                                                                                                                                                                                                                                                                    |
| Live DVR            | One chunk of manifest. On latbench at the best profile that is **9.0 seconds**, up from 2.5.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Crash recovery      | 6 e2e scenarios pass on the **uploader's** side. ✅ **A viewer has now been watched through five**, and one of them plays through a **discontinuity** and survives it. ✅ The largest client-side cost is fixed: recovery from an uploader crash went **46.7s → 4.1s** by asking what is behind a refused slot instead of parking on it. ⛔ #92: a write outage the upload side calls clean still freezes a viewer, because lossless is the uploader's 15s retry window and invisible is the viewer's 6s buffer. |
| Browser validation  | ✅ **Unblocked 2026-08-05.** `pnpm browser:selfcheck` proves the browser is a valid instrument in ten seconds for no cost, and `browser:watch` reports VOID rather than a number when it is not.                                                                                                                                                                                                                                                                                                                 |

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

|     | run | why it is on the list | broadcast-min |
| --- | --- | --------------------- | ------------- |

## Phase 0.6 ✅ MEASURED AT BOTH PROFILES — light against ultra-light

⛔ **The standing answer: do not ship an unfunded viewer gateway.** Not because it breaks every time,
it does not, but because the margin is thin and the variation an operator cannot control is wider
than the margin.

**Ultra-light multiplies segment transfer time by two to four, in all three sittings.** Whether a
viewer feels it is decided by the **segment budget**, not by the node:

|              GOP | budget |     light |   ultra-light | outcome at a viewer                                             |
| ---------------: | -----: | --------: | ------------: | --------------------------------------------------------------- |
| **0.25s, ships** |  267ms | 21-24% ✅ | **49-53%** ✅ | 2026-08-08: 45 min unfunded, **nothing stalled or rebuffered**  |
| **0.25s, ships** |  250ms | 26-36% ✅ | **62-69%** ⛔ | 2026-08-06: buffer 4.60s → **1.46s**, **17 rebuffers in 3 min** |
|             1.0s | 1000ms |    10% ✅ |     41-46% ✅ | 30 min clean, nothing stalled or rebuffered                     |

⛔ **The outcome is a threshold and the two 0.25s sittings sit on opposite sides of it.** Around half
the budget the buffer holds. Around two thirds it drains and does not recover. **The unfunded node ran
131 to 172ms across the two sittings, a 31% spread, and only 14ms separates the worst clean arm from
the first failing one.** The funded arm has no such problem: a quarter of the budget, three times the
headroom, no failing arm in either sitting.

✅ **At 1.0s the penalty is absorbed completely**, which is the one thing that reliably fixes it: a
segment budget large enough to swallow a 2-4x transfer cost.

[0.25s, 2026-08-08](../bench/ultra-light-at-the-shipping-profile-2026-08-08.md),
[0.25s, 2026-08-06](../bench/light-vs-ultra-light-2026-08-06.md),
[1.0s, 2026-08-07](../bench/light-vs-ultra-light-at-a-viewer-2026-08-07.md).

### ✅ The mechanism, measured 2026-08-08 for 0.184 BZZ and thirteen minutes

[What throttles an unfunded gateway](../bench/what-throttles-an-unfunded-gateway-2026-08-08.md). Six
arms retrieving the **same 800 segments in the same order**, no encoder, no publisher, no upload and no
postage, because the segments were already on Swarm from the sitting above.

⭐ **A funded node settles what it owes and an unfunded one cannot.** Across three unfunded arms the
debt carried grew every time, by 604, 721 and 479 million PLUR. Across three funded arms doing
identical work it **fell** in two and grew in the third by a sixth as much. Nothing else differs.

⭐ **The tail is far worse than the median, and no live sitting ever reported it.** Median penalty
**2.9x** (37.3 → 108.3ms). At p90, **7.7x** (54.3 → 419.3ms). A buffer is drained by the slow segment,
not the typical one, so the figure that decides a stall is the one nothing had looked at.

⛔ **The unfunded node saturates in about forty seconds and then holds.** Debt climbs steeply, then
oscillates around -1.3 billion for the rest of the arm: an allowance consumed to its limit and spent
at the rate it refills. **The first forty seconds of an unfunded arm are a different regime**, so a
short arm measures the approach rather than the steady state.

⚠️ **What is still genuinely open** is why the unfunded node was 24% faster on one night than another.
It is **not** the debt carried into the arm: starting at -376M, -647M and -850M gave 102, 117 and 106ms
with no ordering. It is the term the deployment decision turns on.

⭐ **The method is the transferable part.** The question was about retrieval, so everything that was
not retrieval was dropped, and the price fell from ~1.3 BZZ and two and a half hours to 0.184 BZZ and
thirteen minutes, with the binding uploader chequebook untouched. Ask what the question actually needs
before booking a sitting for it.

⚠️ **One open difference, deliberately not called an effect.** Ultra-light's median latency sat about
half a second above light's in both comparable pairs. It is not established: round 2's funded arm took
a non-fatal stall, which raises hls.js's latency target permanently (its target reached 7s against
everything else's 6), so the sitting has only **one** comparable 30-minute funded arm and therefore no
within-arm control to weigh the gap against. The latency **floor** was identical across all six arms.
Two more funded arms in one sitting would settle it, for about 0.62 BZZ.

⛔ **LAT-10's 37%-frozen ultra-light figure does not reproduce**, as the reader A/B predicted: across
65 minutes of ultra-light playback at a viewer, nothing froze at all.

**The original question and the design that answered it:** An ultra-light bee node (`--full-node=false`
plus `--swap-enable=false`) has no chequebook and no way to pay a peer for bandwidth, so it lives on
the free allowance alone. If a stream holds on one, an operator can run the viewer path with no chain,
no wallet and no on-chain funding at all, which is a large difference in what it costs to deploy this.

⚠️ **This was measured once, on 2026-08-04, and the answer does not survive.** Three 30-minute runs
found ultra-light **37% frozen against light's 19%**, with 31 peers past half the debt ceiling in the
ultra-light arm and none in the funded one, and a credit jump at every freeze release. The mechanism
is real and the peer-accounting evidence still stands.

**What does not stand is the magnitude at a viewer**, for two reasons found afterwards:

1. Every frozen-share figure in that comparison came through **the bench's `/feeds/` head lookup**,
   which is 50-57% frozen on its own and which a viewer never calls. See
   [the reader A/B](../bench/feed-reader-ab.md).
2. The client has since been fixed to walk the feed rather than take one slot per poll, which changed
   the viewer's fetch pattern completely.

So the honest position is: **credit exhaustion degrades retrieval, and nobody has ever seen what it
does to a picture.** The arms differed through one shared broken instrument, which supports a
direction and not a size.

### The comparison

Flip is one env value and a redeploy: `BEE_GATEWAY_SWAP_ENABLE` in `.env.<profile>`, then
`deploy.sh --profile=latbench --portSlot=7 bee-gateway`.

| arm   | gateway                                                    |
| ----- | ---------------------------------------------------------- |
| **L** | `--swap-enable=true`, funded chequebook. What ships today. |
| **U** | `--swap-enable=false`, no chequebook. bee's ultra-light.   |

**Interleave L, U, L, U in one sitting.** Two sittings of one configuration have differed by 1.05s,
which is larger than most effects this project chases, so arms compared across sittings are not
compared at all.

**Warm each arm after the redeploy.** A restarted bee node has to re-establish peers and performs
differently cold. ⚠️ Task #57 controlled for exactly this and found the warm run slightly **worse**,
so warm-up does not flatter the funded arm.

|     | run | broadcast-min |
| --- | --- | ------------- |

## Phase 0.7 ✅ DONE 2026-08-06 — quality, which no viewer had ever been shown

**Every browser run this project has done was 720p, 2500kbps, 30fps.** That is
`publish-clock.sh`'s default and it was never moved. Segment length is the only variable a viewer has
ever been measured across, which was right while the freeze was being diagnosed and leaves the
standing goal, "best possible quality", untested at the one place it matters.

The encoder grid did sweep resolutions, but it was screened through the bench and **through the
instrument defects since found**, and none of it was ever watched in a browser.

### Why this is not just "run it again at 1080p"

The loop fix changed what quality costs. The client now consumes **every** feed slot, so at 720p it
pulls about 325 kB/s in ~90kB segments with a 160ms median transfer and at most two requests in
flight. 1080p at 6000kbps is roughly **2.4x the bytes**, which lengthens every transfer against a
per-segment budget of 267ms at a 0.25s GOP.

⚠️ **And the failure mode is silent.** Task #76 established that a consumer slower than the stream's
bitrate does not error, it **stretches media time**: the frame rate collapses and segment length
follows, reproduced at 12.2fps against a requested 30. So an over-ambitious quality setting degrades
quality rather than announcing itself, which is exactly the kind of thing only a viewer sees.

### The runs

|     | run | broadcast-min |
| --- | --- | ------------- |

## Phase 0.8 — lowering recovery, which is mostly ours to lower

A freeze is not one thing. It is what the outage costs minus what the buffer absorbs, plus whatever
this side adds on top. Both crash runs reconcile to that identity exactly:

|                 | outage | buffer absorbed | **floor** | measured freeze | **client-side** |
| --------------- | -----: | --------------: | --------: | --------------: | --------------: |
| gateway stopped |  20.5s |            6.1s | **14.4s** |           30.6s | **16.2s** (53%) |
| uploader killed |  15.3s |            7.1s |  **8.2s** |           54.9s | **46.7s** (85%) |

**The floor is physics: you cannot play media that was never written, and an outage shorter than
`LIVE_SYNC_DURATION_S` is invisible to a viewer already.** Everything above the floor is this side's,
and in the uploader case it is six times the floor.

### 0.8a ✅ DONE 2026-08-06 — the walk cannot pass its oldest missing slot (#71), **46.7s → 4.1s**

The walk asks for slot N+1 and stops on a 404, because a 404 is also how a caught-up viewer learns
there is nothing more. Those two cases are indistinguishable from one request, so a slot that will
never be served parks the viewer forever while every later slot sits retrievable and invisible. The
uploader crash measured one address asked **112 times over sixty seconds** while ~175 newer slots
existed.

⭐ **They become distinguishable with one extra request.** A viewer who has caught up sees 404 at N+1
**and** at N+1+D. A viewer stuck behind a hole sees 404 at N+1 and **200** at N+1+D. That is a cheap,
decisive discriminator and it needs nothing from the head lookup.

**On a served probe, jump the index to it.** Nothing is lost by skipping: each feed slot carries a
**full manifest window** of about 36 segments, so a later slot's manifest already names everything the
skipped ones announced that is still inside the window. Anything older than the window is media a live
viewer should not be waiting for anyway. This is the same property that makes `handleInitialFetch`
work.

**Fire the probe only after K consecutive 404s on the same address**, so a normally caught-up viewer
never sends it: live, the publisher writes every 267ms against polls 327ms apart, so the same slot
404ing repeatedly does not happen.

Constants to choose with tests rather than by argument: K, and the probe distance D. D trades
detection speed against how far ahead the publisher must be for the probe to mean anything, and a
natural calibration is that after K polls a healthy publisher has written K more slots.

⚠️ This supersedes the older sketch of re-anchoring through the head lookup on `stalled`. That works,
but it waits 30 polls to declare the stall and then pays for the **slowest** request this deployment
has, the one that is 50-57% frozen. The probe answers in one poll and costs one request.

**Expected: 46.7s becomes a few seconds.** Detection is K polls, the jump is one round trip, and the
walk already drains 16 slots per poll.

### 0.8b ⚠️ DONE 2026-08-06 — the backoff outlives the outage (#85), and the shortfall was the instrument

`MANIFEST_RETRY_BASE_MS = 2000` doubles and is stamped from the failure, so attempts fall at t=0, 2,
6, 14, 30. The gateway returned at 20.5s and the next attempt was not due until 30s. At the
`MANIFEST_RETRY_CAP_MS = 30_000` cap the overshoot can be thirty seconds.

⭐ **The client already knows the gateway is back and does not use it.** While the feed is being held
off, hls.js is fetching **segments** through the same gateway, and those start succeeding the moment
it returns. Nothing wires a successful fragment load back into `FeedHealthTracker`, so the one signal
that would clear the hold is thrown away. `CustomFragmentLoader` is the place it already passes
through.

Secondary, and only if that is not enough: lower `MANIFEST_RETRY_CAP_MS`. The cap exists to bound what
a page of stalled players does to a gateway that is already struggling (LAT-3, whose reason still
holds), but once a live gateway clears the hold instantly the cap only governs a genuinely dead one,
where 8s against 30s is a small absolute difference.

**Expected: 16.2s becomes 1-3 seconds**, the time for hls.js's own fragment retry plus one poll.

### 0.8c The dial that is already free

An outage shorter than `LIVE_SYNC_DURATION_S` never reaches the viewer: the picture kept moving 6.1s
and 7.1s into the two faults, which is the constant spending itself exactly as designed. Raising it
buys outage tolerance and costs latency one-for-one. **Not a fix and not recommended blind**, but it
is the honest third lever and it should be named beside the other two rather than discovered later.

### How it gets verified

Both fixes have a number to move, measured, on a scenario that reproduces on demand:

|      | scenario                | today |   target |
| ---- | ----------------------- | ----: | -------: | ------------ |
| 0.8a | `uploader-crash`        | 46.7s | under 5s | ✅ **4.1s**  |
| 0.8b | `viewer-gateway-outage` | 16.2s | under 3s | ⚠️ see below |

⛔ **0.8b's target was never reachable and the instrument was why.** Recovery was clocked from
`docker start` **returning**, which is when the container exists rather than when the process serves:
the gateway returned at t+79.1s, answered a 503 at t+80.3s and served its first 200 at **t+86.3s**.
Seven of the fourteen seconds were never the client's to spend. Fixed in `169ce9e` and `738d9fd`,
where a scenario declares how to tell its service is answering and both numbers reach the report.

⚠️ Two mechanisms were proposed for the shortfall and the request log refuted both: hls.js does
**not** back off its fragment retries (it asked every 500ms throughout), and **no** player restart
happened. `fragLoadPolicy` was never the lever.

Run each before and after, twice, and read `it moved again, after the service returned` rather than
the freeze length, since the freeze also contains the floor.

⚠️ **Do not edit `ManifestManagement.ts` on reading alone.** Commit `a4f9841`, reverted as `303184c`,
was a client fix written from reading that was wrong. What is different here is that both defects are
measured from request logs and both reproduce on demand.

|
| 0.7a | ✅ **done.** Screened all three at 3 min in one sitting: **all deliver 30.0fps at full resolution, 0 stalled, 0 rebuffers**, and latency across a 2.4x bitrate range differs by **70ms**. | 10 |
| 0.7b | ✅ **done.** 1080p/6000k gated at 10 min: 594 samples, 30.0fps, advance **1.000**, 0 stalled, 0 rebuffers, 0 fatal. [Report](../bench/quality-at-a-viewer-2026-08-06.md). | 10 |
| 0.7c | The best quality that holds at 0.25s against the same quality at 0.5s | 22 |

⭐ **Quality is bought with bandwidth, not with latency: 2.24x the BZZ (0.0170 → 0.0381 per
broadcast-minute) and essentially no seconds.** 1080p at 6000kbps ships.

⭐ **The instrument had to exist first and that is the transferable part.** Quality was judged on
resolution and dropped frames, and #76's failure appears in **neither**: a consumer slower than the
stream's bitrate stretches media time rather than erroring. `deliveredFps` divides the decoder's own
frame count by **media** seconds, because a frozen picture decodes nothing and a wall-time rate would
read a freeze and a collapse as the same number.

⚠️ Sixty minutes has still only been run at 720p/2500k.

**Judge on what arrived, not what was asked for.** The report already carries the decoded resolution,
the dropped-frame count and the delivered bytes per second, so a run that quietly downgraded is
visible as a disagreement between the requested bitrate and the delivered one rather than as a good
result.

0.7c exists because quality and segment length trade against each other through the same budget: if
1080p cannot hold at 0.25s but holds at 0.5s, that is a real product choice between picture and
latency, and it should be made on a measurement rather than on which one was tested first.

|
| 0.6a | 10-minute viewer runs, L U L U | 44 |
| 0.6b | 60-minute viewer run on each arm | 126 |
| 0.6c | `viewer-gateway-outage` and `uploader-crash` on arm U | 20 |

**0.6c is the one with the sharpest interaction.** Task #71 is a viewer blocked on the oldest feed
slot they cannot retrieve. A gateway that cannot pay for bandwidth should meet more of those, so
ultra-light may make the worst known recovery defect substantially worse. That is a prediction, and
the run either shows it or does not.

**Measure the mechanism, not only the outcome.** Sample the gateway's peer debt distribution during
each arm. Credit exhaustion has a signature, peers pinned near the debt ceiling and a credit jump
when a freeze releases, and it is what separates "ultra-light is slower" from "ultra-light is
starved".

⚠️ **The compose file currently asserts the old answer**, in a comment saying a viewer polling an
ultra-light gateway "sees the feed freeze 30 to 48s at a time". That number came through the broken
lookup. Whatever this phase finds, that comment gets rewritten to match it.

⚠️ **`--cache-capacity=0` is set on both arms**, so neither caches anything and every chunk is
re-fetched per viewer. That is a separate variable and a likely large one for concurrent viewers. Not
in this phase, deliberately, because two variables at once answers neither.

|
| 0.5a | ✅ **done 2026-08-06.** 10-minute gate: 0.998, one stall at t=2.2s (the join). | | 13 |
| 0.5b | ✅ **DONE 2026-08-06, and it holds.** 12 windows all at 1.000 or 0.999, **zero frozen samples**, latency drift −0.29s. The predicted manifest-growth degradation is **absent** at 13,522 accumulated segments. [Report](../bench/browser-watch-2026-08-06T02-23-11-449Z.md). | | 63 |
| 0.5c | 60-minute run at 1.0s | The control. Same hour, a quarter of the segments, so a degradation that tracks segment count separates from one that tracks wall clock. | 63 |
| 0.5d | #71 and #85 fixed, each verified before and after | Both are measured, both have a named number to move (46.7s and 16.2s), and both are recovery rather than steady state. | 50 |
| 0.5e | The five remaining crash scenarios, ×2 | Phase 2's list, now that a viewer can be watched through one. | 60 |

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
