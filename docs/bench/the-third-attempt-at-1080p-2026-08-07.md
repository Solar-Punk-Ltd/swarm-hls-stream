# The third attempt at 1080p: latency will not resolve, and the other three do

**2026-08-07, evening.** `the-same-test-at-1080p-2026-08-07.md` ended by saying what it would take to
close the profile question: "the same ABA at 1080p on a sitting whose control arms agree". This is
that sitting, run with the latency-target gate of `one-stall-costs-a-second-2026-08-07.md` in place.

⛔ **The control failed again**, for a third distinct reason, and this document argues that the right
response is to stop asking. ✅ **Cost, postage and refusals all separated cleanly, with controls
agreeing to 1.2% or exactly**, and together they answer the question the latency measurement was only
one input to.

Reports `browser-watch-2026-08-07T09-47-47-623Z`, `…T10-09-18-102Z`, `…T10-32-55-185Z`. **2.431 BZZ**
spent, chequebook 7.968 to 5.537.

## What was run

Four twenty-minute arms at 1920x1080, 6000 kbps, 30fps, all against one deployment with nothing
redeployed between them.

⛔ **The first arm is void and cost nothing**: its publisher never took the stream id, which
`publish-clock.sh` said at the time and the report confirmed with **0.000 BZZ and 0 postage buckets
over 20.2 minutes**. It was replaced by a fourth arm, which is why the sitting reads **1.0s / 0.25s /
1.0s** rather than the other way round. The design does not care which condition brackets, only that
one appears on both sides.

## The three arms

| | **B1** 1.0s 09:47 | **A1** 0.25s 10:09 | **B2** 1.0s 10:32 |
| --- | ---: | ---: | ---: |
| latency target the player used | **6.00s** | **6.00s** | ⛔ **7.00s** |
| buffer stalls | 0 | 0 | ⛔ **131** |
| rebuffers | 0 | 0 | ⛔ **144** |
| media seconds per wall second | 1.001 | 1.000 | ⛔ **0.942** |
| behind live, median | 5.90s | 5.82s | 6.02s |
| **past its own target, median** | −0.10s | −0.18s | −0.02s |
| refused segments | **0** | 45 (1.0%) | **0** |
| uploader BZZ per minute | **0.0350** | 0.0380 | **0.0346** |
| BZZ per megabyte | **0.00074** | 0.00080 | **0.00078** |
| postage buckets used | **5** | 8 | **5** |
| median transfer | 228ms | **95ms** | 268ms |
| delivered | 792 kB/s | 793 kB/s | 744 kB/s |
| decoded | 30.0fps 1920x1080 | 30.0fps 1920x1080 | 30.4fps 1920x1080 |

## ⛔ Why latency is void again

**The two bracketing arms are not replicates.** B1 played 20 minutes with zero rebuffers at an advance
ratio of 1.001. B2 spent 5.8% of its wall clock frozen, rebuffered 144 times and took 131 stalls. Two
runs of one configuration that differ that much are measuring different conditions, and averaging them
describes neither.

⭐ **The gate is what makes that legible rather than invisible.** B2's raw median is **6.02s**, which
sits innocuously beside A1's 5.82s and would have entered a table as an 0.20s effect. Its report says
instead:

> ⛔ **The latency figures above are against a target that moved, and are not comparable with another
> run's.** The player steered to 7.00s at its worst, which is 1.00s past the configured 6s, after 131
> buffer stalls.

**This is the check working on its first outing, and it fired on two of the four arms.** Without it
this sitting would have produced a fourth confident and wrong number.

### Even normalised, the arms move more than the effect

`medianPastTargetS` subtracts each sample's own target, which is what survives a stall. Per five-minute
window:

| | window 1 | 2 | 3 | 4 | span |
| --- | ---: | ---: | ---: | ---: | ---: |
| B1 1.0s | +0.03 | +0.03 | −0.47 | −0.60 | **0.63s** |
| A1 0.25s | −0.10 | −0.21 | −0.18 | −0.19 | **0.11s** |
| B2 1.0s | −0.44 | −0.47 | −0.47 | **+3.00** | **3.47s** |

The effect between conditions is **0.12s**. The bracketing arms' own within-run spans are **0.63s** and
**3.47s**. ⛔ **The thing being measured is an order of magnitude smaller than the variation of the
instrument's own control**, and no amount of averaging inside a run fixes that.

⚠️ **A tempting rescue, refused.** Dropping B2's degraded final window and B1's first ten minutes makes
the controls agree to 0.07s against a 0.28s effect, and the result becomes significant. B2's collapse
has an independent reason to be excluded. **B1's first ten minutes do not**: B1 was clean throughout,
and its drift from +0.03 to −0.60 is the 1.0s profile's own behaviour. Choosing which half of a clean
arm to keep after seeing the answer is how a false result gets made, so the comparison stays void.

## ✅ What did separate, and it is most of the question

### Cost, with the controls agreeing to 1.2%

0.0350 and 0.0346 BZZ per minute against **0.0380**. Against a control mean of 0.0348 that is an
**8.4% reduction**, which is the same figure this morning's sitting produced from different arms. The
write path does not go through the player's latency target and does not care that B2 was stalling.

### ⭐ Postage, which has never separated before, and the confound is bracketed

**5, 8, 5 buckets.** The two 1.0s arms used exactly the same amount and the 0.25s arm used 60% more.

This matters because a postage claim was **retracted this morning** for exactly the reason that
`utilization` is a maximum over 65,536 buckets and grows fastest while a batch is empty, so two runs at
different fullness are not comparable. Here the batch ran **114 → 119 → 128 → 133 of 256**, from 46.5%
to 52% full, monotonically:

- the two arms that agree sit at the **outside** of that range, at 46.5% and 52%
- the arm that differs sits **between them**, at 50%

⭐ **So fullness increased across the sitting and consumption did not follow it.** The ABA ordering
brackets the confound that forced the retraction. This is the first postage reading on this project
that is worth quoting, and it says a 1.0s segment costs **37% less postage** than a 0.25s one.

### Refusals, for the fourth and fifth independent time

**0 and 0** against 45 (1.0%). As in every previous sitting, no viewer paid: `segments never served` is
0 and `time spent waiting between attempts` is 0ms in all three arms.

## The collapse in B2, which is its own finding

B2 ran **perfectly for fourteen minutes** and then broke, in two minutes:

| minute | latency | buffer | rebuffers | advance | target |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0-12 | 5.53s | 4.6s | 0 | 1.000 | 6 |
| 14 | 9.28s | **0.72s** | **37** | 0.959 | **7** |
| 16 | 10.00s | 0.52s | 53 | 1.020 | 7 |
| 18 | 9.98s | 0.57s | 54 | 0.986 | 7 |

**It is not the write path.** The uploader's log across that window shows segments uploaded about once
a second with no error, no skip and a clean unpublish at the end. **It is not refusals**: zero, and the
gateway served everything it was asked for. What changed is that it served **less** (744 kB/s against
792) and slower (268ms against 228ms), and the player's buffer never recovered.

That is the read path degrading mid-run, which is the same half of the system
`docs/bench/between-session-drift.md` found moving between nights. ⚠️ **Not established:** whether it
is related to the 1.0s profile. It has now happened once in three 1.0s arms at 1080p and never in four
0.25s arms, which is nowhere near enough to say.

## What a reader should take from this

1. ⛔ **Stop trying to measure the segment-length latency effect at 1080p this way.** Three sittings,
   three different failure modes: a stall that moved one arm's target, a publisher that never started,
   and a deployment that degraded mid-arm. The effect is **at most about half a second** and probably
   nearer a tenth, against controls that move by more than that.
2. ✅ **The decision does not need it.** Cost separates at 8.4% with controls agreeing to 1.2%, postage
   at 37% with controls agreeing exactly, and refusals qualitatively for the fifth time. **All three
   favour the longer segment**, and none of them goes through the player's latency target.
3. ⚠️ **The 720p latency result still stands only at 720p**, and is now unlikely ever to be extended.
4. ⭐ **The gate paid for itself immediately**, firing on two of four arms in the sitting it was built
   for. A run that would have contributed a wrong number now says so in its own report.
5. ⚠️ **A viewer-facing question is open and untouched by any of this**: B2's fourteen-minute collapse.
   A broadcast that plays perfectly and then loses its buffer for good is worth more attention than a
   tenth of a second of steady-state latency.
