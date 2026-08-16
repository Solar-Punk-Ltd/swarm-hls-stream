# The bench corpus, indexed

> ## ⛔⛔⛔ READ BEFORE TRUSTING ANY ROW THAT SAYS "IN-TAB"
>
> Every in-tab result in this index measured a **hybrid client**: segment bytes from the node, **feed
> and manifest still from a bee gateway**. That split was an unauthorised design decision of mine in
> PR #183, taken two days after an instruction to measure Abel's setup as it is.
>
> The arm-to-arm contrasts are clean, because both conditions read the manifest the same way. The
> **saving figures are lower bounds**, because a genuinely gateway-less client removes the residual
> the hybrid keeps. See
> [`abel-gateway-less-live-2026-08-16.md`](abel-gateway-less-live-2026-08-16.md), which also records
> that Abel's live page did **not** reach playback in the observed window.


**147 tracked finding documents.** This index exists because they sat flat in one directory with no
map, and a 2026-08-15 audit found claims that had been retired years-of-corpus-time earlier still
reading as live because nobody landing on the file could tell.

⭐ **Status column, and what it means for reading:**

| | |
| --- | --- |
| *(blank)* | live. Still the best answer this corpus has to its question |
| ⚠️ superseded | correct as the record of what it measured, replaced as the answer. **It carries a banner saying by what** |
| ⛔ withdrawn | the headline is false. Kept because a withdrawal is evidence |
| 📋 plan | a design, a handover or a process document, not a measurement |
| ✏️ | **corrected 2026-08-15**, in the sweep that produced this index |

⛔⛔ **A document is not wrong because it is old, and not right because it is recent.** Where two rows
below disagree, prefer the one whose conditions match the question, and check whether the newer one
cites the older one correctly. The audit found that citation is where this corpus goes wrong most.


## What a viewer actually gets

The player, the buffer, and what a person watching sees.

| date | what it establishes | |
| --- | --- | --- |
| 2026-08-12 | [A stall costs at most one #EXT-X-TARGETDURATION, so 1.0s at the shipped 0.5s GOP, but it ratchets to 3.0s permanently after one force-close](stall-penalty-and-the-runtime-sweep-2026-08-12.md) |  |
| 2026-08-12 | [A viewer never trims its manifest: 0.76ms and 774KB at 1 hour, 13.90ms and 7.6MB at 10 hours, priced by segment count not segment length](manifest-growth-2026-08-12.md) |  |
| 2026-08-12 | [The 6s player buffer can be cut to 2s for nothing, and 1.5s costs on both axes: latency turns back up from 2.03s to 2.52s.](buffer-sweep-2026-08-12.md) |  |
| 2026-08-12 | [Stall counts of 0 to 2 over three 300s arms cannot separate a 0.3/arm rate from 0.6, so this sitting cannot settle what a 6s buffer buys.](buffer-sweep-2026-08-12-what-it-settles.md) |  |
| 2026-08-12 | [Scored on stalls, 6s down to 2s costs nothing and 1.5s stalls in two of three counted arms, and the latency column cannot locate the floor.](browser-buffer-sweep-2026-08-12T13-11-53-255Z.md) |  |
| 2026-08-09 | [A viewer does seek across a discontinuity; the opposite claim died to a replicate, and a ~200s recording fails to load outright 1 run in 3](seeking-a-long-recording-2026-08-09.md) |  |
| 2026-08-07 | [The overlay's silence is its poll-counted threshold: 30 polls is ~8s healthy but ~32s during the very fault it exists to detect](overlay-silence-during-a-crash-2026-08-07.md) |  |
| 2026-08-07 | [One non-fatal stall raises hls.js's latency target by up to one targetduration permanently, and every instrument in this project was blind to it](one-stall-costs-a-second-2026-08-07.md) |  |
| 2026-08-07 | [A 3-minute 1s-GOP 720p run: ratio 1.004, 0 stalls, target held at 6.00s, median 5.54s behind live.](browser-watch-2026-08-07T14-14-21-869Z.md) |  |
| 2026-08-07 | [A 1s-GOP 1080p viewer took 131 buffer stalls and 144 rebuffers (87.9s): ratio 0.942, 15 seeks skipping 65.6s, latency drifted +4.45s.](browser-watch-2026-08-07T10-32-55-185Z.md) |  |
| 2026-08-07 | [20 min at a 0.25s GOP, 1080p: ratio 1.000, 0 stalls, target held at 6.00s, median 5.82s behind live.](browser-watch-2026-08-07T10-09-18-102Z.md) |  |
| 2026-08-07 | [A 1s-GOP 1080p viewer joined 37.00s behind, hls.js seeked to the edge, then held: ratio 1.001, 0 stalls, median 5.90s.](browser-watch-2026-08-07T09-47-47-623Z.md) |  |
| 2026-08-07 | [A 0.25s-GOP 1080p viewer joined 247.69s behind and never recovered: ratio 0.207, 937 of 1182 samples frozen, target ratcheted to 7.00s.](browser-watch-2026-08-07T09-26-36-552Z.md) |  |
| 2026-08-07 | [A 2.5-minute 0.25s-GOP 1080p run: ratio 1.018, 0 stalls, target held at the configured 6.00s, median -0.04s against it.](browser-watch-2026-08-07T09-22-33-348Z.md) |  |
| 2026-08-07 | [20 min at a 0.25s GOP, 1080p: ratio 1.000, 0 rebuffers, joined 9.33s behind and held a 6.81s median.](browser-watch-2026-08-07T05-58-55-646Z.md) |  |
| 2026-08-07 | [20 min at a 1s GOP, 1080p: ratio 1.001, 0 frozen samples, 0 rebuffers, median 5.04s behind a 6s target.](browser-watch-2026-08-07T05-38-05-913Z.md) |  |
| 2026-08-07 | [20 min at a 0.25s GOP, 1080p: ratio 1.001, 0 rebuffers, joined 9.33s behind and settled to a 5.89s median.](browser-watch-2026-08-07T05-17-00-109Z.md) |  |
| 2026-08-07 | [20 min at a 0.25s GOP, 720p: ratio 1.001, 0 frozen samples, 0 rebuffers, median 5.86s behind a 6s target.](browser-watch-2026-08-07T03-50-48-906Z.md) |  |
| 2026-08-07 | [20 min at a 1s GOP, 720p: ratio 1.001, 0 frozen samples, 2 rebuffers totalling 749ms, median 5.52s behind a 6s target.](browser-watch-2026-08-07T03-29-36-844Z.md) |  |
| 2026-08-07 | [20 min at a 0.25s GOP, 720p: ratio 1.001, 0 frozen samples, 0 rebuffers, median 5.86s behind a 6s target.](browser-watch-2026-08-07T03-08-34-009Z.md) |  |
| 2026-08-07 | [An hour at a 1s GOP holds ratio 1.000, 0 frozen samples, 0 rebuffers, median 5.28s behind a 6s target.](browser-watch-2026-08-07T02-01-57-110Z.md) |  |
| 2026-08-06 | [1080p/6000k arrives intact: 30.0fps of media, 5.84s behind live, holding for two hours. Quality is bought with bandwidth, not latency](quality-at-a-viewer-2026-08-06.md) |  |
| 2026-08-06 | [A 0.25s-GOP viewer froze: 0.337 media seconds per wall second over 449s, 293 of 444 samples not advancing, 56.60s behind live.](browser-watch-2026-08-06T10-24-24-325Z.md) |  |
| 2026-08-06 | [An hour at 1080p holds 1.000 advance with one 352ms rebuffer, 30.0 fps and a 5.72s median behind live.](browser-watch-2026-08-06T09-21-10-388Z.md) |  |
| 2026-08-06 | [A 450s watch of a broadcast that ends: the join clamped to 4.97s and latency ran to 216.18s, and every summary figure here is superseded. → `a-broadcast-that-ends-2026-08-06.md`](browser-watch-2026-08-06T08-55-10-332Z.md) |  |
| 2026-08-06 | [An hour at 1080p holds 1.000 advance with five rebuffers totalling 7.5s, 30.0 fps and a 5.68s median behind live.](browser-watch-2026-08-06T07-26-32-437Z.md) |  |
| 2026-08-06 | [Ten minutes at 1080p holds 1.000 advance with zero rebuffers, 30.0 fps delivered and a 5.77s median behind live.](browser-watch-2026-08-06T06-21-17-165Z.md) |  |
| 2026-08-06 | [An hour at 720p and a 0.25s GOP holds 1.000 media seconds per wall second with one 246ms rebuffer and a 5.59s median behind live.](browser-watch-2026-08-06T02-23-11-449Z.md) |  |
| 2026-08-06 | [A viewer parked on an ended broadcast sends nothing at all, 0.00 reads/s, but is silently rewound to zero and replays the whole thing.](a-broadcast-that-ends-2026-08-06.md) |  |

## Encoding: GOP, fragments and profiles

The one set of knobs a broadcaster actually turns.

| date | what it establishes | |
| --- | --- | --- |
| 2026-08-10 | [1.0s/720p is the worst of three profiles at p≈0.02 and an unfunded node does not drift over 2h, but 'bytes not duration' is NOT a result of this design](golden-zone-2026-08-10.md) | ✏️ |
| 2026-08-12 | [Capture-to-fetchable is a duration you wait out plus fetch scaling at ~2.4 ms/KB, so two thirds of a long GOP's penalty is arithmetic](what-latency-is-made-of-2026-08-12.md) |  |
| 2026-08-12 | [The shipped 0.5 fragment settles exactly on 0.500s, and segments overshoot the settled value by a constant ~0.135s no median could see](shipped-fragment-validation-2026-08-12.md) |  |
| 2026-08-12 | [Registers four arms separating path (H1: only bench-on-host stretches) from recipe (H2: both stamped arms stretch) before any arm ran](segment-stretch-prediction-2026-08-12.md) | 📋 plan |
| 2026-08-12 | [It is our own wallclockPublisher: epoch stamps defeat ffmpeg's realtime brake, so send-side backpressure is written into the media timeline](segment-stretch-2026-08-12.md) |  |
| 2026-08-12 | [The 404 share tracks the report schema, not the GOP, so the n=8 corpus replication is withdrawn and only the within-sitting contrast holds](quarter-second-404s-corpus-check-2026-08-12.md) |  |
| 2026-08-12 | [Registers that #EXT-X-TARGETDURATION reads 1 at a 0.5s GOP and 3 at 2.0s, and that a 2.0s arm that stalls once ends ~3s further behind live](obs-default-gop-prediction-2026-08-12.md) | 📋 plan |
| 2026-08-12 | [The 0.5s GOP fails 5.07% of chunk retrievals against the 2.0s GOP's 1.93%, 2.6x, and not one of those failures reached the viewer](interleaved-gop-arms-2026-08-12.md) |  |
| 2026-08-12 | [Pre-registers that at the shipped fragment-0.25 / GOP-2.0 pair the median segment is 2.0s not 0.25s, and that M1 at-or-after beats M2](gop-vs-fragment-prediction-2026-08-12.md) | 📋 plan |
| 2026-08-12 | [HLS_FRAGMENT is not the knob: segment = ceil(fragment/GOP)*GOP, so at the shipped pair the segment is 8x the fragment because the GOP is](gop-vs-fragment-2026-08-12.md) |  |
| 2026-08-12 | [Pre-registers that small segments still sustain a live broadcast at ratio >= 0.99 with zero stalls, and names what would withdraw it.](gop-sustain-prediction-2026-08-12.md) | 📋 plan |
| 2026-08-12 | [Going from a 2.0s to a 0.5s GOP buys 2.34s of latency and takes confirmed stalls from 3-of-3 to 0-of-3, for 19% more BZZ.](gop-sustain-2026-08-12.md) |  |
| 2026-08-12 | [The 0.25s GOP 404 rate does not replicate (2.9/13.1/0.0 against 18-21%) and all 19 refusals came back within 140ms: it is our publish race.](gop-floor-replicate-2026-08-12.md) |  |
| 2026-08-12 | [Pre-registers a 0.267s-GOP latency of 1.19s by three independent routes, and that ~800ms of the remaining latency is GOP-independent.](gop-floor-prediction-2026-08-12.md) | 📋 plan |
| 2026-08-12 | [WITHDRAWN in place: "a viewer at the live edge cannot retrieve one segment in five at a 0.25s GOP" was the bench discarding early reads. → `gop-floor-replicate-2026-08-12.md`](gop-floor-2026-08-12.md) | ⛔ withdrawn |
| 2026-08-12 | [At the shipping 0.5s GOP capture-to-fetchable is 1.56s median and 4.54s max, so plan against the tail at 4.6s rather than the median.](arrival-distribution-2026-08-12.md) |  |
| 2026-08-11 | [From the source: SRS cuts at the first keyframe at or after hls_fragment x hls_td_ratio, and td_ratio defaults to 1.0, which we never set](srs-segment-close-path-2026-08-11.md) |  |
| 2026-08-11 | [Stock SRS lands exactly on its knob in every arm; 'our deployment doubles' is withdrawn, because a loopback bracket is not a control for it → `segment-stretch-2026-08-12.md`](srs-fragment-bracket-2026-08-11.md) | ⚠️ superseded |
| 2026-08-07 | [The 1080p control failed a third time for a third reason: stop measuring segment-length latency there, cost and postage separate anyway](the-third-attempt-at-1080p-2026-08-07.md) |  |
| 2026-08-07 | [At 1080p the two 0.25s control arms disagree by 0.92s against an 0.85s effect, so the latency comparison is void; cost and refusals separate](the-same-test-at-1080p-2026-08-07.md) |  |
| 2026-08-07 | [An hour at a 1.0s GOP holds 1.000 advance on the same picture and writes 28% cheaper than 0.25s, with its postage row retracted inside the doc.](an-hour-at-one-second-2026-08-07.md) |  |
| 2026-08-07 | [0.25s GOP sits 5.86s behind live against 1.0s's 5.52s, takes every refusal in the sitting, and costs 24% more BZZ, on a working ABA control.](a-quarter-second-buys-nothing-2026-08-07.md) |  |
| 2026-08-05 | [A viewer's picture advances at exactly its fetch headroom, because the client walks feed, manifest and segment serially, 2 in flight → `the-loop-fixed-2026-08-05.md`](what-starves-the-viewer-2026-08-05.md) | ⚠️ superseded |
| 2026-08-05 | [Walking the feed to the head took media seconds per wall second from 0.819 to 1.000 and frozen wall clock from 17.3% to 0% at a 0.25s GOP](the-loop-fixed-2026-08-05.md) |  |
| 2026-08-05 | [0.25s GOP gates at 1074ms capture-to-fetchable against 0.5s's 1535ms over three 10-minute runs with a 29ms spread and no drift](ten-minute-gate-2026-08-05.md) |  |
| 2026-08-05 | [0.5s is the 720p operating point at 1.17s behind live; the whole 0.25s row is retracted as the bench's own follower failing to keep pace](segment-length-2026-08-05.md) |  |
| 2026-08-05 | [A 0.25s GOP is about 0.65s better than a 0.5s one, 1.00-1.06s against 1.61-1.73s, once the bench's follower walks to the live edge](quarter-second-2026-08-05.md) |  |
| 2026-08-05 | [The encoder never missed its GOP: a consumer slower than the stream's bitrate silently stretches media time under our wallclock recipe](publisher-backpressure.md) |  |

## The in-browser node

A viewer that retrieves for itself instead of asking a gateway.

| date | what it establishes | |
| --- | --- | --- |
| 2026-08-16 | [A fully gateway-less viewer sustains a live broadcast at realtime with **0** gateway retrievals against 2,346-2,563, but starts at the broadcast's beginning rather than the live edge, and its main thread climbs to 0.899 of one](gateway-less-live-2026-08-16.md) |  |
| 2026-08-16 | [Abel's live path is fully gateway-less (5 network requests, all app shell) while our own in-tab client keeps the gateway for the feed, and his did not reach playback](abel-gateway-less-live-2026-08-16.md) |  |
| 2026-08-15 | [Every quantile from q25 to q90 moves by one factor, 1.61x in-tab and 1.23x gateway over 2.40x the bytes, so exponents are 0.55 and 0.23](thread-scaling-shape-2026-08-15.md) | ✏️ |
| 2026-08-15 | [dU/dLoad is +0.00000 ± 0.00036, so faking the in-tab creep needs 47 load units/hr monotonic; but the creep itself is only t≈4.3 on 4 df](host-load-is-not-the-creep-2026-08-15.md) |  |
| 2026-08-15 | [The in-tab main-thread creep holds across three hours and accelerates: +0.0357 ± 0.0013/hr with a quadratic term at t = 3.64, 0 stalls.](drift-holds-and-bends-2026-08-15.md) | ✏️ |
| 2026-08-15 | [1080p peaks the in-tab node at 0.707 of one thread against an extrapolated 1.38, and the retrieval saving widens from 23.4x to 44.5x.](1080p-main-thread-2026-08-15.md) |  |
| 2026-08-14 | [On the main thread the in-tab node costs 3.12x the gateway path against only 1.54x on the container, so the container total flattered it 2x](main-thread-saturation-2026-08-14.md) |  |
| 2026-08-14 | [The in-tab thread creeps +0.026/hr with session age (gateway +0.049/hr), while joining a broadcast already 3.5h old costs nothing](long-arm-drift-2026-08-14.md) |  |
| 2026-08-14 | [An in-tab node cuts gateway retrievals 25.3x and costs about 0.6 of a core, with zero overlap between the conditions on either axis.](byte-source-replicate-2026-08-14.md) | ✏️ |
| 2026-08-13 | [An in-tab node holds a live edge, 0 rebuffers and 0 stalls in six arms, at 24.4x fewer gateway retrievals and 143x less gateway spend](weeb3-live-arms-2026-08-13.md) |  |
| 2026-08-13 | [Our player played a full recording with zero /bytes/ requests, seeking and resuming, at 42% of the gateway's buffer lead](weeb3-a2-playback-2026-08-13.md) |  |
| 2026-08-13 | [The latency column cannot rank in-tab against gateway at any working target, while 20.3x/21.6x fewer retrievals replicate with zero overlap](uncensored-latency-2026-08-13.md) | ✏️ |
| 2026-08-12 | [At the concurrency hls.js uses the segment-size advantage collapses from 3.29x at c1 to 1.26x at c4, so prefer small segments.](c4-across-sizes-2026-08-12.md) |  |
| 2026-08-11 | [An in-browser viewer costs 0.79-1.05 cores at 8.34 Mbps, and the ceiling is its single main thread at 0.54-0.75, not the core count](what-an-in-browser-viewer-costs-in-cpu-2026-08-11.md) |  |
| 2026-08-11 | [The shipping profile sustains in a gateway-less in-browser node: realtimeRatio 0.9996, zero stalls, 0.116 of the main thread](shipping-profile-sustains-2026-08-11.md) |  |
| 2026-08-11 | [Pre-registers decay (H1) vs upload-path (H2) for fresh refs, plus an occupancy model predicting the shipped 1080p profile does NOT sustain](live-shipping-profile-prediction-2026-08-11.md) | 📋 plan |
| 2026-08-11 | [Pre-registers three disagreeing models for c4 and c16 throughput, each with its own falsifier, before the sweep ran.](concurrency-on-healthy-content-prediction-2026-08-11.md) | 📋 plan |
| 2026-08-11 | [A browser node is already at its ceiling at concurrency 4: c16 buys 4.9% more throughput for 3.1x the per-segment latency.](concurrency-on-healthy-content-2026-08-11.md) |  |
| 2026-08-11 | [Bigger fetches are faster per byte and more likely to miss a deadline, in the same rows: the metric chosen decides which is true.](chunks-in-flight-re-analysis-2026-08-11.md) | ✏️ |
| 2026-08-11 | [A gateway-less unfunded in-tab node sustained 8.34 Mbps at realtimeRatio 0.9962, so the in-browser ceiling was our 90 KB segment size, not the node.](abel-sustain-result-2026-08-11.md) |  |
| 2026-08-11 | [Pre-registered: the segment-level model predicts ratio ~0.23 and the chunk-level model >=0.999, with an addendum moving the call to does-not-sustain. → `abel-sustain-result-2026-08-11.md`](abel-sustain-prediction-2026-08-11.md) | ⚠️ superseded |
| 2026-08-08 | [An unfunded viewer node burns 2.6-2.9x the CPU of a funded one for byte-identical work and is served by its first peer under 1 time in 10 → `sixteen-viewers-cost-what-one-costs-2026-08-08.md`](what-a-viewer-node-costs-in-cpu-2026-08-08.md) | ⚠️ superseded |

## Retrieval and content decay

Whether Swarm still returns what we uploaded.

| date | what it establishes | |
| --- | --- | --- |
| 2026-08-11 | [It is not size, it is whose content it is: his 4.2MB delivers 10/10 while our 3.4MB delivers 2/10 and our 225KB canary delivers 0/5](size-vs-replication-2026-08-11.md) |  |
| 2026-08-11 | ['Bigger fragments are worse to deliver' is dead: on content of known health all four sizes deliver 8/8, so the cliff was corpus decay](size-on-healthy-content-2026-08-11.md) |  |
| 2026-08-11 | [It is decay: content we published 65 minutes earlier delivers 8/8 while our eight-day-old content delivers 0/8, alternating on one node.](fresh-vs-decayed-2026-08-11.md) |  |
| 2026-08-11 | [Nothing has decayed by 60.1h: the read arm is 8/8 on all four reads, and the hour column was wrong on every row until 2026-08-13.](DECAY-COHORT.md) | ✏️ |

## Scale: concurrency, cache and gateways

What happens when many viewers share one node.

| date | what it establishes | |
| --- | --- | --- |
| 2026-08-14 | [--cache-capacity=0 is not off, it is a thrash loop whose phase nothing records, and it is the worst of the three settings available](the-gateway-cache-is-a-sawtooth-2026-08-14.md) |  |
| 2026-08-09 | [Under an 80/20 skew there is no step anywhere, not even at the hot set: 1.00x the hot set collects 38% of a full cache and capacity keeps buying](the-cache-has-no-cliff-under-skew-2026-08-09.md) |  |
| 2026-08-09 | [The 76% capacity that removes 0.0% under a cyclic scan removes 36.8% under a recency skew, so the cliff belongs to the access pattern → `the-cache-has-no-cliff-under-skew-2026-08-09.md`](the-cache-cliff-belongs-to-the-access-pattern-2026-08-09.md) | ✏️ ⚠️ superseded |
| 2026-08-09 | [Startup housekeeping burns 14.03x for 30s then stops, so the cold penalty is in the retrieval path and no readiness signal goes green late enough.](a-cold-gateway-is-idle-long-before-it-is-cheap-2026-08-09.md) |  |
| 2026-08-08 | [The knee is at 128 viewers, where the median transfer is 248ms against a 267ms budget, while chunk dedup still holds at 1.85x one viewer](where-sharing-a-gateway-stops-2026-08-08.md) | ✏️ |
| 2026-08-08 | [Pacing at real time cuts the CPU model to 0.67 cores fixed plus 0.046 per viewer: per-viewer figures were ~2x pessimistic, per-MB held → `a-synchronised-audience-is-the-failure-2026-08-08.md`](what-a-paced-viewer-costs-2026-08-08.md) | ⚠️ superseded |
| 2026-08-08 | [Throughput plateaus at 43-44 MB/s from 192 to 512 viewers, so gateway capacity is a byte rate (~123 viewers at 2.83 Mbps), not a viewer count](the-ceiling-is-bytes-not-viewers-2026-08-08.md) |  |
| 2026-08-08 | [A cache at 76% of the working set is byte-identical to no cache, and 100.1% buys the whole benefit: no partial credit under a cyclic scan → `the-cache-cliff-belongs-to-the-access-pattern-2026-08-09.md`](the-cache-cliff-is-at-one-hundred-percent-2026-08-08.md) | ⚠️ superseded |
| 2026-08-08 | [Sixteen viewers behind one gateway cost the network what one costs: peer contacts move 3.7% while retrieval operations move 15x](sixteen-viewers-cost-what-one-costs-2026-08-08.md) |  |
| 2026-08-08 | [Pooling and caching collapse different things (across viewers vs across time), so they compose: 19x cheaper CPU per MB together](pooling-and-caching-are-orthogonal-2026-08-08.md) |  |
| 2026-08-08 | [60ms of per-request jitter, the default #108 shipped, does nothing against a 128-viewer herd; only positional spread (chunk diversity) works](jitter-is-not-what-breaks-a-herd-2026-08-08.md) |  |
| 2026-08-08 | [Jitter improves the median transfer twenty-fold, 250ms to 12ms, and viewers still end seconds behind, while positional spread is 0ms every round.](a-twenty-fold-better-median-that-fixes-nothing-2026-08-08.md) |  |
| 2026-08-08 | [128 scattered viewers end zero behind where the same 128 synchronised drain 25.6s, so synchronisation is a failure mode and not a baseline.](a-synchronised-audience-is-the-failure-2026-08-08.md) |  |
| 2026-08-08 | [The first arm after a recreate costs 2.06-2.16x per MB with 32-40% of segments over budget, and CPU settles in four arms where the viewer settles in one.](a-cold-gateway-needs-a-minute-2026-08-08.md) |  |
| 2026-08-08 | [A cache holding 46% of the working set removes 0.1% of retrievals, and at 191% it removes 46.4% with the pass-2 median 110ms to 3ms.](a-cache-that-does-not-fit-does-nothing-2026-08-08.md) |  |
| 2026-08-04 | [Eight viewers on one gateway leave the stream about 1.30x staler than one, in 12 of 14 paired comparisons (sign test p = 0.0129).](concurrency.md) | ✏️ |

## Funding and cost

What a broadcast costs, and what an unfunded node does differently.

| date | what it establishes | |
| --- | --- | --- |
| 2026-08-13 | [A viewer through an unfunded gateway gets every segment at the same bitrate; each takes 163ms against 82ms and the 6s buffer absorbs it.](gateway-funding-2026-08-13.md) |  |
| 2026-08-09 | [Retrieval costs 0.000678 BZZ/MB flat across an 8.5x segment-size range, so 1080p at 6000k burns 0.0325 BZZ/min and there is no GOP premium](what-a-gateway-burns-at-each-profile-2026-08-09.md) | ✏️ |
| 2026-08-08 | [The ~37 accounting skips per chunk are local loop iterations: real peer contacts are 1.28-1.30 per chunk against a funded node's 1.14](why-an-unfunded-gateway-is-slow-2026-08-08.md) |  |
| 2026-08-08 | [An unfunded gateway cannot settle: debt grew in all three arms, and its late-segment penalty is 45x where the median penalty is 2.9x](what-throttles-an-unfunded-gateway-2026-08-08.md) |  |
| 2026-08-08 | [What separates a collapsed unfunded night from a clean one is the rate of one-second retrievals, 17-22 against 0.5-1.6 per thousand](what-separates-a-collapse-from-a-clean-run-2026-08-08.md) |  |
| 2026-08-08 | [45 min of unfunded playback at the 0.25s profile stalled nothing, yet it sits at half the segment budget with a spread wider than its margin](ultra-light-at-the-shipping-profile-2026-08-08.md) |  |
| 2026-08-08 | [Funding is a switch at zero: 0.05 BZZ performs like 6.4 (43ms, 0.1% late) and an empty chequebook is an unfunded node (109ms, 10.6% late)](the-funding-cliff-is-at-zero-2026-08-08.md) |  |
| 2026-08-08 | [Across eleven identical unfunded arms the late share ranged 1.9% to 19.5%, and neither idle, debt level nor arm order accounts for it.](eleven-unfunded-arms-2026-08-08.md) |  |
| 2026-08-07 | [At a 1.0s GOP an unfunded gateway delivers the same picture as a funded one, only because a 1.0s segment budget absorbs the transfer penalty](light-vs-ultra-light-at-a-viewer-2026-08-07.md) |  |
| 2026-08-06 | [At 0.25s an ultra-light gateway doubles median segment transfer, 65-91ms to 156-172ms, and costs 3 and 17 rebuffers where light costs zero](light-vs-ultra-light-2026-08-06.md) |  |

## The feed

The single-owner chunk every viewer polls.

| date | what it establishes | |
| --- | --- | --- |
| 2026-08-09 | [A feed read at 128 concurrent readers costs what it costs at one, 4.69 reads a second against 4.81, and only the one-second tail moves](the-feed-does-not-care-how-many-are-reading-it-2026-08-09.md) |  |
| 2026-08-09 | [At the live edge a miss costs 4.5x a hit in all 14 logs: the ~490ms floor is the price of asking for an unwritten slot, and it costs zero BZZ](the-announcement-floor-is-a-miss-floor-2026-08-09.md) |  |
| 2026-08-06 | [74 of 76 refused slots at the live edge had retrievable slots behind them, and one extra request at +1 finds 73 of the 74](what-is-behind-a-refused-slot-2026-08-06.md) |  |
| 2026-08-05 | [Asking for a feed slot that does not exist costs 4ms at the median and ~1.4s about one time in twenty, against 4012ms for a head lookup.](feed-miss-cost.md) |  |
| 2026-08-05 | [692 slots of a just-finished broadcast all answered on the first pass: zero holes of either kind, so the trigger for #71 did not occur.](feed-hole-scan.md) |  |
| 2026-08-04 | [The 30-48s freeze was the instrument: reading the feed the way the player does, the worst wait was 4.8s and 85-95% of segments arrived.](feed-reader-ab.md) |  |
| 2026-08-04 | [The feed head lookup costs a whole second at one slot and about 0.4s per doubling above it, against a flat 4ms for a read by address.](feed-head-scaling.md) |  |
| 2026-08-03 | [Latency holds still over 5-20 min broadcasts, but the feed freezes 30-48s at a time for 42-70% of it, blamed on our own unfunded gateway node](longrun.md) | ⚠️ superseded |

## Failure, crash and recovery

What breaks, and what a viewer sees while it does.

| date | what it establishes | |
| --- | --- | --- |
| 2026-08-13 | [The same 3283.77s recording plays and all three seeks land in 171-219ms with resume in 335-354ms, on a 60.95s buffer-ahead.](browser-vod-2026-08-13T10-06-40-691Z.md) |  |
| 2026-08-13 | [The same 3283.77s recording plays and all three seeks land in 230-596ms with resume in 326-345ms, on a 19.99s buffer-ahead.](browser-vod-2026-08-13T10-02-21-787Z.md) |  |
| 2026-08-13 | [A 3283.77s recording plays with both source buffers built and all three seeks land, the backward one included, in 166-203ms.](browser-vod-2026-08-13T09-55-22-502Z.md) |  |
| 2026-08-09 | [Under a real ENOSPC /health degrades on the first failed write, and the broadcast runs on with no recovery entry, so a crash loses it whole](what-a-full-disk-costs-a-broadcast-2026-08-09.md) |  |
| 2026-08-09 | [An unparseable recovery entry is deleted on the next boot and never finalized, so the recording is lost silently while the catalog says live](the-crash-scenarios-nobody-had-run-2026-08-09.md) |  |
| 2026-08-09 | [The first four segments declare video in the PMT and carry no video packets, so the player fixes an audio-only codec set for all 209s.](a-recording-that-opens-without-video-2026-08-09.md) |  |
| 2026-08-07 | [Fix 0.8a is worth 42.6s of frozen picture (46.7s to 4.1s); 0.8b's ~2.4s is not established because its instrument changed mid-comparison](two-recovery-fixes-weighed-2026-08-07.md) |  |
| 2026-08-06 | [An 8s write-node pause the uploader calls lossless froze a viewer 3.1s, because freeze = outage minus buffer and the two thresholds differ](two-more-faults-2026-08-06.md) |  |
| 2026-08-06 | [An 8.1s writer-bee pause froze the picture only 3.1s and recovered in 2.0s, but the client said nothing at all while it was stopped.](browser-crash-writer-bee-pause-2026-08-06T05-33-36-816Z.md) |  |
| 2026-08-06 | [A 20.4s writer-bee stop froze the picture 54.9s and it recovered in 37.9s with an overlay. Its 0.994 ratio is retracted to 0.669 elsewhere.](browser-crash-writer-bee-outage-2026-08-06T05-38-54-740Z.md) |  |
| 2026-08-06 | [A 20.5s gateway stop froze the picture 29.6s and it recovered in 10.7s with an overlay. Its 1.001 ratio is retracted to 0.764 elsewhere.](browser-crash-viewer-gateway-outage-2026-08-06T05-13-27-811Z.md) |  |
| 2026-08-06 | [A 20.5s gateway stop froze the picture 27.6s and it recovered in 12.2s with an overlay. Its 0.989 ratio is retracted to 0.794 elsewhere.](browser-crash-viewer-gateway-outage-2026-08-06T05-06-23-585Z.md) |  |
| 2026-08-06 | [A 20.5s gateway stop froze the picture 32.6s and it recovered in 14.1s with an overlay. Its 0.992 ratio is retracted to 0.751 elsewhere.](browser-crash-viewer-gateway-outage-2026-08-06T04-46-49-528Z.md) |  |
| 2026-08-06 | [A 15.3s uploader kill froze the picture 12.4s with no overlay message, recovering 4.1s later. Its 1.003 ratio is retracted to 0.855 elsewhere.](browser-crash-uploader-crash-2026-08-06T04-41-37-300Z.md) |  |
| 2026-08-06 | [SRS sends no on_unpublish when it dies, so a stream stayed live for the life of the process, and a 60s reap now finalizes it as a VOD.](an-engine-that-dies-2026-08-06.md) |  |
| 2026-08-06 | [A recording never played because updateManifest adopted headers after its finalized branch returned, emitting a playlist with no #EXTM3U.](a-recording-played-back-2026-08-06.md) |  |
| 2026-08-05 | [A viewer's recovery is bounded below by the retrievability of the one oldest unread feed slot: 15.3s of outage cost 54.9s of freeze.](crash-at-a-viewer-2026-08-05.md) |  |
| 2026-08-05 | [A 20.5s gateway stop froze the picture 30.6s and it recovered in 16.2s with an overlay. Its 1.006 ratio is retracted to 0.756 elsewhere.](browser-crash-viewer-gateway-outage-2026-08-05T17-05-49-577Z.md) |  |
| 2026-08-05 | [A 15.3s uploader kill froze the picture 54.9s and recovered 46.7s later. Its 0.992 ratio is retracted to 0.603 elsewhere, uncorrected here.](browser-crash-uploader-crash-2026-08-05T17-11-11-039Z.md) |  |
| 2026-08-05 | [A 30.5s SRS restart froze the picture for 84.3s and it never recovered, though the client did say why. Whole-session ratio 0.383.](browser-crash-engine-restart-2026-08-05T17-20-31-378Z.md) |  |

## Latency and long broadcasts

Time behind live, and what hours of running does to it.

| date | what it establishes | |
| --- | --- | --- |
| 2026-08-12 | [Registers the first unattended night that can spend: predictions and named refusal gates for three sittings over 7.9 broadcast hours](night-2026-08-12-prediction.md) | 📋 plan |
| 2026-08-12 | [Registers four predictions for the first four-hour soak: ~3.0MB manifest, TARGETDURATION stays 1, latency non-decreasing, 0-3 collapses](long-broadcast-prediction-2026-08-12.md) | 📋 plan |
| 2026-08-12 | [Nothing degrades over four hours, but one stall steers hls.js's target to 7.00s permanently and it never comes back down](long-broadcast-2026-08-12.md) |  |
| 2026-08-07 | [The collapse is a read-path service-time step at t=822s, ~4.9x on segments and feed lookups together, with demand and client unchanged](the-fourteen-minute-collapse-2026-08-07.md) |  |
| 2026-08-05 | [The first watched viewer advances 0.83-0.85 media seconds per wall second, frozen 12-17% of wall clock, and hls.latency cannot see it → `the-loop-fixed-2026-08-05.md`](viewer-in-a-browser-2026-08-05.md) | ⚠️ superseded |
| 2026-08-03 | [The deployment's operating profiles: 6.43s behind live at 720p/0.5s is the floor, and a quarter second makes latency worse at every picture](profiles.md) | ⚠️ superseded |
| 2026-08-02 | [One 2026-08-02 SRS latbench run: 5.94s capture-to-fetchable, 13.30s behind live, on a split whose upload hop is an impossible -390ms](latency-2026-08-02T16-14-48-385Z.md) |  |

## Instruments, and how they lied

Defects in the measuring apparatus itself.

| date | what it establishes | |
| --- | --- | --- |
| 2026-08-15 | [The rig's 267ms tables are between exactly right and 5.5 points pessimistic, because a 0.5s GOP doubles the budget AND the segment, and this corrects my own correction from the same morning](rig-budget-vs-shipped-budget-2026-08-15.md) | ✏️ |
| 2026-08-15 | [A 14-agent audit of all 147 documents: 28 candidates, 9 killed by skeptics, 19 confirmed and fixed, and retraction leakage was the highest-yield lens by a distance](corpus-audit-2026-08-15.md) | ✏️ |
| 2026-08-14 | [Neither byte-source driver ever called start_sampler, so the mid-arm floor check polled a file nothing wrote, and its test could not fail](the-sampler-that-never-ran-2026-08-14.md) |  |
| 2026-08-13 | [retrieveBytes returns the Swarm span with the 8-byte prefix a gateway strips, and twelve stubbed tests passed over the corrupt stream](weeb3-fetch-backend-2026-08-13.md) |  |
| 2026-08-12 | [Of three contaminations found in the corpus, only decay invalidated numbers; the other two broke only the sentence explaining them.](corpus-audit-2026-08-12.md) | 📋 plan |
| 2026-08-11 | [The corpus tags the encoder axes and not the retrieval axes, and that hand reconstruction is where every mixing error came from.](DATA-AUDIT-PLAN.md) | 📋 plan |
| 2026-08-07 | [overallAdvanceRatio counted recovery seeks as watched media, so a viewer through an uploader crash scored 0.992 where the truth is 0.603.](advance-ratio-excludes-seeks-2026-08-07.md) |  |
| 2026-08-05 | [Identical settings measure 1.05s apart on different nights, ten times the within-session spread, and all of it lands on feedPropagation and fetch.](between-session-drift.md) |  |

## How this index is kept

⛔ **It is generated from a read of every document, not from filenames.** Regenerating it means
reading the corpus again. A new finding should be added by hand to the section it belongs in, with
its claim written as the claim rather than as a topic.

⚠️ **`docs/bench` also holds 261 untracked markdown files and hundreds of json.** Those are per-run
harness output, matched by the `docs/bench/*` rules in `.gitignore`, and are not part of this corpus.
Only what `git ls-files 'docs/bench/*.md'` returns is.

