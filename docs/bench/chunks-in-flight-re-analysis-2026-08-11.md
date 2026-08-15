# Bigger fetches are FASTER per byte and MORE likely to miss a deadline, in the same data

> ## ⚠️ THE PER-BYTE RATE IS CONDITIONED ON COMPLETION, AND COMPLETION IS SIZE-DEPENDENT HERE
>
> "The largest delivered fetch is the fastest per byte" is computed over **fetches that completed**,
> on a corpus later shown to be decaying. A large object fails whenever any one of its ~1,000 chunks
> is missing, so large fetches that survive are selected for having every chunk present, while small
> ones survive routinely. This document records the selection itself two sections later: in the
> replicate's healthy round 0, **the two largest references never completed inside the 60s budget**.
>
> ⛔ **So the ordering below is a survivor comparison, not a rate comparison.**
> `size-on-healthy-content-2026-08-11.md` measures the same question on fresh content, where every
> size delivers 8/8.

**2026-08-11. Free re-analysis, no new measurement.** Phase 1 of `DATA-AUDIT-PLAN.md`, and its first
worked example: the same rows answer two reasonable questions with opposite conclusions.

Chunk counts throughout are `ceil(bytes / 4096)`, Swarm's chunk payload size.

## Why this was looked at

weeb-3 caps **segment** loads at 4 (`stream_hls.rs:3720`) and **chunk** retrievals at 2,048
(`lib.rs:321`). A 90 KB segment is ~23 chunks, so our bench profile fills 4.5% of the semaphore that
matters. If throughput follows chunks in flight rather than segments, every in-browser figure we hold
was taken on a starved node. See `abel-sustain-prediction-2026-08-11.md`.

⛔ **The concurrency sittings cannot answer this.** They all fetched ~90 KB, so chunks are just
segments times 23.1, to three significant figures, in every arm. Two perfectly collinear variables
cannot be told apart. The fragment sittings can, because they varied size at **one fetch at a time**.

## The fragment sittings, in the order the fetches were issued

Only rounds whose canary came back are shown. ⛔ `in-browser-fragment-profile-2026-08-10.tsv` rounds 1
and 2 and `...-replication-...` rounds 2 and 3 are all degraded, canaries included, and are excluded
here exactly as their own headers instruct.

| sitting, round | chunks | KB/s |
| --- | ---: | ---: |
| orig r0 | 57 | 132 |
| orig r0 | 59 | 180 |
| orig r0 | 111 | 242 |
| **orig r0** | **330** | **336** |
| orig r0 | 52 | 200 |
| rep r0 | 60 | 145 |
| rep r0 | 56 | 100 |
| rep r0 | 125 | 128 |
| **rep r0** | **317** | **244** |
| rep r0 | 30 | 55 |
| rep r1 | 57 | 190 |
| rep r1 | 48 | 87 |
| rep r1 | 116 | 113 |
| rep r1 | 35 | 40 |

⭐⭐ **In all three healthy rounds the largest delivered fetch is the fastest per byte**, and the
smallest is at or near the slowest. The two largest, 330 and 317 chunks, are the two fastest single
fetches in the corpus at 336 and 244 KB/s, against 40-55 KB/s for the ~30 chunk fetches.

⭐ Order does not explain it. In orig r0 the 330 chunk fetch came **fourth** and the 52 chunk fetch
**fifth**, so the big one was not helped by arriving on a fresher node: 336 KB/s before, 200 KB/s
after.

## ⭐⭐ It agrees with the concurrency sittings once both are read in chunks

| what was running | chunks in flight | KB/s |
| --- | ---: | ---: |
| 1 x 30 chunks | 30 | 55 |
| 4 x 23 chunks (c4) | ~92 | 235 |
| **1 x 330 chunks** | **330** | **336** |
| 16 x 23 chunks (c16) | ~368 | 410-467 |

A single fetch and a sixteen-way arm land together when they put a comparable number of chunks in
flight. Grouping the same chunks into 1 request or 16 barely moves the result, which a segment-level
ceiling cannot produce.

## ⛔⛔ AND YET "BIGGER FRAGMENTS ARE WORSE" IS ALSO TRUE, IN THE SAME ROUNDS

Big fetches that **arrive** arrive faster per byte. They also **fail to arrive** far more often. In
the replicate's healthy round 0, the two largest references never completed inside the 60s budget at
all. In the original's round 1, a 642 chunk fetch took **132 seconds**.

⭐⭐⭐ **The two findings are not in conflict, they are answers to different questions:**

| question | metric | answer |
| --- | --- | --- |
| how fast do bytes arrive once they do? | KB/s per fetch | **bigger is better** |
| does a fetch finish inside a deadline? | delivered / attempted | **bigger is worse** |

A fixed per-fetch timeout scores a large segment as a failure precisely because it is large, and the
absolute wait grows with size even while the rate improves. This is flag rule **F2** in the audit plan,
and it is now demonstrated rather than merely suspected.

## What this does and does not license

✅ **Does:** raise the prior that the in-browser throughput ceiling is a property of our 90 KB segments
rather than of the browser node. It is now supported by 14 fetches across two sittings, in the
direction the source constants predict.

⛔ **Does not:** settle it. n is small, the healthy-round subset is chosen by a canary rule, and every
row here is a single sequential fetch, not four in flight against a saturated semaphore. Nothing here
shows the node can hold **1,018 KB/s**, only that its throughput rises with chunk pressure over the
30 to 330 range.

⚠️ **Does not** overturn [[swarm-hls-fragment-size-cliff]]. That finding is about delivery inside a
budget and it stands. What is new is that it must be quoted with its metric attached, because the
per-byte reading of the same rows points the other way.
