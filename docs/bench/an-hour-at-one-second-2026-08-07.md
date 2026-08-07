# An hour at a one second GOP, and it is cheaper than the profile that ships

**2026-08-07.** Phase 0.5c, the control for 0.5b. Sixty minutes at a 1.0s GOP through the shipped
client in a real browser, against 0.5b's sixty minutes at 0.25s. Full report in
`browser-watch-2026-08-07T02-01-57-110Z.md`.

It is also the **first sixty-minute run scored with the corrected advance ratio**. 0.5b was measured
before the fix of `6105afb`, so its 1.000 could in principle have contained a freeze and the seek that
ended it. This one reports **zero forward seeks** on its own row, which is the check 0.5b could not do.

⚠️ **The per-sample `.json` beside each report is gitignored and lives only on the machine that ran
it.** Reports say "the whole series is in the `.json` beside this file" and that is true of a working
tree, not of a clone. Every replay this project has done, including the one that found the advance
ratio defect, needed those files. Worth knowing before planning another.

## The control holds

| | 0.5b, 0.25s GOP | 0.5c, 1.0s GOP |
| --- | ---: | ---: |
| samples | 3558 over 3599.4s | 3556 over 3599.6s |
| **media seconds per wall second** | **1.000** | **1.000** |
| samples where playback did not advance | 0 | 0 |
| forward seeks | not measured | **none** |
| rebuffers | 1, 246ms | **0, 0ms** |
| fatal errors | 0 | 0 |
| windows at or above 0.99 | 12 of 12 | 12 of 12 |
| resolution decoded | 1280x720 | 1280x720 |
| **segment bytes delivered** | **346 kB/s** | **344 kB/s** |

**The two runs delivered the same picture.** Same resolution, and the bitrate matches to within 0.6%,
which is what makes the cost comparison below a comparison of one variable rather than two.

So the hour that held at 0.25s also holds at 1.0s, and the stability result of 0.5b is not specific to
the profile it was measured on.

## What a quarter of the segments cost

Read off the deployment either side of each run rather than estimated.

| per broadcast-minute | 0.25s GOP | 1.0s GOP | change |
| --- | ---: | ---: | ---: |
| **uploader BZZ** | 0.0179 | **0.0128** | **-28%** |
| ~~postage, fullest bucket~~ | ~~0.22~~ | ~~0.15~~ | ⛔ **RETRACTED** |
| BZZ per MB delivered | 0.00086 | **0.00062** | **-28%** |

⛔ **The postage row is withdrawn, 2026-08-07.** `utilization` is the fullest of 65,536 buckets, so it
is a maximum, and a maximum grows fastest while the batch is empty. The 0.25s run measured it at
**3.5% full** and the 1.0s run at **33.2% full**, so the fall from 0.216 to 0.150 could be entirely the
batch filling up rather than anything about segment length. The ABA of the same day cannot rescue it
either: its three arms all ran at 36 to 38% full, and twenty minutes moved the counter by 1, 2 and 0.
**The postage effect of segment length is unmeasured.** See
`a-quarter-second-buys-nothing-2026-08-07.md`. The BZZ rows are unaffected, because a chequebook
balance is a continuous quantity read directly rather than a maximum over buckets.

✅ **The BZZ row survived its control**: the ABA measured 0.0163 and 0.0169 against 0.0127 inside one
sitting, a 23.5% reduction against the 28% claimed here.

⭐ **Segment length is a cost lever at constant bitrate, worth about a quarter of the write cost.**
Both runs pushed the same bytes, so this is not a bandwidth saving. Four times fewer segments means
four times fewer manifest publishes, each of which is a synchronous single-owner-chunk write, and four
times fewer partial trailing chunks.

⚠️ **This corrects a claim made earlier the same day and it is worth reading why.** Across the 17
recorded browser runs, BZZ per MB delivered sat inside 0.00081 to 0.00096 over a 2.5x spread in
bitrate, which looked like a clean per-byte law. **Every one of those runs was at a 0.25s GOP**, and
that scope was stated at the time. This run is the first outside it, and the per-byte figure moves by
**1.39x**, so the law was a law about one profile. The correctly stated scope is what made the test
worth running.

⛔ **A two-term model fits these two runs and is NOT evidence.** Solving
`BZZ = a x MB + b x segments` on 0.5b and 0.5c gives about **0.00053 BZZ per MB plus 0.0000304 BZZ per
segment**, which it must, since two runs determine two parameters exactly. Checked against a third run
it under-predicts: the 1080p ten-minute run of 2026-08-06 06:21 spent 0.3970 BZZ against a predicted
0.3308, **17% low**. So there is a per-segment term and its size is not established. Do not quote those
coefficients.

## The refusals are gone, and this run cannot say why

0.5b found something no shorter run had: **94 refusals in 13,617 requests, 0.7%**, where every 150s run
had zero. The question it left open was whether that is a property of duration or of request volume.

**0.5c had zero refusals in 3,608 requests.** Neither hypothesis survives cleanly: duration predicted
about 94, request volume predicted about 25, and the answer is none.

⚠️ **But this comparison is across sittings and the refusal count is a read-side quantity, so it is
confounded.** `between-session-drift.md` measured the same configuration 1.05s apart on different
nights, ten times the within-session spread, and placed the whole movement on `feedPropagation` and
`fetch`, which are exactly the hops that decide whether a segment is there when the player asks. A
night with faster propagation would show fewer refusals at any segment length.

**What is not confounded is the cost.** That same drift study found the write side unmoved between
sessions: `segment` identical to a few milliseconds, `upload` 478-488ms against 474-500ms. BZZ and
postage are paid on the write side, so the 28% and 32% above are the figures this run supports best.

## What this does not settle

⛔ **It is not an argument to change the shipping profile, and must not be read as one.** The viewer
figures differ in 1.0s's favour, median 5.28s behind live against 5.59s and a 6.25s join against
11.60s, and **every one of those differences is smaller than the 1.05s between-session drift**. A
profile decision needs the two run back to back in one sitting.

What it does establish is that such a sitting is worth paying for. If 1.0s holds an hour as well as
0.25s does, delivers the same picture, and costs 28% less to write, then the case for 0.25s rests on a
latency advantage this run did not see.

✅ **That sitting was run the same day and the latency advantage was not there.** Three twenty-minute
arms, 0.25s / 1.0s / 0.25s, with the control arms agreeing to 0.00s at the median: **5.86s behind live
at 0.25s against 5.52s at 1.0s**, and no overlap between any window of one and any window of the other.
The short profile is a third of a second **further** from live. The 149 refusals also turned out to be
the profile rather than the night. See `a-quarter-second-buys-nothing-2026-08-07.md`.

⚠️ **Dropped frames went from 333 to 1479.** For 1.0s that is an exact **1.35%** of 108,040 decoded.
For 0.25s it can only be estimated, because **`decodedFrames` did not exist in that run's samples**:
0.5b's `deliveredFps` is null for the same reason, so frames per second cannot be compared between
these two runs at all. Against the ~108,000 frames an hour of 30fps implies, 333 is about 0.3%.

The drops are diffuse in both rather than bunched: the largest single-sample jump is 5 frames at 0.25s
and 15 at 1.0s, so neither is one stall. Neither run rebuffered, both held 1.000 and 1.0s delivered
30.00 fps, so nothing reached the viewer's picture. A larger segment arriving at once on a software
display is the obvious suspect and it is **not investigated**. Worth settling before anyone reads the
frame counter as a quality signal.

## What it consumed

| | before | after |
| --- | ---: | ---: |
| uploader chequebook | 7.011 BZZ | **6.241 BZZ** |
| postage, fullest bucket | 85/256 | **94/256** |

At this run's own rate that is 488 broadcast-minutes of BZZ and 1083 of postage, and the batch expires
in 28.8 days. **At the 1080p 0.25s rate measured on 2026-08-06 it is 160 minutes**, which is the figure
to size the next sweep against rather than this one.
