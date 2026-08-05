# Segment length at 720p, measured on a sound instrument

**2026-08-05. Twelve runs, three interleaved rounds, four GOPs, 3762 samples and 0 discarded, of
which 3179 sit in admissible rows.** The first screening grid this project has produced where the
instrument was not itself the finding.

**The answer: 0.5 seconds, at a median 1.17s behind live.** And the reason is not that half a second
is special. It is that **the uploader needs about 500ms of work per segment**, so at a 0.5s GOP the
pipeline is running at almost exactly 100% duty cycle, and anything shorter cannot keep up.

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

**So the uploader's work per segment is `upload + manifestPublish`**, and the media only supplies GOP
milliseconds of wall clock to do it in:

| GOP | work per segment | wall clock available | duty cycle |
| ---: | ---: | ---: | ---: |
| 0.25s | 436ms | 250ms | **174%, impossible** |
| 0.5s | 498ms | 500ms | **99.6%, exactly at the edge** |
| 1.0s | 592ms | 1000ms | 59% |
| 2.0s | 747ms | 2000ms | 37% |

At 0.25s the pipeline is asked for 174% of the time it has, so a backlog forms and grows. It surfaces
in `feedPropagation` as 2804ms, which is not propagation at all but queueing in front of it. In round
1 that backlog was visible growing inside a single run, from 2.54s over the first thirty samples to
7.55s over the last thirty, and that run delivered only 643 of the ~720 segments it owed where every
other row delivered 98 to 99%.

**0.5s sits at 99.6%.** That is why it wins and also why it is the one row with any spread worth
mentioning: it has no headroom, so any jitter shows up.

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
duration itself, and the second term is the uploader's fixed per-segment cost.

**Not settled.**

- **Why 0.5s round 1 measured 1.63s against 1.17s twice.** At 99.6% duty cycle there is no slack, so
  this may simply be what no headroom looks like.
- **Whether the 500ms of per-segment work can be reduced.** This is now the highest value question in
  the project, because it is what stands between us and sub-second. `upload` is 274ms and
  `manifestPublish` is 224ms at the winning configuration. Halving them would put 0.25s inside its
  budget and, on the model below, near 0.7s.
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
