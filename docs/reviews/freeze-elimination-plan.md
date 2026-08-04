# Eliminating the periodic freeze (LAT-10)

**Status 2026-08-04: ROOT CAUSE FOUND. It is ours, in the client, and the fix is not yet written.**

This document started as a ranked hypothesis list treating the freeze as Bee's. That framing is
superseded. The hypotheses and how each died are kept at the bottom, because the reasoning is worth
more than the conclusions were.

## The root cause

**Asking a bee node for a feed index before the publisher writes it makes that index unretrievable for
30 to 45 seconds afterwards.**

Measured during four consecutive freezes, probing offsets past the reader's stuck index N:

|          offset | asked for before?       | result     |                    time |
| --------------: | ----------------------- | ---------- | ----------------------: |
|          **+1** | **hammered every poll** | **404**    | **196-197ms, constant** |
| +2, +3, +5, +10 | never                   | **200 OK** |               204-722ms |
|        +20, +40 | never                   | 404        |              730-1022ms |

Identical at indices 524, 555, 587 and 651. The publisher writes sequentially, so N+1 exists if
N+2 does. It is not missing, it is blocked, and our own earlier request is what blocked it.

**Three timing classes separate cleanly, and that separation is the evidence.** A genuine miss costs
~900ms because the node searches. A real hit costs ~230ms. The poisoned index answers in **196ms
every single time**, which is a remembered answer rather than a search.

**The 63 second period is the lifetime of that remembered negative.** Segments were never affected
because they are only fetched after the manifest names them, so they are never requested early. That
is why "SOCs are slow, content chunks are fast" looked like a property of Bee. It was request ordering.

## Why nothing found this for two days

**Every experiment used a reader that asks for the next index, so every arm of every A/B poisoned
itself equally.** The funding comparison, the cache test, the segment-length sweep, the picture-size
comparison, the two-observer run and the shallow-receipt probe all carried the cause on both sides. No
comparison between two poisoned readers can reveal poisoning.

This is the strongest instance yet of the lesson that a control has to differ in the thing being
tested. Both arms were identical in exactly the variable that mattered.

## The two bugs, both in `packages/client/src/components/SwarmHlsPlayer/ManifestManagement.ts`

### Bug 1: the freeze, in `handleFollowupFetch`

```ts
const targetIndex = fromIndex.next();
this.fetchResource(`soc/${owner}/${targetId}`);
```

It asks for index N+1 on every poll, which is almost always before the publisher has written it,
because a caught-up viewer is the normal case. Every one of those poisons that slot.

### Bug 2: the cumulative drift, same method

The client never resyncs to the head once it holds an index. `handleInitialFetch` reads `/feeds/` and
gets latest, but only runs on mount or after a full teardown.

The publisher writes one index per segment. hls.js reloads about once per target duration. The client
advances **at most one index per poll**. **Consumption equals production exactly, with zero margin by
construction**, so any backlog is permanent and every freeze is cumulative.

This predicts the **578 second drift** observed in the browser check, which was recorded as a
hidden-tab artefact and dismissed. It was real.

## The fix: one change closes both

**Read `/feeds/{owner}/{topicHex}` and let the node resolve latest, instead of computing a speculative
SOC address.** It never asks for an index that does not exist, and it returns the head, so there is no
catch-up ceiling. Fetch an explicit index only for a slot already known to exist.

It is also why an earlier version of this setup did not freeze: a client reading the feed endpoint
cannot poison anything.

**Read before touching**, because the current shape is deliberate and the comments say why:

- pinning the index fixed an earlier bug where two callbacks each advanced and skipped a slot
- the `inFlight` guard and the generation guard inside the `manifestQueue` callback each prevent a
  specific failure, both documented in place
- `recordGatewayReachable` and `recordGatewayResponse` are deliberately different, see `feedState.ts`
- the 404 path must keep calling `reportStalledFeed`, for a publisher that genuinely stopped

**Test first.** The uncovered case is "the client is many slots behind": assert it reaches the head
rather than advancing one slot. That gap is what let this ship.

## How to proceed, in order

1. **Write the fix** (#65), test first, then `pnpm verify`.
2. **Re-measure** against the standing baseline of eight 30-minute runs at 720p 2500kbps, 2.0s GOP.
   **Success is the frozen share collapsing, not merely improving.** Use the calibrated harness: null
   control at 1.95x so noise is known, paired design at zero false positives, alignment on the
   transition rather than population comparison.
3. **Re-measure inbound reachability** (#H1 below). The firewall was opened and both nodes went
   `isReachable: true`, but the run measuring it was discarded as contaminated by the probe. It is
   unspent and now cheap to redo cleanly.
4. **Correct the record** (#22). The superseded conclusion is stated confidently in the LAT-10
   register row, `docs/bench/concurrency.md`, `docs/bench/profiles.md` and this file's history. All of
   it needs the reframe, not just the register.
5. **Then decide on #59**, the upstream report, which is currently marked do-not-send. If the fix
   removes the freeze, what remains upstream is at most a documentation question, and it would need
   the mechanism read from bee's source plus a reproduction that does not involve this repo.

**Every latency figure this project has published was measured through a poisoned reader.** The
profile sweep, the operating profiles, the buffer recommendations. LAT-11's concurrency result
survives because both arms were poisoned identically, but the absolute numbers are all inflated by an
effect we now know how to remove. Re-baselining after the fix is part of step 2, not a separate task.

## Hypotheses considered and how each died

Kept because the eliminations remain valid and re-testing them would be waste.

- **H1, inbound reachability.** Both nodes were `Private` for the project's whole life. Opened
  2026-08-04, both flipped to reachable immediately. **Still unmeasured**, run discarded as
  contaminated. Worth one clean run, but no longer a candidate root cause.
- **Light vs full node.** Not a hypothesis, an owner constraint: **no full nodes.** With light nodes
  only there is no reserve and no pullsync, so on-demand retrieval is the whole path. That made the
  freeze look structural, and it is why the root cause hid so well.
- **Bee version.** 2.8.1 released 2026-07-07 is the newest that exists, and this repo has pinned it
  since the initial commit, so it never drifted. Only downgrades were available, to 2.7.0 or 2.6.0.
  **Moot now.**
- **Redundancy on the feed write.** `FeedUploadOptions` is `{ act, pin, encrypt, deferred }`. bee-js
  cannot carry `redundancyLevel` on a feed write, and a single chunk has nothing to erasure code.
  **Eliminated by reading the API, without a run.**
- **Shallow pushsync receipts.** Ours run 7.09% against 2.05% on a reference node with mode, host,
  version, reachability and peer count controlled. Real asymmetry, **but flat across the freeze cycle
  at 0.94x with no step at release.** Not the freeze.
- **Our uploader's code.** Manifest windowed at 10 segments so it stays one chunk, no periodic timer,
  `commitManifest` serialized behind a `concurrency: 1` queue so no `socIndex` race, stamps valid,
  zero push errors. **Clean.**
- **Chunk cache capacity.** 0 to 1M made it measurably **worse**, 18% to 28% frozen. Reverted.
- **Payment.** Real and fixed: funding the gateway took the frozen share 37% to 18-25%. **A genuine
  second cause, worth about 40%, and independent of the root cause above.**
