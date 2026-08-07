# A quarter second buys a viewer nothing here, and costs them a third of a second

**2026-08-07.** Three twenty-minute watches back to back in one sitting: **0.25s, 1.0s, 0.25s**. The
comparison `an-hour-at-one-second-2026-08-07.md` said was needed and could not be made across nights.

Reports: `browser-watch-2026-08-07T03-08-34-009Z`, `…T03-29-36-844Z`, `…T03-50-48-906Z`.

## The control worked, which is the only reason the rest can be read

An ABA rather than an AB, because two arms cannot tell the profile from the hour. The two 0.25s arms
are forty minutes apart and bracket the 1.0s one.

| window | arm 1, 0.25s | arm 3, 0.25s |
| --- | ---: | ---: |
| 0-5 min | 5.87s | 5.85s |
| 5-10 min | 5.86s | 5.86s |
| 10-15 min | 5.85s | 5.86s |
| 15-20 min | 5.82s | 5.85s |

✅ **Eight windows inside 0.05 seconds, and both arms report a median of 5.86s.** The sitting did not
drift. Against the **1.05s** that `between-session-drift.md` measured between nights, that is the whole
justification for the design.

## Three complete separations

| | 0.25s (arms 1 and 3) | 1.0s (arm 2) |
| --- | ---: | ---: |
| **behind live, median** | **5.86s, 5.86s** | **5.52s** |
| behind live, every 5-min window | 5.82 to 5.87 | 5.03 to 5.75 |
| **refused segments** | **67 (1.5%), 82 (1.8%)** | **0 (0.0%)** |
| **uploader BZZ per broadcast-minute** | **0.0163, 0.0169** | **0.0127** |
| segment bytes delivered | 347, 347 kB/s | 345 kB/s |
| media seconds per wall second | 1.001, 1.001 | 1.001 |
| samples that did not advance | 0, 0 | 0 |
| forward seeks | none, none | none |
| rebuffers | 0, 0 | 2, totalling 749ms |

**No overlap on any of the first three.** Every 1.0s window sat closer to live than every 0.25s window.
Every refusal in the sitting happened on a 0.25s arm. The 1.0s write cost is below both 0.25s arms.

**And the picture is the same**: 347 against 345 kB/s, both 720p at 30.0 fps, both perfect on advance.

### 1. The short profile costs a third of a second of latency

**5.52s against 5.86s.** That is the opposite of the reason a 0.25s GOP is chosen, and it is not noise:
the control arms agree to 0.00s at the median and 0.05s across eight windows.

It also matches what the bench said all along. The roadmap already recorded behind-live as 2.19 / 2.17 /
2.54s across a fourfold change in segment length, and concluded "0.25s's bench win never reaches a
viewer". This says something stronger. It does not merely fail to reach a viewer, **it arrives
reversed**.

### 2. The refusals are the profile, not the night

0.5b found 94 refusals in an hour at 0.25s and 0.5c found none in an hour at 1.0s, a day apart, which
could have been either. **In one sitting: 149 refusals across the two 0.25s arms and zero on the 1.0s
arm.**

⭐ **They are episodic rather than steady, and nothing about them is a join transient.** Read from the
request logs, which keep every non-success in full:

| | first refusal | last | per 5-minute window |
| --- | ---: | ---: | --- |
| arm 1 | 654s | 1205s | 0, 0, 21, 46 |
| arm 3 | 270s | 841s | 1, 33, 48, 0 |

Both arms are quiet, then have an episode, and arm 1's episode had not finished when the watch ended.
That explains why an hour reads 0.7% and twenty minutes reads 1.5 to 1.8%: an average over episodes and
quiet stretches against a window that caught one.

**The mechanism is not established.** A shorter segment leaves less margin between the player asking
and the gateway holding, so an episode of slowness upstream turns into refusals sooner, but that is a
hypothesis. What is measured is that they exist at 0.25s, come in bursts, and vanish at 1.0s.

**No viewer paid for them.** Every refused segment was served on retry, `segments never served at all`
is 0 in all three arms, and `time spent waiting between attempts` is 0ms in all three.

### 3. The write cost is 24% lower, now under control

**0.0163 and 0.0169 against 0.0127 BZZ per broadcast-minute, a 23.5% reduction.** The 60-minute pair
across nights said 28%. Inside one sitting it is 24%, in the same direction and of the same size, so
that finding survives its control.

## ⛔ A retraction: the postage figure in the previous report is not supported

`an-hour-at-one-second-2026-08-07.md` claimed **0.22 to 0.15 buckets per broadcast-minute, -32%**. That
comparison is confounded and the claim is withdrawn.

`utilization` is the **fullest of 65,536 buckets**. A maximum grows fastest while the batch is empty and
then flattens, which this project already recorded when it warned that a single run's projected runway
is a floor rather than an estimate. The two runs were measured at very different fullness:

| run | batch fullness at the start | buckets used | per minute |
| --- | ---: | ---: | ---: |
| 0.5b, 0.25s | 9/256, **3.5%** | 13 | 0.216 |
| 0.5c, 1.0s | 85/256, **33.2%** | 9 | 0.150 |

So the fall from 0.216 to 0.150 could be entirely the batch filling up.

**The ABA cannot rescue it either.** All three arms ran at 36 to 38% full, so they are comparable to
each other, but twenty minutes moved the fullest bucket by **1, 2 and 0**. The metric is an integer
maximum and it has no resolution at this length.

⛔ **The postage effect of segment length is unmeasured.** Measuring it needs runs long enough to move
the counter by tens, at matched batch fullness. **The BZZ effect is measured and controlled and is
unaffected by this**, because a chequebook balance is a continuous quantity read directly.

## The one thing that favours 0.25s, and it is too small to read

**Rebuffers: 0 and 0 against 2 totalling 749ms.** One arm, two events, and the sixty-minute runs point
the other way: 0.25s had one rebuffer of 246ms over an hour and 1.0s had none. Across all five runs the
counts are 0, 0, 1 for 0.25s and 0, 2 for 1.0s. **Nothing can be concluded from five events.**

⚠️ **Dropped frames reproduce and stay unexplained**: 68 and 113 at 0.25s against 458 at 1.0s over the
same twenty minutes, matching the 333 against 1479 of the sixty-minute pair. Around 1.3% of frames
either way, no rebuffer in the arms that dropped fewest, and 30.0 fps delivered in all three. A larger
segment arriving at once on a software display remains the obvious suspect and remains untested.

## What this is, and what it is not

**It is one deployment, one bitrate, one viewer, one sitting.** 720p at about 2500 kbps on latbench,
watched from the deployment host. It says nothing about 1080p, about a viewer on a distant network, or
about a deployment whose gateway is not one hop from its uploader.

**Inside that scope the result is clean**, and it is the strongest evidence this project has on the
question, because it is the only one with a working control.

⛔ **The profile that ships is not changed here.** The evidence now points at 1.0s on every measure that
separated, and that is a product decision about a viewer's experience against a broadcaster's, taken by
someone who owns it. What has changed is that the decision no longer has to be made on bench arrivals:
a viewer has been watched at both settings, back to back, and the short one came second.
