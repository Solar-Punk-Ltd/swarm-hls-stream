# The corpus does not corroborate the 0.25s GOP 404 result, and does not refute it either

**2026-08-12, free.** `gop-floor-2026-08-12.md` measured a 0.25s GOP losing 18-21% of live-edge reads
to 404 where 0.5s lost none. This checks that against every `longrun-*.json` on disk, 101 reports
spanning 2026-08-04 to 2026-08-12, using the discard counts `distil-longrun.mjs` surfaced.

**The check was run to strengthen the claim. It weakened it, and this records the weaker version.**

## 37 of 101 reports have censored samples

| discard share | reports |
| --- | ---: |
| over 50% | 6 |
| 20 to 50% | 5 |
| under 20% | 26 |
| none | 64 |

The worst is `2026-08-04T11-05`, which kept **6 samples and discarded 45**, and the
`2026-08-05T02-43` to `03-50` block, which runs to 82%. Those carry reasons like "the segment's first
frame implies it was" and "cannot measure how much media", which are the instrument defects of that
era rather than retrieval failures.

⭐ **Any median taken from a report in that list is taken over a survivor set.** That is now visible
because `distil-longrun.mjs` prints the discard column, which nothing did before.

## The 0.25 comparison, which is where the claim lives

Every GOP 0.25 run on disk, in order:

| when | report carries `segmentBytes` | samples | fetch ms | 404 share |
| --- | --- | ---: | ---: | ---: |
| 2026-08-05T04-55 | **no** | 643 | 82 | **0.0%** |
| 2026-08-05T05-12 | **no** | 583 | 87 | **0.0%** |
| 2026-08-05T05-23 | **no** | 663 | 81 | **0.0%** |
| 2026-08-05T08-45 | **no** | 134 | 593 | **0.0%** |
| 2026-08-05T08-48 | **no** | 37 | 293 | **0.0%** |
| 2026-08-05T08-59 | **no** | 33 | 241 | 2.9% |
| 2026-08-05T10-58 | yes | 79 | 329 | 14.1% |
| 2026-08-05T11-09 | yes | 92 | 301 | 5.2% |
| 2026-08-05T11-40 | yes | 90 | 321 | 5.3% |
| 2026-08-05T12-02 | yes | 65 | 492 | 22.6% |
| 2026-08-05T12-28 | yes | 77 | 128 | **0.0%** |
| 2026-08-12T07-14 | yes | 76 | 316 | 18.3% |
| 2026-08-12T07-23 | yes | 79 | 263 | 18.6% |
| 2026-08-12T07-49 | yes | 66 | 305 | 21.4% |

⛔⛔ **The 404 share tracks the report schema, not the GOP.** Every run whose report predates the
`segmentBytes` field sits at or under 2.9%. Seven of the eight that carry it sit at 5 to 23%. The GOP
is 0.25 in all fourteen and the segment is 266-270 ms in all but one.

⛔ **And it is not deterministic even within the current instrument**: `2026-08-05T12-28` carries
`segmentBytes`, ran ten minutes at a 0.25s GOP, and discarded nothing.

## What this changes

⛔⛔ **Withdrawn: "the corpus replicates the finding across two weeks, n=8."** It was written in this
session before the schema column was looked at, and it does not survive it. Eight runs showing 404s at
a 0.25s GOP is not eight independent replications when six of the fourteen come from a different
instrument version and one current-instrument run shows none.

✅ **Unaffected: the within-sitting contrast of `gop-floor-2026-08-12`.** One sitting, one instrument
version, one rig state, arms alternated between rounds: 0.25 gave 18.3 / 18.6 / 21.4% and 0.5 gave
0 / 0 / 0%. Interleaving is exactly the design that controls for everything this corpus check cannot,
which is why it was used.

⭐ **So the claim should read**: *measured within a single sitting on the current instrument, a 0.25s
GOP produced 404s at the live edge where a 0.5s GOP produced none.* Not: *a 0.25s GOP breaks
retrieval.*

⚠️ **The product recommendation does not move.** 0.5 was already the recommendation, the reasons above
it are independent of this, and nothing here argues for going below it. What changes is how strongly
the 404 result may be stated, not what gets shipped.

## The two things still unexplained, both recorded rather than solved

⚠️ **The read rate.** The three zero-404 runs read 3.7 segments a second and the runs with 404s read
0.14 to 0.16, a **25x** gap at the same GOP and the same segment length. That is the same unexplained
slow-read observation `gop-floor-2026-08-12` recorded, now seen to predate it by a week.

⚠️ **The fetch hop.** 81-87 ms in those same three runs against 263-492 ms elsewhere, on segments of
the same duration. ⛔ **No mechanism is claimed for either**, and the two co-vary with each other and
with the schema, so nothing here separates them.
