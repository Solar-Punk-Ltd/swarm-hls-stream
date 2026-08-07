# The same test at 1080p: the control failed, and that is the answer

**2026-08-07.** The 720p ABA of `a-quarter-second-buys-nothing-2026-08-07.md` closed with a scope
warning in its own text: one deployment, **720p at about 2776 kbps**, one viewer. **1080p at 6000k is
what ships.** So the whole thing was run again at the resolution the product serves.

Three twenty-minute arms, **0.25s / 1.0s / 0.25s**, 1920x1080 at 6000 kbps. Reports
`browser-watch-2026-08-07T05-17-00-109Z`, `…T05-38-05-913Z`, `…T05-58-55-646Z`.

⛔ **The two 0.25s control arms disagree by 0.92 seconds, and the effect being measured is 0.85. The
latency comparison is void.** That is not a disappointing run. It is the result an AB design cannot
produce, and the reason this was run as an ABA.

## The control, which is the first thing to read

| window | arm 1, 0.25s | arm 3, 0.25s |
| --- | ---: | ---: |
| 0-5 min | 5.91s | 6.81s |
| 5-10 min | 5.89s | 6.82s |
| 10-15 min | 5.88s | 6.82s |
| 15-20 min | 5.87s | 6.80s |
| **median** | **5.89s** | **6.81s** |
| drift across the arm | -0.04s | -0.01s |

**Each arm is flat to a hundredth of a second, and they sit 0.92s apart from each other.** So this is
not sample noise inside a run. Something moved between the arms, forty minutes apart, in one sitting,
on one deployment, with nothing touched in between.

At 720p the same two arms agreed to **0.00s** and eight windows spanned 0.05s. Same design, same
runner, same host, one variable changed.

## What that does to the comparison

| | 0.25s (arms 1, 3) | 1.0s (arm 2) | verdict |
| --- | ---: | ---: | --- |
| **behind live, median** | 5.89s, **6.81s** | 5.04s | ⛔ **VOID** |
| **refused segments** | 33 (0.7%), 73 (1.6%) | **0 (0.0%)** | ✅ separates |
| **uploader BZZ per minute** | 0.0383, 0.0377 | **0.0348** | ✅ separates |
| BZZ per megabyte | 0.00080, 0.00079 | 0.00073 | ✅ separates |
| postage buckets per minute | 0.20, 0.25 | 0.25 | ⛔ no resolution |
| median transfer | 91ms, 89ms | 222ms | (not a verdict) |
| segment bytes delivered | 795, 794 kB/s | 792 kB/s | same picture |

All three arms: **1.001 media seconds per wall second, zero frozen samples, zero forward seeks, zero
rebuffers, zero fatal errors, 30.0 fps, 1920x1080.**

### Latency: void, and the arithmetic is the whole argument

The 1.0s arm sits **0.85s** below the nearer control arm and 1.77s below the farther one. The two
control arms are **0.92s** apart. **0.92 is larger than 0.85**, so a reading that put the 1.0s arm
below both is equally consistent with it having been run at a moment between two conditions that
differed by more than the effect.

⛔ **The 720p latency result is not overturned and it is not extended.** It stands where it was
measured, on its own tight control. This run says nothing about whether it holds at 1080p, which is
exactly the gap it was run to close and did not.

### Cost: survives, and it is worth a third of what it was

The control arms agree to **1.6%** here, which is the write side behaving exactly as
`between-session-drift.md` said it does: the read path moves between sittings and the write path does
not. That is why one half of this run is readable and the other is not.

Against a control mean of 0.0380, the 1.0s arm's 0.0348 is a **8.4% reduction**.

⚠️ **At 720p the same measurement gave 23.5%.** Both are real and the difference is not a
contradiction: the saving is per-segment overhead, and at 1080p each segment carries four times the
bytes, so that overhead is a much smaller share of the bill. **The cost argument for a longer segment
is worth about a third as much at the resolution that ships.**

### Refusals: separate for the third independent time

33 and 73 on the 0.25s arms, **zero** on the 1.0s arm. The two control arms disagree on the rate, 0.7%
against 1.6%, which is consistent with the episodic pattern the 720p run measured, but **both are
non-zero and the 1.0s arm is exactly zero**.

Counting the 60-minute pair and both ABAs, that is now four sittings in which a 0.25s segment produced
refusals and a 1.0s segment produced none. No viewer paid in any of them: `segments never served` is 0
and `time spent waiting between attempts` is 0ms in all three arms here.

### Postage: still no resolution, as expected

0.20, 0.25 and 0.25 buckets per minute, which is 4, 5 and 5 buckets. **The two control arms disagree**,
so twenty minutes still cannot resolve an integer maximum over 65,536 buckets. This is the third run to
say so and it agrees with the retraction made this morning.

## Why the sitting drifted, which is not established

Not known. What can be said:

- **It is not within-arm noise.** Both control arms are flat to 0.01-0.04s across four windows each.
- **It is not the join.** Both 0.25s arms joined at exactly **9.33s**, the same to two decimals. Only
  the steady state differs.
- **It is not the picture.** 795 and 794 kB/s, 30.0 fps, 1920x1080 in both.
- **It is not the write path.** BZZ per minute agrees to 1.6% between them.
- **It is monotone in run order** in this one sitting, arm 3 worse than arm 1, which is consistent with
  something accumulating and equally consistent with coincidence at n=2.

Candidates not separated: ambient load on the host, which runs a permanent unrelated encode, and the
postage batch filling from 97 to 111 of 256 across the sitting.

⭐ **Incidentally confirmed:** the joins are exactly what the byte-budgeted live window predicts.
`9.33s` at a 0.25s segment matches the roughly 9.0s of media the window holds at that length, and
`6.23s` at 1.0s matches `LIVE_SYNC_DURATION_S = 6` with the window no longer the binding constraint.
The two profiles join differently by design rather than by fault.

## What a reader should take from this

1. **The 720p result stands, at 720p.** Its control held.
2. **It has not been shown to hold at 1080p**, and one attempt to show it has failed on the control.
3. **The cost half survives at both**, at 23.5% and 8.4%, so the direction is settled and the size
   depends on the resolution.
4. **The refusal half survives at both**, qualitatively, now across four sittings.
5. ⛔ **The profile decision has less behind it than this morning, not more.** Its largest claimed
   benefit is unmeasured at the resolution that ships, and its cost benefit there is a third of what
   was quoted.

**What it would take to close it:** the same ABA at 1080p on a sitting whose control arms agree.
Nothing about the design needs changing, only a sitting that holds still, and this one did not. Adding
a fourth arm would not have helped: the two controls already bracket the treatment and already
disagree.
