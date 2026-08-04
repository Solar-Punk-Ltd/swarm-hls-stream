# Finding the operating points worth shipping

**Status 2026-08-04. A plan, not a result. It starts here because the instrument was fixed today and
this is the first time the project has had a latency figure that repeats.**

Three ten-minute broadcasts of the same configuration now agree to within 0.11s on the median and
0.12s on p95. Everything before today was measured through bee's feed head lookup, which is frozen
half the time and delivers a third of the segments, so the whole of `docs/bench/profiles.md` and every
tuning conclusion drawn from it describes the reader rather than the deployment. See
[`feed-reader-ab.md`](../bench/feed-reader-ab.md).

So the question the owner is asking, which configuration gives the most stable stream at the best
picture, is answerable for the first time. This is how to answer it without repeating the mistake that
made it necessary.

## 1. What "optimum" has to mean before anything is measured

There is no single best. There are three quantities that trade against each other, and a
configuration is only interesting if it wins one of them without failing the others.

**Stability is a gate, not a score.** A configuration is **admissible** only if, across all its
repeats:

| gate                    | measured by                                                       | why it is a gate                                                                         |
| ----------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| the viewer never stalls | longest feed stall < recommended buffer + one segment             | a rebuffer is not a worse number, it is a broken stream                                  |
| the picture arrives     | frame delivery ratio ≥ 0.98 of the packets the frame rate implies | 1080p emitted 30 frames over 1.6-2.0s at 15-18fps in 3 of 9 runs, unretracted            |
| it does not decay       | buffer demand in the last third ≤ first third + 0.5s              | a setting derived from the opening of a run that later stalls is worse than useless      |
| nothing is dropped      | discarded segments = 0                                            | a discarded segment is a segment the bench could not read, and a viewer could not either |

**Quality is what arrives, not what was requested.** Report resolution and bitrate alongside the
delivery ratio, always. A 1080p row that delivers 60% of its frames is a 1080p request and a worse
picture than 720p.

**Latency is the score**, and only among admissible configurations. The figure is "behind live at the
recommended buffer", because that is what a viewer experiences, rather than capture-to-fetchable,
which is what the pipeline does.

**The output is a small set of named profiles**, not a winner: lowest latency, best picture, most
robust. The operator picks the tier and the profile tells them what it costs.

## 2. The budget is the binding constraint, and it is postage

Broadcasting is the only thing in this campaign that spends anything. The stamp `46ad3454` stands at
**49 of 64 buckets** with 13.7 days of TTL, and 43 minutes of 720p at 2500kbps cost 6 buckets. That
leaves roughly **105 minutes of broadcast at 720p 2500kbps**, and cost scales with bitrate, so the
same budget is about 44 minutes at 6000kbps and 29 at 9000.

It is also **mutable**, which means it does not fail when it fills, it silently evicts (#62). A sweep
that overruns does not stop, it quietly starts destroying the chunks earlier runs measured.

### The free result that resizes the campaign

A short run predicts a long one. Taken from the three good runs, with no new broadcasts:

| window | median error vs the full run | p95 error |
| -----: | ---------------------------: | --------: |
|     2m |                        0.08s |     0.05s |
|     3m |                        0.06s |     0.08s |
|     5m |                        0.08s |     0.08s |

Against a **between-run spread of 0.11s on the median and 0.12s on p95**. Truncating a run to three
minutes costs less than repeating it does, so **three-minute runs carry the same information as
ten-minute ones** for median and p95, and the budget goes three times further.

**The tail does not converge and must not be shortened.** Worst-case spread between the three runs is
1.32s, and run 1's 8.31s outlier first appeared at minute 4. So the stability gates, which are all
tail quantities, need full-length runs. **Screen at three minutes, gate at ten.**

Convergence is a property of a configuration, not a law. Re-run the same check on each new
configuration's own artifacts rather than assuming it holds.

### The ask, which is on-chain and therefore the owner's

The full grid below plus confirmation does not fit in 15 buckets. **One new depth-22 batch, roughly
0.3 BZZ at what the last one cost, bought immutable rather than mutable.** Immutable fails an upload
loudly when it is full, which is the behaviour a measurement batch wants, and it removes the silent
eviction that #62 is open on.

Without it the campaign can screen but cannot confirm, and an unconfirmed winner is how this project
got sixteen profiles it has now had to retire.

## 3. Phase 1, everything answerable without spending postage

The synthetic rig from LAT-10 writes one 4KB chunk per second and costs a rounding error. Anything
about **how a feed is read** can be answered with it, in minutes, for nothing. Only questions about
**how video is written** need a broadcast.

| #   | question                                         | why it matters                                                                                                                                                                             | cost |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 1.1 | What does the catalog pay for `/feeds/`? (#66)   | `App.tsx:67` and `StreamPreview.tsx:60` poll the endpoint that is 50-57% frozen. This is shipped, on every page load, and unmeasured.                                                      | free |
| 1.2 | Does caching the head plus walking fix it?       | Same change that took the bench from 37.2s to 4.8s. Prototype against the rig before touching the app.                                                                                     | free |
| 1.3 | Concurrent viewers, redone (LAT-11)              | The 1.30x staleness at 8 viewers was measured through the broken lookup in both arms. Direction survives, magnitude does not.                                                              | free |
| 1.4 | `--cache-capacity` 0 vs 1M, redone               | "0 to 1M made it worse, 18% to 28% frozen" is a head-lookup measurement of a read path. Re-test on the explicit-address path.                                                              | free |
| 1.5 | How large can the manifest window go?            | `LIVE_WINDOW_SIZE = 10` gives about 1.3KB. A chunk is 4KB, so roughly 30 fits. A larger window is free catch-up headroom for a viewer who fell behind. Check the byte size, then the read. | free |
| 1.6 | Does a refused slot cost more than a served one? | The rig measured 827ms for a 404 against 46ms for a 200. A caught-up viewer gets a 404 on nearly every poll, so this sits in the steady-state path.                                        | free |

Phase 1 has no postage cost and no dependency on the new batch. **It runs first, and some of it may
land improvements before the grid begins.**

Its limit is worth stating plainly: the rig writes 4KB payloads, so it can answer questions about the
feed and says nothing about segment throughput.

## 4. Phase 2, the grid that needs broadcasts

Two things are already known and should not be re-measured from scratch: **0.25s segments are worse
than 0.5s at every picture** because a manifest write costs about 220ms whatever it carries, and
**quality is paid in Swarm rather than in the encoder**, since `manifestPublish` was 217-254ms from
480p to 1080p9000k. Both were measured through the broken reader, so treat them as strong priors that
the screen should confirm cheaply rather than as settled facts.

**Screening, three minutes per run, two repeats:**

| axis    | values                  | note                                                                     |
| ------- | ----------------------- | ------------------------------------------------------------------------ |
| segment | 0.5s, 1.0s, 2.0s        | `BENCH_GOP_SECONDS`, with `HLS_FRAGMENT` moved to match                  |
| picture | 720p 2500k, 1080p 6000k | 480p was already not worth carrying, and 9000k only if 6000k gates clean |

Six configurations, two repeats, three minutes each: 36 minutes of broadcast, weighted by bitrate.
Then **gate the best two or three at ten minutes, three repeats**, which is where the stability gates
are actually decided.

**Order the runs so that a budget overrun loses the least.** Cheapest and most likely to win first,
so that stopping early still leaves a usable answer. Log the utilization before and after every run
and stop at 60 of 64, not 64.

## 5. Phase 3, the frontier and the named profiles

Publish `docs/bench/profiles.md` afresh, retiring the current one wholesale rather than editing it.
For each admissible configuration, one row: delivered picture, behind-live at the recommended buffer,
longest stall, delivery ratio, demand growth, and the number of runs behind it.

Then name two or three profiles from the frontier, each with the exact env it corresponds to and the
one sentence saying what it gives up.

**One formula needs fixing before the report is trusted.** The recommended buffer is computed as
"floor + 2s poll + one segment", where the 2s is the _bench's_ poll cadence. hls.js reloads an
unchanged live playlist at half the target duration, so the player's own term is smaller and every
recommendation in the report is conservative by roughly a second. Fix it to use the player's cadence,
which is now derivable from the shared follower.

## 6. Phase 4, the changes the measurements would justify

Nothing here is a decision yet. Each is a candidate with the evidence that would license it.

| candidate                            | lever                                   | licensed by                  | expected                                                                                                                                             |
| ------------------------------------ | --------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Take the catalog off the head lookup | code, `App.tsx` and `StreamPreview.tsx` | 1.1 and 1.2                  | The largest known unfixed exposure to a 50-57% frozen endpoint, on a shipped path                                                                    |
| Re-derive the player buffer          | config, `LIVE_SYNC_DURATION_S`          | Phase 2 plus the formula fix | `6` was derived from head-lookup floors. The three good runs recommend 9.02 to 10.31s at a 2.0s segment, so the shipped value may be below the floor |
| Enlarge the manifest window          | code, `LIVE_WINDOW_SIZE`                | 1.5                          | Free catch-up headroom while the manifest stays one chunk                                                                                            |
| Prefetch the next segment's bytes    | code, client                            | Phase 2 hop split            | The segment fetch sits on the critical path and its ref is known one poll early                                                                      |
| Gateway cache capacity               | infra, `BEE_GATEWAY_CACHE_CAPACITY`     | 1.4                          | Currently 0 on a conclusion that needs redoing                                                                                                       |
| A gateway per viewer group           | infra                                   | 1.3                          | Only if concurrency still degrades once measured properly                                                                                            |

## 7. What must be re-measured rather than inherited

Every one of these is a conclusion this project holds that was produced through the broken reader.
They are not wrong by a constant, because the head reader also dropped two thirds of the segments, so
sample counts, stall lengths and buffer recommendations all describe the reader.

- all sixteen rows of `docs/bench/profiles.md`, 86 runs
- the tuning that set `HLS_FRAGMENT` to 1.0 and `LIVE_SYNC_DURATION_S` to 6
- the concurrent-viewer magnitudes (LAT-11), direction excepted
- the gateway funding result, worth "40%" of a figure the lookup produced
- the cache-capacity result

## 8. How this campaign avoids the failure that produced it

The bench and the player each owned a copy of one decision, they disagreed, and nothing failed for
months. That is now structurally prevented: `nextFeedRequest` in
[`packages/shared/src/feedFollow.ts`](../../packages/shared/src/feedFollow.ts) makes the decision
once, the player and the bench both route on it, and three suites assert that following a feed costs
exactly one head lookup however long it is followed.

Three habits carry that forward:

1. **Test the premise before validating the fix.** The LAT-10 client fix was written, committed, and
   refuted an hour later by a six-minute rig that cost nothing. Build the cheap refutation first.
2. **A control arm that should not move.** Every synthetic run carries a witness topic that is written
   and read once at the end. When it moves, the rig is wrong, not the product.
3. **Say what was dropped.** A run cut short by budget, a configuration skipped, a repeat that failed:
   name it in the report. Silent truncation reads as coverage.
