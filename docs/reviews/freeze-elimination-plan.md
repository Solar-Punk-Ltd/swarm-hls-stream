# Eliminating the periodic freeze (LAT-10)

**Status 2026-08-04, third revision: CONFIRMED THROUGH THE PRODUCT. The freeze is in bee's sequential
feed head lookup, the bench was the only thing standing on it, and reading the feed the way the
player does takes the worst stall from 37.2 seconds to 4.8.**

Three ten-minute broadcasts read the player's way against one read the old way, same stack, back to
back: longest stall 4.59 / 4.76 / 4.79s against **37.22s**, feed index jump on release 1 / 1 / 1
against **19**, segments delivered 280 / 289 / 257 against **91** out of about 303 possible. Full
table in [`docs/bench/feed-reader-ab.md`](../bench/feed-reader-ab.md). The bench was fixed in
`f1bfc7c` and `BENCH_FEED_READER=head` reproduces the old behaviour on demand.

**So the 57% frozen headline, and every latency figure this project has published, described the
instrument.** The rest of this document is how that was found.

This document has been wrong twice. First it treated the freeze as a property of Swarm retrieval.
Then it named our client as the cause, and a fix was written and committed. A rig built to check that
fix before spending a broadcast on it refuted the premise, and the fix was reverted the same hour.
Both retractions are kept, because the eliminations they produced are still valid and re-testing them
would be waste.

## The measurement that settles it

One writer, one slot per second, four topics on one node under one stamp, read four ways at once, so
anything separating the readers is the reading and not the writing.

| reader    | how it follows the feed                            |     frozen |                    staleness | response               |
| --------- | -------------------------------------------------- | ---------: | ---------------------------: | ---------------------- |
| **head**  | `GET /feeds/{owner}/{topic}`, node resolves latest | **50-57%** | mean 5.8-8.1 slots, worst 43 | 1006-7007ms, mean 2.7s |
| **edge**  | explicit slot address, riding the live edge        |   **0.2%** |     mean -0.6 slots, worst 2 | 46ms mean              |
| **lag**   | explicit slot address, started 20 slots behind     |     **0%** |         caught up completely | 45ms mean              |
| **quiet** | written throughout, read once at the end           |          - |               0 slots behind | one read, 3.5s         |

Three runs, two nodes, six minutes each.

**Asking for a slot that does not exist yet does not poison it.** `edge` asked 458 times for a slot
the writer had not written, was refused 159 times, and still never fell more than two slots behind. A
refusal cost 827ms, which is a node searching rather than a node remembering.

**The lookup fails against a node holding every chunk locally.** Reading from the writer's own node,
`/feeds/` was still **52.4% frozen at 2.9s mean, floor 1748ms**, while explicit-address reads of the
same chunks stayed at 0% frozen. That rules out retrieval, the network, the gateway, peer accounting
and payment in one step, and leaves the lookup itself.

**The chunks were always there.** The witness topic came back fully current on every run.

## What this retracts

**The client was never the cause.** The previous revision said the player poisoned its own stream by
asking for the next slot before the publisher wrote it. The fix built on that (`a4f9841`) moved the
follow-up path onto `/feeds/`, which is the slow path, and was reverted in `303184c`. The player's
existing behaviour, one explicit slot address per poll, is the fast path and measures at 0% frozen.

**The catch-up ceiling is not one.** The claim was that one slot consumed per poll against one slot
written per segment is zero margin by construction. hls.js reloads an unchanged live playlist at half
the target duration, which is two asks per slot written, and `lag` closed a 20 slot gap from a
standing start. The 578 second browser drift needs another explanation.

**Every frozen-share figure this project has published measures the lookup, not the viewer.** The
bench resolves the feed through `/feeds/` ([gateway.ts](../../e2e/src/bench/gateway.ts)), which is 50
to 57% frozen on its own. The player calls `/feeds/` only on mount. So the instrument was on the
broken path and the product mostly was not, and the two were never measuring the same thing.

## The one thing that reconciles the older probe

An earlier probe found, on four consecutive freezes, that the slot one past the resolved head
answered 404 in a constant 196ms while slots two to ten past it answered 200 in about 230ms. That
reads as a remembered negative, and it was attributed to our client hammering that slot.

The better explanation is that **the lookup poisons itself**. To know that N is the head it has to
ask for N+1 and be told no, and it appears to keep that answer. The probe's own `/feeds/` calls
supplied all the asking that was needed, which is also why every A/B carried the effect in both arms.

Stated as the best available account rather than as proven. The mechanism has not been read from
bee's source.

## What to do next, in order

1. ~~**Measure what the lookup costs the product.**~~ Partly done. The player calls `/feeds/` once per
   mount and is fine. Still open: the catalog is polled continuously through the same endpoint in
   [App.tsx](../../packages/client/src/providers/App.tsx) and
   [StreamPreview.tsx](../../packages/client/src/components/StreamPreview/StreamPreview.tsx), which
   is a shipped path sitting on a lookup that stalls half the time.
2. ~~**Re-baseline the bench.**~~ Done, `f1bfc7c`. What remains is re-running the sweep, because
   `profiles.md` is entirely head-lookup measurements and its figures move by more than a constant:
   the head reader also delivers a third of the segments, so sample counts, stall lengths and buffer
   recommendations all describe the reader.
3. **Measure through the client's own code rather than a second implementation of it.** The bench
   reimplements the player's feed following, and this whole episode is what two implementations
   drifting looks like. The client's `ManifestFetcher` already runs under Node: the only obstacles
   are `@/utils/config`, which reads `import.meta.env` at module scope, and `p-queue`, which `e2e`
   does not depend on. Moving `ManifestManagement.ts`, `feedState.ts` and `fetchWithTimeout.ts` into
   `@swarm-hls-stream/shared` leaves one implementation for both.
4. **Rewrite the upstream report** (#59) around the synthetic rig. It reproduces without this
   repository, without video and without a gateway: a feed advancing at one update per second cannot
   be followed through `/feeds/` even by the node that wrote it, while explicit-address reads of the
   same chunks are perfect. That is a far stronger report than the one drafted before, and this time
   it is genuinely bee's rather than ours.
5. **Leave the client alone.** It is on the fast path already.

## Hypotheses considered and how each died

- **Our client asking early.** Refuted by the rig above, after a fix had been written and committed
  on the strength of it. 458 premature asks, no degradation.
- **Inbound reachability.** Both nodes were `Private` for the project's whole life and were opened
  2026-08-04. Never cleanly measured, and no longer a candidate: the lookup fails on the writer's own
  node, which needs no inbound anything.
- **Light vs full node.** An owner constraint rather than a hypothesis: **no full nodes.** Moot now.
- **Bee version.** 2.8.1 is the newest that exists and this repo has pinned it since the initial
  commit, so it never drifted.
- **Redundancy on the feed write.** `FeedUploadOptions` is `{ act, pin, encrypt, deferred }`, so
  bee-js cannot carry `redundancyLevel` on a feed write, and one chunk has nothing to erasure code.
  Eliminated by reading the API.
- **Shallow pushsync receipts.** Ours run 7.09% against 2.05% on a reference node with mode, host,
  version, reachability and peer count controlled. Real asymmetry, but flat across the freeze cycle
  at 0.94x with no step at release.
- **Our uploader's code.** Manifest windowed at 10 segments so it stays one chunk, no periodic timer,
  `commitManifest` serialised behind a `concurrency: 1` queue so no `socIndex` race, stamps valid,
  zero push errors.
- **Chunk cache capacity.** 0 to 1M made it measurably worse, 18% to 28% frozen. Reverted.
- **Payment.** Real, and the change stands: funding the gateway took the measured frozen share from
  37% to 18-25%. Note what that measurement was made with, though. It moved a figure produced by the
  `/feeds/` lookup, so what improved may be how quickly the lookup gives up rather than anything a
  viewer sees.
