# The standing experiment programme

**2026-08-05. The umbrella over [`optimisation-plan.md`](optimisation-plan.md), which is its first
phase. This one is about how experiments are chosen, ordered, guarded and kept, so that a finding
still means something in three months.**

## 0. The rule that outranks everything else here

**Before an experiment runs, write down the result that would refute it.** If both the hypothesis and
its negation predict the same observation, the experiment is decoration and must be redesigned.

This is not a principle borrowed from elsewhere. It is the direct lesson of 2026-08-05, when a premise
was tested before an hour of broadcasts was spent on it, using the one case where the two competing
explanations agreed, and twelve runs were lost. Testing a premise is not the discipline. Naming the
refutation is.

Three corollaries, each paid for:

1. **A run must prove its own axis moved** before its rows count. Enforced by
   [`check-axis.py`](../../e2e/src/probes/check-axis.py).
2. **An instrument and the product must share one implementation**, or they will diverge and the
   instrument will be reported as the product. Enforced by `nextFeedRequest` in
   [`feedFollow.ts`](../../packages/shared/src/feedFollow.ts).
3. **Ask what the instrument cannot see**, not only what it says. The bench could not measure a
   latency below its own publisher lead and silently discarded 79% of the fastest configuration.

## 1. What is finished, and what is open

Nothing new starts until the open column is empty.

|                                | state                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LAT-10, the freeze             | **Closed.** bee's sequential head lookup, one second floor, growing with the log of feed length. Source-confirmed.                                     |
| The instrument                 | **Three defects found and fixed today**: it read the feed the wrong way, it could not see below the publisher lead, and it did not check its own axis. |
| Between-session drift          | **Found, not explained.** 1.05s between sittings on identical settings, entirely in the two Swarm read hops.                                           |
| The screening grid             | **Open.** Two attempts invalidated. Third needs the fixed instrument.                                                                                  |
| The catalog on `/feeds/` (#73) | **Open**, and it is the largest known shipped defect.                                                                                                  |
| Concurrency, LAT-11 (#70)      | **Open.** Magnitudes need redoing on the explicit-address path.                                                                                        |
| Stuck-slot recovery (#71)      | **Open**, found by reading, needs a repro.                                                                                                             |
| Upstream report (#59)          | **Ready to write.** Measurement and source both in hand.                                                                                               |

## 2. How an experiment is chosen: cost per answer

Ordered cheapest first, and the ordering is the method. A question that can be answered in a tier
above must not be taken to a tier below.

| tier                          | cost                           | what it can answer                                                                                                                   | what it cannot                        |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| **0. Read**                   | free                           | Contracts, defaults, arithmetic, whether a knob exists. The `LIVE_WINDOW_SIZE` cap and the `hls_aof_ratio` rule both came from here. | Anything about behaviour under load   |
| **1. Existing artifacts**     | free                           | Re-analysis of 140 runs already paid for. The three-minute screening result came from here.                                          | Anything not already measured         |
| **2. Synthetic rig**          | ~1 bucket                      | Everything about how a feed is **read**: lookup cost, concurrency, cache settings, catalog shapes                                    | Segment throughput, encoder behaviour |
| **3. Broadcast, no redeploy** | minutes of postage             | Encoder knobs inside the `HLS_FRAGMENT <= GOP <= HLS_FRAGMENT * HLS_AOF_RATIO` window                                                | Anything needing engine config        |
| **4. Broadcast + redeploy**   | postage plus ~1 min per config | Engine knobs, fragment, window, SRT                                                                                                  | Anything needing a different engine   |
| **5. Engine swap**            | a redeploy of the profile      | SRS against OME on one stack                                                                                                         | Two engines side by side              |
| **6. Second stack**           | **on-chain, owner only**       | True parallel engines, real multi-node topologies                                                                                    |                                       |

## 3. The axes

### 3a. Encoder and segment (tier 3, in progress)

Segment length, resolution, bitrate, frame rate. The current grid. Segment length is the dominant
lever because the `segment` hop **is** the segment duration, and it is the largest single term in the
split.

**Reopen below 0.5s.** The retired grid said a quarter second was worse, and that finding is now
suspect twice over: it was measured through the broken feed reader, and a faster pipeline is censored
harder by the lead bug. Both biases push a fast configuration to look worse.

### 3b. Uploader and client code (tiers 0-2)

`LIVE_WINDOW_SIZE` against the player's buffer target. The client's unbounded manifest accumulation.
Stuck-slot recovery. Speculative segment prefetch, since the reference is known one poll early. The
catalog's read pattern (#73).

### 3c. Swarm and infrastructure (tier 2, some tier 6)

Cache capacity, redundancy on segment uploads, batch depth, gateway topology, whether a viewer's
gateway should be co-located. **And the open drift question**, which is the most valuable one here: a
1.05s swing nobody can attribute is worth more than most knobs, because it bounds what any knob can
be shown to be worth.

### 3d. Engines (tiers 5-6)

SRS today. OME reached **6/11** on the e2e suite and must not be called working until it passes.

**The drift finding constrains this axis hard.** Engines cannot be compared across sittings, and
swapping engines needs a redeploy, so a fair comparison means interleaving _with_ redeploys: SRS, OME,
SRS, OME, in one sitting, with a reference configuration in each round. That is the design, and it is
why an engine comparison is tier 5 rather than tier 3.

Others worth considering later: nginx-rtmp, MediaMTX, or ffmpeg's own HLS muxer as a floor. The last
is the useful one, because it is the **control**: whatever a real engine adds over raw ffmpeg is what
the engine costs.

### 3e. Architecture (its own branch, after the grid)

LL-HLS is the principled version of what the data already says, since it attacks the `segment` hop
directly. **But our floor is not the encoder.** Every part a viewer fetches must be addressable, which
today means a feed update per part at ~235ms to write and 680-970ms before a reader learns of it. Parts
every 200ms buy nothing against that.

The interesting question is therefore not "does OME do LL-HLS" but **"can a part be fetched without
being announced"**, published at a computable address the client walks speculatively, which is
exactly what took the bench from 37.2s to 4.8s. Measure the announcement floor first. If it stands,
LL-HLS buys far less than its reputation.

## 4. How findings persist

Three layers, and each has a different job.

- **`docs/bench/<finding>.md`**. One document per finding, named for the symptom rather than the
  presumed cause, carrying the table that supports it and an explicit section on what it does **not**
  settle. `feed-reader-ab.md`, `feed-head-scaling.md`, `between-session-drift.md`.
- **`docs/bench/longrun-*.{md,json}`**. Raw runs, never edited. The JSON is what lets a finished
  experiment be re-analysed for a question nobody had asked yet, which is where the three-minute
  screening result came from.
- **Commit messages**. The reasoning, including what was refuted. A finding whose retraction is not
  written down will be rediscovered as a fact.

**A retired finding is marked, never deleted.** `profiles.md` stays with its header saying what
invalidated it. Deleting it loses the record that the project once believed it.

**The gap today: 24 commits unpushed, no PR.** Every artifact above exists on one laptop. That is the
weakest link in the whole persistence story and it costs nothing to fix.

## 5. Sequencing

1. **Re-run the screening grid** on the fixed instrument. Everything else waits on a baseline.
2. **#73, the catalog**, prototyped on the rig first. Largest shipped defect.
3. **#59 upstream**, which is written rather than measured.
4. **#70 concurrency** and **#71 stuck slot**, both cheap.
5. **Reopen segments below 0.5s**, now that two biases against them are gone.
6. **Explain the drift**, or bound it, since it limits every comparison.
7. **Engines**, interleaved with redeploys, ffmpeg-only as the control.
8. **Architecture branch**: measure the announcement floor, then decide about LL-HLS.
