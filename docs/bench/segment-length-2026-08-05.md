# Segment length at 720p, measured on a sound instrument

**2026-08-05. Twelve runs, three interleaved rounds, four GOPs, 3762 samples and 0 discarded, of
which 3179 sit in admissible rows.** The first screening grid this project has produced where the
instrument was not itself the finding.

**The answer: 0.5 seconds, at a median 1.17s behind live.**

Latency tracks segment duration almost linearly, because the `segment` hop **is** the GOP and it is
the largest term in every row. The floor underneath it is that **a quarter second segment saturates
the uploader's segment queue at 96%**, so 0.5s is the shortest length with any headroom at all.

## The grid

Every row is 720p at 2500kbps for 3 minutes. Rounds are interleaved with the order reversed on even
rounds, because two sittings of one configuration have differed by 1.05s while runs inside a sitting
agree to 0.1s. See [`between-session-drift.md`](between-session-drift.md).

| GOP | round 1 | round 2 | round 3 | spread | verdict |
| ---: | ---: | ---: | ---: | ---: | --- |
| 0.25s | 8.71s | **rejected** | 2.58s | n/a | fails its own axis check, and not competitive when it passes |
| **0.5s** | 1.63s | **1.17s** | **1.17s** | **0.46s** | **the operating point** |
| 1.0s | 2.43s | 2.41s | 2.39s | **0.04s** | the stability champion |
| 2.0s | 3.99s | 4.07s | 3.94s | 0.13s | the reference |

Medians of `totalMs`, which is capture to fetchable by a viewer.

**The 1.0s row repeating to within 40ms across three rounds is the single best evidence that the
instrument is now sound.** Nothing this project measured before today repeated that closely.

## Why 0.25s fails, stated as arithmetic rather than as a verdict

The per-hop split, medians over admissible rows only:

| GOP | total | segment | upload | manifestPublish | feedPropagation | fetch |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.25s | 3599 | 266 | 240 | 196 | **2804** | 82 |
| 0.5s | **1203** | 500 | 274 | 224 | **83** | 95 |
| 1.0s | 2409 | 1000 | 363 | 229 | 466 | 148 |
| 2.0s | 3980 | 2000 | 511 | 236 | 929 | 246 |

Two things fall out of that table.

**`manifestPublish` costs 196 to 236ms whatever the segment contains.** A quarter second segment pays
the same feed write as a two second one. This confirms the earlier finding from a retired grid, now
on an instrument that can be trusted.

**⚠️ Corrected after reading the code. An earlier version of this document added `upload` and
`manifestPublish` together and called the sum the work per segment. That is wrong.**
`StreamUploader` runs **two independent queues, `segmentQueue` and `manifestQueue`, each at
concurrency 1**, and `uploadSegment` fires `uploadLiveManifest()` without awaiting it. So the two
hops overlap rather than stacking. The manifest queue also **coalesces**: a `liveManifestQueued` flag
means at most one publish is ever pending, so segments arriving faster than manifests publish share a
manifest rather than queueing one each.

The queue that must keep pace one-for-one with segments is therefore the **segment upload queue
alone**:

| GOP | upload per segment | wall clock available | segment queue duty cycle |
| ---: | ---: | ---: | ---: |
| 0.25s | 240ms | 250ms | **96%, saturated** |
| 0.5s | 274ms | 500ms | 55% |
| 1.0s | 363ms | 1000ms | 36% |
| 2.0s | 511ms | 2000ms | 26% |

**At 0.25s the segment queue is at 96%**, so it has no room for jitter and any hesitation becomes a
backlog it cannot work off. That is the run that delivered only 643 of the ~720 segments it owed,
where every other row delivered 98 to 99%, and whose latency grew inside a single run from 2.54s over
the first thirty samples to 7.55s over the last thirty.

**Everything from 0.5s up has comfortable headroom**, so the duty cycle does not explain why 0.5s
beats 1.0s. Segment duration itself does: the `segment` hop **is** the GOP, and it is the largest
term in every row.

**What is not yet explained** is where the 0.25s backlog actually forms. It surfaces as 2804ms of
`feedPropagation`, which is measured *after* the uploader's SOC write returns, and that write is
`deferred: false` so it has already push-synced. So the queueing is somewhere the uploader's own
queues do not account for, most likely inside bee. That is the thread to pull.

## What the axis guard caught, and why it matters more than the result

**Round 2's 0.25s run measured 0.99s, the fastest figure in the whole grid, and it is not a reading.**
The guard rejected it: 0.300s segments for a 0.25s GOP, 8 packets against the 9 that 30fps implies,
so it delivered about 26.7fps. The frames were not there to be late.

That is the same signature that removed 1080p from this grid. **The most attractive number in the
sweep was the invalid one**, which is the argument for the guard in one line. It was written after a
sweep swept an axis that never moved, and its first real outing rejected the row most likely to have
been quoted.

## What this does and does not settle

**Settled.** Among 720p configurations reachable without a redeploy, 0.5s is the best operating point
and 1.0s is the choice if consistency matters more than 1.2 seconds. The dominant term is the segment
duration itself. What sets the floor is that a 0.25s segment leaves the segment upload queue at 96%.

**Not settled.**

- **Why 0.5s round 1 measured 1.63s against 1.17s twice.** The segment queue sits at 55% there, so
  headroom is not the explanation and this is unaccounted for.
- **Where the 0.25s backlog forms.** It appears as `feedPropagation`, after a SOC write that already
  push-synced, so the uploader's own queues do not explain it. Until that is answered, "cut the
  uploader's per-segment cost" is a plausible lead rather than a diagnosis.
- **Whether `upload` can be cut.** 240 to 511ms depending on segment size, and it is the one hop that
  must keep pace one-for-one with segments. It is what puts 0.25s at 96%.
- **Whether `manifestPublish` can be cut.** 196 to 236ms whatever the segment holds. It is coalesced
  so it does not gate throughput, but it does sit on the path between a segment landing and a viewer
  being told about it.
- **Anything beyond three minutes.** These are screening runs. The gate is ten.
- **1080p**, which is out of the grid entirely until it can hold 30fps through the publish path.

## The model, offered as a prediction to be refuted

Least squares through the three configurations that have headroom:

> **latency ≈ 1.84 × GOP + 0.38s**

| GOP | predicted | measured | residual |
| ---: | ---: | ---: | ---: |
| 0.5s | 1.30s | 1.17s | +0.13s |
| 1.0s | 2.22s | 2.41s | -0.19s |
| 2.0s | 4.05s | 3.99s | +0.06s |

Residuals stay under 0.2s, which is smaller than the between-sitting drift, so the line is worth
about as much as the data behind it and no more. Three points do not establish a law.

It predicts **0.84s for a 0.25s GOP if the duty cycle problem were fixed**, which is the experiment
that tests the model and the fix at the same time. If a fixed pipeline delivers a quarter second GOP
and the answer is not near 0.84s, the linear reading is wrong and something else scales with segment
length.

## Provenance

Twelve runs from 04:49 to 05:30 UTC on `latbench`, SRS 6.0.184 at `hls_fragment 0.25`,
`hls_aof_ratio 10`, `hls_window 30`. Raw reports are the `longrun-2026-08-05T04-5*` and
`longrun-2026-08-05T05-*` pairs beside this file. Cost 0.605 BZZ from the uploader chequebook and
0.484 from the gateway, about 0.099 BZZ per run.
