# The quarter second, measured once the instrument could see it

**2026-08-05. Six 3-minute runs, two configurations, three interleaved rounds with the order reversed
on even rounds. 402 samples across 4 usable runs.**

This is the run that reopens the question [`segment-length-2026-08-05.md`](./segment-length-2026-08-05.md)
retracted. Those 0.25s rows reported 8.71s and 2.58s and were measuring the bench's own follower
falling behind. The follower now walks to the live edge in one read, so the deficit no longer
compounds.

## The result

| GOP    | round | segment produced | **capture to fetchable, median** | verdict                    |
| ------ | ----: | ---------------: | -------------------------------: | -------------------------- |
| 0.5s   |     1 |           0.533s |                            1.73s | ok, 3 slots a poll         |
| 0.5s   |     2 |           0.500s |                        **1.61s** | ok, 5 slots a poll         |
| 0.5s   |     3 |           0.633s |                                — | AXIS FAIL, encoder         |
| 0.25s  |     1 |           0.666s |                                — | AXIS FAIL, encoder         |
| 0.25s  |     2 |           0.266s |                        **1.06s** | ok, 17 slots a poll        |
| 0.25s  |     3 |           0.266s |                        **1.00s** | ok, 27 slots a poll        |

**A quarter second GOP is about 0.65s better than a half second one**, 1.00 to 1.06s against 1.61 to
1.73s, on runs taken alternately within one sitting. That matters because two sittings of one
configuration have differed by 1.05s, which is larger than this whole effect, so only rows taken
beside each other can be read against each other.

⚠️ **Two clean runs each, not three.** The rounds that failed did so for the encoder rather than for
the reader, and one failure landed on each configuration, so the comparison is not lopsided. It is
still four runs.

## Why it is faster, which is the part that could have been an artifact

The follower now walks past slots without sampling them, so a 0.25s run measured 33 segments of about
660 while a 0.5s run measured 124 of about 270. **Every sample is the newest manifest at its poll**,
which is what a viewer at the live edge sees, but it is a different selection from before and a
shorter GOP skips more. If that selection were producing the win, the win would sit in the hop that
depends on when the reader looked.

It does not. The per-hop split of the two cleanest runs:

| hop                 | 0.5s (round 2) | 0.25s (round 3) | change     |
| ------------------- | -------------: | --------------: | ---------: |
| segment             |          500ms |           266ms | **−234ms** |
| upload              |          275ms |           218ms |      −57ms |
| manifestPublish     |          225ms |           215ms |      −10ms |
| feedPropagation     |           39ms |            52ms |  **+13ms** |
| fetch               |          566ms |           241ms | **−325ms** |

The two movers are the first frame waiting for its own segment to close, which is the GOP by
definition, and retrieving the payload, which is half the bytes. **`feedPropagation`, the hop most
exposed to which segment was sampled, went up rather than down.** That is evidence against the
selection driving the result, and it is not proof.

## The reader is no longer the ceiling

| run       | reader slots/s | publisher slots/s | slots a poll |
| --------- | -------------: | ----------------: | -----------: |
| 0.5s r1   |           1.86 |              1.88 |            3 |
| 0.5s r2   |           2.03 |              2.00 |            5 |
| 0.25s r2  |           3.76 |              3.76 |           17 |
| 0.25s r3  |           3.77 |              3.76 |           27 |

**Within 1.6% in every run.** Before the fix the reader managed about 3.8 slots per second against the
4 a 0.25s GOP writes and lost the difference permanently.

⚠️ **The throughput did not change and that is worth being clear about.** The reader still manages
about 3.8 slot reads per second, because a slot read costs roughly 260ms against a local gateway and
the walk does not make it cheaper. What changed is where the reader ends up: a walk that reaches the
edge leaves the sample fresh no matter how long the loop took, and `feedPropagation` at 39 to 52ms is
the independent evidence of that, since a reader sitting 30 slots back would report seconds there.

⚠️ **27 slots a poll against a bound of 32.** The 0.25s runs sit at 84% of `MAX_WALK_PER_READ`. A
faster publisher or a slower gateway pushes them into the bound, and a reader that hits the bound
every poll falls behind again. So the floor has moved below a quarter second but **not far below**,
and the next configuration down should not be assumed measurable.

## The encoder missed its GOP in 2 of 6 runs, at 720p

| requested | produced | packets | packets the produced length implies |
| --------- | -------: | ------: | ----------------------------------: |
| 0.5s      |   0.633s |      15 |                                  19 |
| 0.25s     |   0.666s |       8 |                                  20 |

**The packet count is right for the requested GOP and the declared duration is not.** 15 frames is
0.50s of video at 30fps and 8 frames is 0.27s, so both segments carried exactly what was asked for
and declared a third to two and a half times longer.

This is the signature recorded against 1080p at 6000kbps, which was read there as the encoder falling
behind real time. **It is not confined to 1080p and it is not confined to one GOP**: it hit 720p at
2500kbps, at both segment lengths, in a third of the runs, intermittently. Whatever it is, it is a
publish-path defect rather than a picture-size limit, and it is the largest remaining source of runs
that cost a broadcast and yield nothing.

## What this does not say

**Nothing here is a steady-state figure.** Three minutes is the screening length, chosen because a
3-minute run reproduces a 10-minute median to within 0.06s. The tail does not converge that fast, and
none of these runs was gated at 10 minutes.

**The recommended-buffer and behind-live columns in the individual reports are not comparable across
these runs**, because they are derived from the worst gap observed and the polls are now far apart at
0.25s. Read `capture to fetchable` and the hop split, which are per-sample.
