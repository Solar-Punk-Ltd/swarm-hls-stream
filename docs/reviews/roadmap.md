# Roadmap

**2026-08-05, re-ordered 2026-08-08.** Ordered by what unblocks what, not by appeal. Every claim below
is either measured and linked, or marked as a guess. Items already tracked carry their task number.

## Order of work, as the owner set it on 2026-08-08

> "let's measure everything what we can here without scaling up then before phase3 we have to make a
> verbose docs with all of our findings that I can give to this other repo... and we want to know how
> the network can handle a high scale streaming event"

⭐ **A second repository will run the thousands-of-viewers simulation.** This one does not scale up. It
measures everything reachable at current scale, and then hands over findings and a method.

⛔ **Nothing here has ever exceeded eight concurrent viewers on one gateway.** Every figure in this
document is 1 to 8. Any claim about a thousand nodes is a prediction until that other repo runs it.

| #     | what                                                                     | gate                    | state                       |
| ----- | ------------------------------------------------------------------------ | ----------------------- | --------------------------- |
| **1** | Free work: the open defects and the instruments that cost nothing        | none                    | ✅ **done**                 |
| **2** | **Phase 0.9**, scale readiness measured at current scale                 | mostly free             | ✅ **done, a-e**            |
| **3** | 0.7c, then 0.5c / 0.5e as the chequebook allows                          | broadcast-min           | ⏸ **owner's call**          |
| **4** | Phase 1.2 / 1.3, the viewer features still unproven                      | a long recording        | ⏸ **owner's call**          |
| **5** | Phase 2, the crash scenarios nobody has run                              | mixed                   | ⏸ **owner's call**          |
| **6** | **The scale-up handover document** for the other repo                    | none, and it lands here | ✅ **written, and revised** |
| **7** | Can a segment be fetched without being announced? The announcement floor | none to measure         | ✅ **answered**             |
| **8** | Phase 3, OME to parity and the engine comparison                         | **last**                | ⏸ deferred                  |
| **9** | Phase 4, LL-HLS                                                          | **last**                | ⏸ deferred                  |

⭐ **Steps 1, 2 and 6 are done and every one of them was free.** Step 6 landed early rather than last,
because the free work kept producing findings that belonged in it.

⛔ **Steps 3, 4 and 5 all need broadcast minutes against a chequebook that binds at roughly 64 of
them.** They are not blocked on work, they are blocked on a spending decision that is the owner's.

✅ **Step 7's floor is measured, for nothing, off the archived request logs.** It is a **miss** floor:
at the live edge a not-found slot read costs 4.5x a successful one and about 45% of reads are
not-founds. ⛔ **That is a problem for the proposal it was meant to support**, because a computed-address
segment feed pays the same cost. See Phase 2.6.

✅ **Step 7 is answered end to end**, including read-ahead distance, which is flat because addresses are
hashes. ⛔ **What is left of it is not a measurement, it is a design decision**: the computed-address
segment feed buys a hop and not a rate, and getting past the floor needs a push primitive rather than a
cheaper poll. **That is the owner's call, and GSOC is unmeasured.**

⚠️ **The uploader chequebook is the binding constraint on steps 3 and 5**, at roughly 64
broadcast-minutes against 145 the remaining measured items ask for. Postage is not binding. Which of
them gets bought is the owner's call, never mine.

## Where the product actually is

|                     | state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine              | **SRS works.** OME is at **6 of 11** e2e and must not be called working.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| LL-HLS              | **Not implemented and not configured.** `OmeHlsPuller` reads `ts:playlist.m3u8`, OME's MPEG-TS playlist. No `<LLHLS>` publisher exists in `Server.xml.template`. Neither engine transcodes: both set bypass and remux the broadcaster's own streams.                                                                                                                                                                                                                                                             |
| Live latency        | **1.074s** capture-to-fetchable at 720p 2500kbps, 0.25s GOP, [gated over three 10-minute runs](../bench/ten-minute-gate-2026-08-05.md) with a 29ms spread and no drift. ✅ **Glass to glass at a viewer is 6.4 to 7.3s and flat**, read off a burned-in clock, [after the client fix](../bench/the-loop-fixed-2026-08-05.md). It was 17.9s and growing before it.                                                                                                                                                |
| What a viewer sees  | ✅ **1.000 and 1.003 media seconds per wall second at 0.25s, nothing frozen, no rebuffers**, holding 5.86s behind live against a 6s target. It was 0.82x and 17.3% frozen: the client took one feed slot per playlist reload. [Fixed and measured](../bench/the-loop-fixed-2026-08-05.md), [diagnosed](../bench/what-starves-the-viewer-2026-08-05.md).                                                                                                                                                          |
| Which profile ships | ✅ **0.25s GOP, and 1080p at 6000kbps with it.** Gated at ten minutes at a viewer: 30.0fps, advance 1.000, nothing stalled, nothing rebuffered. Latency across a 2.4x bitrate range differs by 70ms, so the best picture costs bandwidth (2.24x the BZZ) rather than seconds.                                                                                                                                                                                                                                    |
| Seeking             | ✅ **A recording plays and seeks**, five runs, every seek landing in 17-48ms and resuming in 338-359ms. ⚠️ Still unreached: seeking **past a discontinuity** and into a region **whose chunks left the local gateway**, because a 27-second recording fits in the buffer whole. ⭐ The client uses `HashRouter`, so a watch URL is `#/watch/...` and the path form silently renders the catalog.                                                                                                                 |
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

⛔ **The median was the wrong statistic all along, and every figure in the table above is one.** What
decides a stall is not how long a typical segment takes but **how many miss the budget**. Against the
267ms an eight-frame GOP allows, the funded arms ran **0.3%** late and the unfunded ones **15.0%**: a
**45x** penalty where the median shows 2.9x and p90 shows 7.7x. One segment in five arriving late is
not a slower stream, it is a draining buffer.

⭐ **It reframes the open term too.** The three unfunded arms differ by 15% at the median and by
**2.3x** in late share. Whatever moves between unfunded runs moves the **tail**, not the body, so a
comparison built on medians was never going to see it. The 24% between-night gap and this
within-sitting spread are plausibly the same thing measured badly.

⛔ **The unfunded node saturates in about forty seconds and then holds.** Debt climbs steeply, then
oscillates around -1.3 billion for the rest of the arm: an allowance consumed to its limit and spent
at the rate it refills. **The first forty seconds of an unfunded arm are a different regime**, so a
short arm measures the approach rather than the steady state.

### ⭐ The open term, answered from the archive for nothing

[What separates a collapse from a clean run](../bench/what-separates-a-collapse-from-a-clean-run-2026-08-08.md),
read out of the `.requests.json` companions already in this repository.

**It is not the median. It is the rate of one-second retrievals.**

| arm            |    median | over budget | **≥1s per 1000** | outcome                   |
| -------------- | --------: | ----------: | ---------------: | ------------------------- |
| 08-06 unfunded | 156-172ms |      32-33% |   **17.4, 21.7** | ⛔ 3 and **17 rebuffers** |
| 08-08 unfunded | 132-146ms |      23-24% |     **0.5, 1.6** | ✅ clean                  |
| either, funded |   63-91ms |    0.4-2.8% |          0.0-1.2 | ✅ clean                  |

⭐ **Between the two nights the median moved 1.18x and the one-second rate moved 10 to 40x.** On
2026-08-08 the unfunded arm had **fewer** one-second stalls than the funded arm.

⚠️ **Every one of them is 1.0 to 1.1s** — a retry timer, not a slow transfer — and **they arrive in
bursts**: six of twelve inside a 3% window of one arm. One costs a 267ms-budget player four segments,
which a 4.8s buffer absorbs. Six in a row is a rebuffer. Twelve events in 689 requests is 1.7% of
them, so they cannot move a median and they are the entire failure.

⛔ **It is not the debt carried into an arm either**: starting at -376M, -647M and -850M gave 102, 117
and 106ms with no ordering.

✅ The standing answer is firmer, not weaker. The failure is not a uniformly slower stream, which a
bigger buffer would cover. It is **bursts of second-long stalls at a rate that varies 40x for reasons
nothing controls**. A 1.0s GOP still absorbs it, and now for a legible reason: one second against a
1000ms budget costs one segment rather than four.

### ⭐ Eleven unfunded arms: no setting makes it reliable

[Eleven unfunded arms](../bench/eleven-unfunded-arms-2026-08-08.md), one node, two hours, the same 800
references every time. The eight arms after the first sitting **cost nothing at all**.

⛔ **The refill hypothesis is refuted twice over.** Debt read -1,357,400,000 PLUR at the end of an arm
and -1,357,270,000 at the start of the next, **fifteen minutes of idle later**: there is no time-based
settlement at this timescale. And idle changes nothing a viewer would feel, 15 minutes being
indistinguishable from one and 90 seconds from none.

⛔ **Debt level is not the dial either.** Debt saturates near -1.4 billion, and the three arms **pegged
at that ceiling were the best of the eleven** at 1.9-3.4% late.

⭐ **The late share ranged 1.9% to 19.5% across eleven arms of identical work in under two hours.** A
tenfold spread that none of idle, debt or arm order accounts for.

⚠️ A container recreate is the strongest lead: the three arms on a continuously running node are the
three best, and every arm above 8% followed a recreate. One recreated arm at 3.0% does not fit, so it
is a lead rather than a finding.

⛔ **This answers the deployment question more firmly than a cause would. There is no operator setting
that makes an unfunded gateway reliable**, and the spread is wider than the margin a viewer needs.

### ⭐⭐ SETTLED: it is starved, and bee counts it

[Why an unfunded gateway is slow](../bench/why-an-unfunded-gateway-is-slow-2026-08-08.md), read from
**bee's own counters** rather than from the browser.

| arm      |  chunk requests | **peers skipped for accounting** | **loop iterations per request** |
| -------- | --------------: | -------------------------------: | ------------------------------: |
| funded   | 20,940 / 20,957 |                 **5** and **22** |                        **1.14** |
| unfunded |          20,957 |      **799,072** and **773,898** |         **39.41** and **38.22** |

`bee_accounting_accounting_blocks_count` is bee's own words for it: _"temporarily skipping a peer to
avoid crossing their disconnect thresholds"_.

⭐ **An unfunded node skips a peer for accounting reasons ~37 times per chunk.**

⛔ **CORRECTED 2026-08-08: those are loop iterations, not requests on the wire.** Bee increments
`PeerRequestCounter` and `totalRetrieveAttempts` **before** the `prepareCredit` call that decides
whether to contact the peer, so every skip is counted and never sent. Real peer contacts are attempts
minus skips: **1.281 and 1.296 per chunk unfunded against 1.142 funded**, so the network sees about
**13% more load, not 34x**. Corroborated by rate, since 825,931 requests in 151s would be 5,470 a
second.

⭐ **The 37 extra iterations are local, so a fleet of unfunded nodes is bounded by host CPU and node
density rather than by network capacity.** That is the load-bearing input to any thousands-of-viewers
plan, and it is the opposite of what the uncorrected reading implied.

⚠️ **It is not failure, it is the work of avoiding failure**: request failure rates are
indistinguishable, 7.1% funded against 7.4% unfunded.

⚠️ **Time-settlement is demand-driven, not idle-driven.** Unfunded arms sent 10,512 and 10,332
pseudo-settlements against 909 and 1,005. That is why fifteen minutes of idle refills nothing: bee
settles when it needs headroom with a peer, so an idle node settles nothing because it needs nothing.

✅ **"Slower" versus "starved" is now separated, and it is starved.** The chain is complete and every
step has a number: cannot settle → sits at every peer's disconnect threshold → 786,000 skips per arm →
38 peer-selection iterations per chunk, of which 1.28 reach a peer → usually an eligible peer is found
fast (so the median barely moves) → sometimes they run out and a retry timer fires at 1.0-1.1s →
bursts of those drain a 4.8s buffer.

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

### Phase 0.7's runs

| run  | what                                                                                                                                                                                      | broadcast-min |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 0.7a | ✅ **done.** Screened all three at 3 min in one sitting: **all deliver 30.0fps at full resolution, 0 stalled, 0 rebuffers**, and latency across a 2.4x bitrate range differs by **70ms**. | 10            |
| 0.7b | ✅ **done.** 1080p/6000k gated at 10 min: 594 samples, 30.0fps, advance **1.000**, 0 stalled, 0 rebuffers, 0 fatal. [Report](../bench/quality-at-a-viewer-2026-08-06.md).                 | 10            |
| 0.7c | The best quality that holds at 0.25s against the same quality at 0.5s                                                                                                                     | 22            |

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

### Phase 0.6's runs

⚠️ **All three are superseded by what the node-side counters answered for 0.295 BZZ.** Kept because
0.6c is still unrun and still the sharpest interaction on the list.

| run  | what                                                  | broadcast-min |
| ---- | ----------------------------------------------------- | ------------- |
| 0.6a | 10-minute viewer runs, L U L U                        | 44            |
| 0.6b | 60-minute viewer run on each arm                      | 126           |
| 0.6c | `viewer-gateway-outage` and `uploader-crash` on arm U | 20            |

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

### Phase 0.5's runs

| run  | what                                                                                                                                                                                                                                                                         | why it is on the list                                                                                                                    | broadcast-min |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 0.5a | ✅ **done 2026-08-06.** 10-minute gate: 0.998, one stall at t=2.2s (the join).                                                                                                                                                                                               |                                                                                                                                          | 13            |
| 0.5b | ✅ **DONE 2026-08-06, and it holds.** 12 windows all at 1.000 or 0.999, **zero frozen samples**, latency drift −0.29s. The predicted manifest-growth degradation is **absent** at 13,522 accumulated segments. [Report](../bench/browser-watch-2026-08-06T02-23-11-449Z.md). |                                                                                                                                          | 63            |
| 0.5c | 60-minute run at 1.0s                                                                                                                                                                                                                                                        | The control. Same hour, a quarter of the segments, so a degradation that tracks segment count separates from one that tracks wall clock. | 63            |
| 0.5d | #71 and #85 fixed, each verified before and after                                                                                                                                                                                                                            | Both are measured, both have a named number to move (46.7s and 16.2s), and both are recovery rather than steady state.                   | 50            |
| 0.5e | The five remaining crash scenarios, ×2                                                                                                                                                                                                                                       | Phase 2's list, now that a viewer can be watched through one.                                                                            | 60            |

**Read the windows, not the median.** A run that is perfect for its first half and rebuffering
through its second has a respectable median and is a broken stream, which is why `stability.ts` cuts
a run into five-minute windows and reports each on its own.

## Phase 0.9 — scale readiness, measured here so the other repo does not have to guess

**Added 2026-08-08.** A second repository will run thousands of light nodes against a high-scale
streaming event. This phase answers, at current scale, the questions whose answers change that design,
and it ends in a handover document rather than in a deployment.

⛔ **The premise correction that reshapes all of it.** `bee_retrieval_peer_request_count` counts
peer-selection **loop iterations**, not requests on the wire, because bee increments it before the
`prepareCredit` call that decides whether to contact the peer. Real contacts are attempts minus skips:
**1.28-1.30 per chunk unfunded against 1.14 funded**. So an unfunded fleet adds about **13%** network
load, and its 37 wasted iterations per chunk are **local**.

⭐ **Therefore the constraint on running many unfunded nodes is host CPU and node density, not network
capacity.** Nothing has measured that spin's CPU cost, and it is now the first thing worth measuring.

### 0.9a ✅ DONE 2026-08-08 — it is a switch, and it flips at zero

[Report.](../bench/the-funding-cliff-is-at-zero-2026-08-08.md) The chequebook was drained to a known
balance by the owner and sampled every five seconds beside the retrieval counters.

| chequebook available |    median | over 267ms | first-peer service | skips per chunk |
| -------------------: | --------: | ---------: | -----------------: | --------------: |
|         **0.05 BZZ** |  **43ms** |   **0.1%** |          **87.6%** |        **1.56** |
|    **0.0000004 BZZ** | **109ms** |  **10.6%** |          **12.5%** |        **39.8** |

⭐ **0.05 BZZ performs exactly like 6.4 BZZ**, and an empty chequebook performs exactly like no
chequebook. **Balance buys nothing except time**, so `BZZ per node = burn rate x duration`, which at
0.0102 BZZ/min is 1.22 BZZ for a two-hour 720p gateway.

⛔ **It is the failure with no alarm.** A node that runs dry answers `/health` in 1.1ms with 134 peers
and takes its viewers from 0.1% late to 10.6%. **Alarm on `chequebookAvailableBzz`.**

### 0.9a-ii Superseded design notes

The mechanism is **cannot settle**, not **is poor**. Debt saturates near -1.4 billion PLUR and the
three arms **pegged at that ceiling were the best of eleven**, so the balance is demonstrably not the
dial. If any ability to issue a cheque restores 1.14 iterations per chunk, then a thousand-node event
needs a trivial deposit per node rather than a funded chequebook per node, and that is the single
largest lever on what such an event costs.

Arms at several deposit sizes through `retrieval-debt-probe.sh`, reading
`gateway-retrieval-metrics.sh` per arm. ⛔ Needs owner approval before any deposit: bring exact
commands, fund nothing.

### 0.9b ✅ DONE 2026-08-08, extended 2026-08-09 — size the cache for the hot set

Three sittings, all free. [Eviction.](../bench/a-cache-that-does-not-fit-does-nothing-2026-08-08.md)
[The bisect that located the cliff.](../bench/the-cache-cliff-is-at-one-hundred-percent-2026-08-08.md)
[The access pattern.](../bench/the-cache-cliff-belongs-to-the-access-pattern-2026-08-09.md)

Under a **cyclic scan** the cliff is a step at exactly 100% of the working set: 76% is byte-identical
to no cache, 100.1% buys the whole benefit, and above that buys nothing. ⛔ **That turned out to be a
property of the access pattern rather than of the cache.** Give the same 76% capacity a skewed pattern
and it removes **36.8% of retrievals** with a lap-two median of **4ms**, which is what a correctly
sized cache does.

⭐⭐ **So size for the hot set, not the working set.** A cyclic scan has no hot set, every reference
being equally popular, so its hot set is its working set and the step is that special case. ⬅ Where
the new cliff sits, between the hot set and the 3.8x it that was tested, is open and cheap.

### 0.9c ✅ DONE 2026-08-08, free — sixteen viewers cost the network what one costs

[Report.](../bench/sixteen-viewers-cost-what-one-costs-2026-08-08.md) Concurrency alternated 1, 2, 1,
4, 1, 8, 1, 16 against an unfunded gateway. **Network peer contacts held at 3,167 to 3,287 while
retrieval operations moved 15x**, so bee fetches each distinct chunk once and serves every concurrent
viewer from it. Throughput scaled **16.7x** with a flat median. The late share roughly doubled, 4.0%
to 8.9%, and that is the real cost.

⭐⭐ **Pool viewers behind gateways, never one bee node per viewer**: ~25-30 viewers per 48-core host
one-node-each against **~400** at sixteen-per-node.

⛔ **It corrected two figures from earlier the same day.** "37 skips per chunk" and "1.28 contacts per
chunk" are rates divided by whatever throughput their arm ran at. Valid for the single-viewer arms
they came from, not general. ⬅ Nothing above 16 is measured, and this sweep cannot see feed staleness,
which LAT-11 found goes 1.30x at eight.

### 0.9c-ii ✅ DONE 2026-08-08, free — the knee is a byte rate

[The ceiling.](../bench/the-ceiling-is-bytes-not-viewers-2026-08-08.md)
[What actually limits it.](../bench/a-synchronised-audience-is-the-failure-2026-08-08.md)

**Throughput plateaus at 43 to 44 MB/s** across four concurrencies and both rounds. At 2.83 Mbps per
viewer that is **~123 viewers**, bracketed exactly by 128 holding at zero buffer drain and 192 draining
in both rounds. ⛔ **It is internal to bee**: at 512 viewers bee used ~6 of 48 cores, host load peaked
at 36 of 48, and 43 MB/s is 344 of 1000 Mbps. **Not a capacity that can be bought.**

⭐⭐ **What decides whether an audience is served efficiently is cohort size**, meaning how many
viewers want the same chunk at the same instant. 128 in cohorts of 8 are comfortable, 128 on one tick
drain 12.8 seconds of buffer, and ⛔ **client-side jitter was shipped as the fix and then measured
doing nothing**, because the constraint is chunk diversity rather than arrival instant.

⬅ Still open above 8: **feed staleness**, which LAT-11 put at 1.30x and no reference-list probe can
see.

⚠️ **Use the alternating-block design, never a ladder.** Relabelling eight unchanged past runs as if
the viewer count had varied moved the metric by up to 1.95x with nothing happening, so a ladder cannot
resolve anything under ~2x.

### 0.9d ✅ DONE 2026-08-08, free — the CPU model, halved by pacing

The probe now samples host load every two seconds during every arm (#112), so a starved probe client
can no longer be mistaken for a slow gateway, and the same sampler is the neighbour-safety ceiling that
keeps an unattended sweep off the other forty bee nodes on the host.

⛔ **Every arm before this fetched flat out, which is a load generator rather than a viewer.** Paced
properly the model is **~0.67 cores fixed plus ~0.046 per viewer**, against the ~1.5 + ~0.07 published
before. ⭐ The control that makes it credible is that the same sitting's flat-out arms reproduce the
old model. **Per-MB figures are duty-cycle insensitive and all stand. Per-viewer figures halve.**

### 0.9e ✅ DONE 2026-08-08 — the node's own retrieval duration histogram

Shipped in the metrics reducer as `durSum`, `durCount`, `durLe0p25` and `durLe1`, so
`durCount - durLe1` is **the node's own count of retrievals that took a second or more**, which is the
statistic a median cannot see. ⚠️ ⬅ The retry timer's **wall-clock shape** is still inferred from the
client side. The count is now measured at the node, the shape is not.

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

### 1.2 ✅ mostly done 2026-08-06 — a recording plays and seeks

`pnpm browser:vod`, five runs against two recordings. **Every seek lands in 17-48ms and resumes in
338-359ms**, forward and backward, with no `pause` event in the whole run.

⭐ **The harness could pass by reaching less**, and did once: targets computed off `duration` (which is
not stable) tested three positions well inside the buffer and reported a clean sweep. Compute off
`seekable`.

⚠️ **Still unreached, and both need a longer recording than 27 seconds**: seeking **past a
discontinuity**, and seeking into a region **whose chunks have left the local gateway**. On a recording
that fits in the buffer whole the harness asks both questions and neither is exercised.

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

### 1.4 ✅ DONE — shipped as 0.8a, **46.7s → 4.1s**

`handleFollowupFetch` pinned its slot and re-asked it forever, so a viewer's recovery was bounded by
the oldest slot they could not retrieve rather than by the outage. Fixed by probing N+1+D after K
consecutive 404s and jumping the index to whatever answers, which needs nothing from the head lookup.
See 0.8a for the full reasoning.

⚠️ The older sketch here proposed re-anchoring through the head lookup on `stalled`. That works and
was **not** what shipped: it waits 30 polls and then pays for the slowest request this deployment has.

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

## Phase 2.5 — the scale-up handover document

**Added 2026-08-08, and it is a gate on Phase 3 rather than a nice-to-have.** The other repository
needs to run a multi-stage, thousands-of-viewers load test, and everything it needs to avoid paying
for the same lessons twice is in this one, scattered across twenty bench reports.

⭐ **It is one verbose standalone document, readable by someone with no context on this repo**, and it
covers four things:

1. **Every finding**, with its measurement, its cost and its confidence. Including the ones that are
   corrections: the median was the wrong statistic, the skip counter is loop iterations, SRS declares a
   segment duration 20-25% too long, and one non-fatal stall permanently raises hls.js's latency
   target.
2. **How to scale up**, meaning the topology choices and what each one buys. One node per viewer
   against pooled gateways, funded against unfunded, cache on against off.
3. **How to design the load test**: arm selection, warm-up, interleaving, and how to establish a noise
   floor before trusting any design.
4. **What to measure, on the network and on the nodes**: the exact bee counters, the reduction
   commands, the statistic definitions, and the traps that make a check report nothing and read as a
   pass.

⛔ **It must say plainly what this repo has never done.** Nothing here has exceeded eight concurrent
viewers. Every scale claim it carries is a prediction with a mechanism behind it, not a result, and
the document is worthless if a reader cannot tell those apart.

## Phase 2.6 — can a segment be fetched without being announced?

**Moved out of Phase 4 on 2026-08-08 at the owner's direction**, because it is the question Phase 4
turns on and it can be measured long before anyone builds LL-HLS.

### ✅ The floor is measured 2026-08-09, and it is a MISS floor

[Full report.](../bench/the-announcement-floor-is-a-miss-floor-2026-08-09.md) **78,482 feed slot reads
taken from the 70 archived request logs. No run, and nothing spent.**

The floor on record was about **3.8 slot reads a second** because a slot read costs roughly 260ms. What
that 260ms is made of turns out to decide the whole question.

| regime, by miss rate      | logs | hit, median of medians | miss, median of medians |  miss/hit |    slower in |
| ------------------------- | ---: | ---------------------: | ----------------------: | --------: | -----------: |
| **behind the edge**, <10% |   29 |              **244ms** |               **215ms** |     0.87x |      8 of 29 |
| **at the edge**, >30%     |   14 |              **118ms** |               **496ms** | **4.51x** | **14 of 14** |

⭐⭐ **At the live edge a miss costs 4.5x a hit, in every one of fourteen logs, and behind the edge it
costs slightly less than a hit.** A walk finds the head by reading until it 404s, so a viewer at the edge
misses about **45%** of the time. At `0.454 x 496 + 0.546 x 118` that is **~289ms per read, or 3.5 a
second**, which reconstructs the 3.62 to 3.77 measured directly.

⭐ **Not-found has a characteristic cost of about 490ms**, with 66.4% of misses in a single 400-599ms
band. A bounded search rather than a timeout or an unbounded one.

⛔ **So the floor is not the price of reading a feed. It is the price of asking for a slot nobody has
written**, roughly every other read at the live edge.

### ⛔⛔ Which is a problem for the proposal, and it was not obvious

**The proposal, which is still a proposal.** Segments are content addresses today and therefore
unpredictable, but they could be written as SOCs at computed addresses exactly as manifests already are.
A client that walks the **segment** feed skips the manifest entirely at the live edge. Cost: a SOC write
per segment instead of a plain upload.

⛔ **It does not remove the dominant cost, because predictable addresses are precisely what let a client
ask for something that does not exist yet.** A segment feed walked at the live edge does the ~490ms
not-found thing at least as often as the manifest feed does. **The floor moves across unchanged.**

⭐ **What the proposal does buy is a hop, not a rate**: the manifest read leaves the critical path. Worth
having, and not what the floor is made of.

⭐⭐ **The way past a miss floor is not a cheaper poll, it is not polling.** A push primitive lets a
publisher say "slot N exists" instead of every viewer discovering it by failing to find slot N+1.
⚠️ Swarm has GSOC and **nothing here has measured it**, so that is a direction rather than a finding.

⚠️ **It also sharpens Phase 4.** If the read floor is speculative misses at the edge, cutting segments
into smaller parts **increases the number of speculative reads**. ⬅ Whether that is a wash or a loss is
the thing to measure before anyone builds LL-HLS.

✅ **Replicated on the direct path, and it is worse there.** Four alternating blocks of 100 reads
straight at the gateway: **miss 459 and 483ms across two runs, hit 4 and 7ms, a 66x to 121x ratio.**
⭐⭐ The miss cost is the same on both paths (483 direct against 496 through the browser) while the hit
cost is 17 to 30x apart, so **the floor is a gateway-side cost and nothing a client does will move it.**

✅ **And reading ahead by more than one slot is no cheaper per slot.** A single-owner chunk's address is
a hash of its identifier and its owner, so slot N+1 and N+100 sit at unrelated addresses. **Read-ahead
by N costs N misses, linearly.**

⭐⭐ **A miss costs no BZZ at all.** Per-block attribution: 100 hits spent one cheque of 615,000,000,000
wei, and **both miss blocks and the second hit block spent nothing**, as did every idle control. A
not-found delivers no bytes, so no peer is owed. ⛔ A whole-run delta said the opposite and was wrong,
because spending is lumpy and quantised. **So speculative reads are free in money and expensive in
time**, and ⚠️ the 43-44 MB/s throughput ceiling cannot see them at all, because they move no bytes.

## Phase 3 — OME, then the engine comparison ⏸ **deferred to last, 2026-08-08**

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

## Phase 4 — LL-HLS, and why it is last ⏸ **deferred to last, 2026-08-08**

⚠️ **The question this phase turns on now lives in 2.6** and should be answered before any of the
below is acted on.

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
