# Why a capped in-tab node delivers nothing: the probe, pre-registered

**2026-09-02, plan. Costs 0 BZZ.** Written before the driver exists and before anything ran, so the
predictions below cannot have been fitted to the result. The result file will be
`in-tab-throttle-probe-<runId>.md` beside this one.

## The question

V2 (`e2e/suites/viewer/quality-switch.test.ts`) caps a watching viewer's download at the bitrate of the
rung below the one they ride, and asks whether the player steps down and keeps playing. On the in-tab
profile it is red in five sittings out of five, and the red is not the player's.

Sitting five (`browser-quality-2026-09-01T17-13-53-811Z.json`, 2026-09-02 night local time):

| | |
| --- | ---: |
| cap | 2800 kbps, which is 350 KB/s |
| the rung the player asked for within seconds | 360p at 700 kbps |
| 360p fragments requested while capped | 5 distinct (sn 642, 645, 648, 651, 654) |
| how they ended | all aborted by hls.js, 18.6 / 19.8 / 28.9 s min / median / max |
| segment bytes that reached the player while capped | 15 kB/s |
| first fragment after the cap lifted | loaded in 2.5 s, then 83 to 159 ms |

A 360p segment of this recording is about 220 KB. At 350 KB/s the link carries one in 0.63 s. The node
in the tab could not deliver one in 20 s. That is a collapse of more than 30x, not an overhead.

⛔ The owner ruled on 2026-09-02 that the answer is NOT a gateway fallback of any kind. The fix lives in
the in-tab retrieval path itself. This probe is the measurement that has to come before any such fix,
because the mechanism has so far only been reasoned about.

## What the source says, and which source

The client pins `@lat-murmeldjur/weeb_3@0.0.329001`, which is upstream "Commit number 329"
(`76e58ba`, 2026-08-10). Upstream HEAD while writing this is "Commit number 342" (`e36719a`,
2026-08-30). Both were read. The retrieval constants and the rule that matters are identical in both.

⚠️ **A source read is a hypothesis with a test named, never a finding.** Everything in this section
is what the code would do. Whether it does it, and whether it is what starves the viewer, is what the
probe measures.

From `src/retrieval.rs`:

- **Every chunk retrieval hedges on a one second clock.** `retrieve_chunk` starts a new attempt to
  the next closest peer whenever no attempt is in flight OR one second (`RETRIEVE_HEDGE_AFTER_MS`)
  has passed since the last attempt started, up to twenty attempts (`RETRIEVE_CHUNK_MAX_ATTEMPT_ERRORS`).
  The first attempt to answer wins. Nothing calls the others off.
- **An attempt that outlives ten seconds is detached, not cancelled.** `retrieve_attempt` times the
  exchange out at `RETRIEVE_ATTEMPT_TIMEOUT_MS = 10_000`, reports failure, and keeps the exchange
  alive in a detached task so that the peer is still paid when its chunk arrives. Its bytes still
  cross the link.
- **The root chunk is asked of three peers at once** (the original address plus Bee's first two
  replicas), and of more replicas in doubling batches after each second without an answer.
- **A fragment's chunks are fetched in up to eight parallel groups** (`RETRIEVE_DATA_GROUP_CONCURRENCY`),
  each group dispatching all of its data shards at once.
- **Admission is credit based.** A peer refuses a new reservation once balance plus reserve would
  exceed its threshold (`accounting.rs`), the node parks that peer on an overdraft list and moves to
  the next.
- **`retrieveBytes` exposes no cancel.** The crate has a cancel token internally, the exported call
  takes none, and the client's loader docblocks already record that an abandoned fragment costs the
  node until it answers.
- **The node exposes no retrieval telemetry.** `logs()` drains a channel that only `lib.rs` writes to,
  and `progressSnapshot()` reports uploads. Attempts and bytes have to be counted from outside the
  wasm, at the browser's WebSocket layer, which is the only transport this node has
  (`websocket_websys`, `lib.rs`).

Under a bandwidth cap, chunk delivery stretches past one second, so the one second hedge fires for
every chunk, every second, each time adding a full chunk of demand to a link that is already full. The
detached timeouts add theirs ten seconds later. That is a positive feedback loop: queueing delay
causes hedges, hedges cause more bytes, more bytes cause more delay. It fits a collapse that
appears only under a cap and vanishes the moment the cap lifts, which is exactly the shape sitting
five recorded.

## Three hypotheses, and what each predicts

Each is stated so the probe can refute it.

**H1, hedge amplification.** The node multiplies its own demand under a cap.
Prediction: for a single 360p retrieval, inbound WebSocket bytes divided by payload bytes reads near
1.0 to 1.3 unthrottled and **at least 3.0** under the 2800 kbps cap, and higher still for a 1080p
retrieval. Outbound request frames per retrieval rise by a similar factor.

**H2, idle background load.** Two hundred peers' hive, pricing and pseudosettle traffic take a
material share of the capped link before any fragment is asked for.
Prediction if H2 is the cause: inbound bytes while idle are **at least 30% of the cap** (105 KB/s or
more at 2800 kbps). My own expectation is under 10%, and I am writing that down so it can be wrong.

**H3, accounting refusals.** Peers refuse reservations and the node cycles its overdraft list rather
than fetching.
Prediction if H3 is the cause: capped retrievals **reject quickly** with few inbound bytes. Sitting
five argues against it already, since nothing answered for 20 seconds and more, but it is cheap to
keep in the table.

**H0, the instrument.** Chromium's `Network.emulateNetworkConditions` must reach the WebSocket
transport as one aggregate budget for these ratios to mean anything. Check: with the cap at 700 kbps,
aggregate idle inbound must not exceed 87.5 KB/s. If it does, the cap is per connection or absent,
and every capped figure here is void.

## The design

One driver, `pnpm browser:in-tab-throttle-probe`, run in the browser image on manager-host through
`deploy/scripts/browser-on-host.sh --script browser:in-tab-throttle-probe`, against the deployed
client root. No broadcast. The node in the tab is booted through the client's own instrumentation
switch (`prewarm`), and every retrieval goes through the client's own `Weeb3FetchBackend`, so it is
the product path and not a stand-in.

**The content** is sitting five's recording, still resolvable through the gateway on 2026-09-02:
owner `8d8a30ff4cbcf8ad0e0773547686295f8157feb0`, 127 segments of 2.0 s per rung, media sequence
580 onward.

| rung | session topic (raw) | segment bytes, three samples |
| --- | --- | ---: |
| 360p | `8949d4e4-d705-4829-8bce-9484a3390885` | 224,848 / 219,772 / 219,396 |
| 1080p | `6e01b80f-47ef-41fa-9449-a64e2478cf6f` | 1,163,720 / 1,125,368 / 1,129,692 |

The driver reads each rung's manifest through the gateway, as the client would, and takes segment
references from it. ⚠️ **No reference is fetched twice in one tab.** A repeat is answered from the
node's own cache in single digit milliseconds and would score as a miracle.

**Part A, idle.** Node booted, nothing requested. Three windows of 60 s: unthrottled, capped at 2800
kbps, capped at 700 kbps. Per second: WebSocket frames and bytes in and out, connections opened and
closed. This is H2 and H0.

**Part B, one fragment at a time.** Arms are `360p` and `1080p`, each unthrottled and under the 2800
kbps cap, **three fresh references per arm**, arm order alternated so drift does not land on one arm.
Before every capped retrieval an unthrottled 360p canary runs; a canary that misses its own budget
marks the round degraded and its measurements are reported as such, not averaged in. Per retrieval:
elapsed, bytes returned, resolved or rejected, inbound bytes and outbound frames during the
retrieval, and inbound bytes in the ten seconds after it settled (the late answers). The budget is
**90 s**, and a retrieval that hits it is reported as "did not complete in 90 s", never as a duration.
The 20 s line, which is where hls.js gives up, is marked in every table. This is H1 and H3.

**Part C, two at once.** Two fresh 360p references under the 2800 kbps cap, started together, twice.
Sitting five had up to three 360p retrievals overlapping, so this is the shape the viewer produced.

**Bracketed by the gateway's own counters** with the existing node metrics snapshot, before and
after, even though the gateway serves only two manifests here. The rule is every service metric
either side of every measurement, and the bracket is what proves the gateway served no segment.

## What the artifact keeps

Every per second sample and every per retrieval row, in `in-tab-throttle-probe-<runId>.json`, with
the summary tables in the `.md`. The amplification ratio is computed in a pure function under
`node --test`, not in the collecting script, for the reason `deploy/scripts/in-browser-concurrency-sweep.js`
records: every in-browser throughput figure this project retracted before 2026-08-11 was retracted
for the arithmetic applied afterwards.

Nothing is asserted. This is a measurement, not a suite.

## What this cannot say

- **Which peers.** The node exposes no per peer view, and yamux frames are not one to one with
  attempts. Bytes per payload byte is robust to that. An attempt count is an estimate and is labelled
  one.
- **Whether a fix works.** That needs the fix. Any change to weeb-3 is an upstream change or a fork,
  drafted locally and handed to the owner, never filed by me.
- **The live edge.** These are VOD references. The retrieval path for a reference does not know or
  care whether the playlist was live, so the mechanism transfers, but the live viewer's overlapping
  requests are only approximated by Part C.
- **The Mac.** It runs on manager-host's browser image, which is where V2 ran. A home connection is a
  different instrument.

## Cost

0 BZZ. An ultra-light node's retrievals are free to the node, the recording is already published, and
the gateway serves two manifests. The spend ledger is not touched.
