# Which profile a viewer survives on: the golden-zone sitting, written up five days late

**Run 2026-08-10, written up 2026-08-15.** Artefacts at
`/home/solarpunk/retrieval-probe/goldenzone2-20260810-155801`, driver
`deploy/scripts/overnight-golden-zone.sh`. All arms unfunded, no spend possible.

> ## ⛔⛔⛔ WHY THIS FILE EXISTS
>
> This sitting ran, cost a night, and **was never written into the corpus**. Its result lived only in
> a memory file, where it was stated more confidently than the data supports and rested on a
> corroboration that has since been withdrawn. A 2026-08-15 audit of the corpus found it because the
> memory cited no document at all.
>
> ⭐ **The write-up is not a formality. Re-reading the raw log changed the finding**, and the two
> things that changed it are a permutation test the original never ran and a caveat that arrived
> three days after the run.

## What it measured

Three encoder profiles, five rounds each, 400 segment retrievals per arm, one unfunded bee gateway,
arm order rotated between rounds. Each profile is scored against **its own segment duration as the
budget**, so a late share means "arrived too late for its own playback slot" and the profiles are
comparable.

| arm | profile | budget | mean segment |
| --- | --- | ---: | ---: |
| **S720** | 0.25s / 720p | 267ms | 120 KB |
| **M480** | 1.0s / 480p | 1000ms | 358 KB |
| **M720** | 1.0s / 720p | 1000ms | 466 KB |

Plus a **canary**, the same 150-segment list fetched twice on one node, and a **20-round soak** at
M720 for phase B.

## Result 1: the medians separate completely, with no overlap at all

| arm | median per round | p90 | share of budget |
| --- | --- | ---: | ---: |
| **S720** | 113 119 126 127 128 ms | 214 ms | **46%** |
| **M480** | 230 261 330 395 414 ms | 932 ms | **33%** |
| **M720** | 749 757 768 773 775 ms | 1088 ms | **76%** |

⭐ **Every S720 round is faster than every M480 round, and every M480 round is faster than every M720
round.** Three disjoint ranges over five rounds each. Whatever else is uncertain below, the ordering
of the typical retrieval is not.

⚠️ **M480's median is unstable**, 230 to 414 ms, a 1.8x spread across rounds where the other two sit
inside 13% and 4%. Nothing here explains it.

## Result 2: ⛔ THE LATE SHARE DOES NOT ORDER THE TWO SMALLER PROFILES, AND THE ORIGINAL SAID IT DID

| arm | late share by round | mean |
| --- | --- | ---: |
| **S720** | 16.5 5.2 4.0 4.2 9.2 % | **7.8%** |
| **M480** | 13.5 8.8 10.2 9.2 7.2 % | **9.8%** |
| **M720** | 20.5 19.8 15.5 25.2 12.0 % | **18.6%** |

Exact two-sided permutation tests on the difference of means, all 252 arrangements enumerated:

| contrast | difference | exact p | |
| --- | ---: | ---: | --- |
| S720 vs M480 | 1.96 pts | **0.468** | ⛔ **NOT separated** |
| M480 vs M720 | 8.82 pts | **0.016** | ✅ separated |
| S720 vs M720 | 10.78 pts | **0.024** | ✅ separated |

⛔⛔⛔ **S720 and M480 are indistinguishable on the statistic the sitting was scored on.** S720's
rounds run 4.0 to 16.5% and M480's run 7.2 to 13.5%. One arm's range contains the other's mean.

⛔⛔ **This kills the lesson the sitting was remembered for.** The memory drew from it: *"M480 has the
best median/budget ratio (33%) and a worse late share than S720. Score profiles on the tail against
their own budget, never on the median."* The premise of that sentence is the S720-versus-M480 late
share, and **it is the one contrast in the sitting that does not hold**. Meanwhile the median, the
statistic it told the reader to distrust, is the one that separates all three cleanly.

⭐ **What survives is narrower and still useful: M720 is worse than both, on both statistics.** A
1.0s/720p profile put 18.6% of retrievals past their own budget against 7.8% and 9.8%.

## Result 3: ⚠️ AND IT IS NOT A CLEAN SIZE EXPERIMENT, WHICH IS HOW IT WAS READ

The memory concluded **"segment size in bytes orders the result, not segment duration"**. The three
arms move two variables:

| contrast | duration | resolution | bytes | significant |
| --- | --- | --- | --- | --- |
| S720 vs M720 | **0.25s → 1.0s** | fixed 720p | 120 → 466 KB | ✅ |
| M480 vs M720 | fixed 1.0s | **480p → 720p** | 358 → 466 KB | ✅ |
| S720 vs M480 | 0.25s → 1.0s | 720p → 480p | 120 → 358 KB | ⛔ |

**Both significant contrasts change bytes and something else.** Bytes is a consistent ordering
variable across all three arms, and so is "at least one of duration or resolution went up". Nothing
here separates them, because no pair holds bytes fixed while moving duration.

⛔ **So "bytes, not duration" is not a result of this sitting.** It is a reading of it. Separating the
two needs a design where a long segment and a short one carry the same bytes, which is task **#84**
and has never been run.

## ⛔⛔ Three caveats the original had no way to carry

1. **The gateway ran at `--cache-capacity=0` throughout**, which was believed at the time to mean
   "cache off". It does not. On 2026-08-13 that setting was found to be a **thrash loop** in which
   each round drops a hard-coded 10,000 chunks, so the cache is a sawtooth whose phase nothing here
   records. Every arm is affected, and arm order was rotated, so this is unlikely to have created the
   ordering. It is a source of the round-to-round spread that the sitting cannot quantify.
2. **The canary is a weak repeatability bound and points the wrong way for comfort.** The same
   150-segment list, twice, back to back on one node, gave **12.0% and then 6.0%** late. That is a
   2x swing on identical work. ⚠️ It is not a clean bound, because the two canary arms ran at host
   load 26.7 and 19.7 while every profile arm ran at 3.4 to 12.2. But a harness that can produce 6%
   and 12% on the same input is not one that should be asked to resolve 7.8% from 9.8%.
3. **The cross-instrument corroboration is gone.** The memory's stated reason to believe the ordering
   was that a browser node agreed with it on completely different apparatus. That browser result was
   **withdrawn on 2026-08-11**: the cliff was corpus decay, and on fresh content every size delivers
   8/8 with the ordering inverted. See `size-on-healthy-content-2026-08-11.md`. **The independent
   support this sitting leaned on no longer exists.**

## Phase B: an unfunded node does not drift over two hours

20 rounds at M720, about two hours, 10,000 retrievals.

| | |
| --- | ---: |
| median across rounds | 726 to 760 ms |
| late share | 11.2 to 17.0%, mean **13.8%** |
| trend | none visible |

⭐ **The risk from running unfunded is a level, not a drift.** Round 20 looks like round 1. This is
the part of the sitting that holds up best: it is one profile, twenty repeats, and it asks a question
about time rather than about a contrast between arms.

⚠️ M720's phase B mean of 13.8% sits below its phase A mean of 18.6% on the same profile and the same
night. Nothing here explains that either, and it is a further reason to treat the phase A late shares
as noisy.

## What this changes

- ✅ **KEEP: 1.0s/720p is the worst of the three**, on two statistics, at p ≈ 0.02.
- ✅ **KEEP: an unfunded gateway does not decay over two hours.**
- ✅ **KEEP: the median ordering**, which is clean and complete.
- ⛔ **WITHDRAW: "M480 has a worse late share than S720."** p = 0.47.
- ⛔ **WITHDRAW: "score on the tail, never the median."** The tail is what failed to separate here.
- ⛔ **WITHDRAW: "segment size in bytes orders the result, not segment duration."** The design cannot
  separate them. See **#84**.
- ⛔ **WITHDRAW the cross-instrument corroboration.** It was decay.

⚠️ **None of this touches the shipping decision.** 0.5s/720p is chosen on the funded GOP sittings of
2026-08-12, not on this one. See `gop-sustain-2026-08-12.md` and
`gop-floor-replicate-2026-08-12.md`.
