# Three hours: the creep holds, and it accelerates

One live broadcast of 195 min at 720p/2500kbps, 0.5s GOP. **One in-tab arm of 180 minutes** behind a
6-minute warm-up, no gateway arm. **2.477 BZZ.** `~/sittings/drift-3h-2026-08-15`.

#203 and #204 measured the in-tab main thread creeping **+0.034/hr within a session** across
41-minute arms and
could not say whether that holds, decays, or bends. Three hours is 4.4 times the lever arm, and it
contains its own first 41 minutes, so the arm replicates the known result before extending it.

## The answer

The counted arm, twelve wall-clock windows of 15.1 minutes:

    0.224 0.232 0.242 0.252 0.252 0.262 0.272 0.281 0.291 0.301 0.317 0.326

**Monotonic in 11 of 12 steps.** The thread ends the third hour **45% above where it opened**.

| fitted on the 12 window means | | |
| --- | ---: | ---: |
| linear slope | **+0.0357 ± 0.0013 /hr** | t = 26.7, df 10 |
| quadratic term | **+0.00425 ± 0.00117** | t = 3.64, df 9 |

⭐ **It holds and it bends UP.** The slope is **+0.023/hr at the start and +0.048/hr by the third
hour**, roughly doubling. Nothing here decays or plateaus.

⚠️ Fitted on **window means, not the 2,170 raw intervals**. Residual autocorrelation runs +0.34 at 5s
and is still +0.11 at 600s, so a naive interval-level standard error is far too small. The window fit
is the conservative one and it is the one quoted.

### The arm replicates #104 inside its own opening

| | slope | estimator |
| --- | ---: | --- |
| #203 arm A, #204 arm A, 41 min | +0.034 /hr | q50 per window, fitted on windows |
| **this arm's own first 40.9 minutes** (n=491) | **+0.0362 /hr** | the same |
| ⚠️ #104's published headline | +0.026 /hr | pooled over **three** weeb3 arms |

⛔ **This table read "#104 and #203" and attributed +0.034 to #104, which published +0.026.** They are
not the same estimator over the same arms: #104 pooled three weeb3 arms, #203 and #204 fitted the two
41-minute ones per window. The replicate above is against the window-level family, which is what this
arm uses, and **I have not settled which estimator is right** because #104's raw arms are no longer on
disk. ⚠️ Treat +0.026 and +0.034 as two readings of one effect, not as a contradiction and not as
agreement.

⭐ The extension is therefore read against a baseline the same arm reproduced, not against a different
sitting on a different night.

### And the 7-minute warm-up shows why this needed three hours

Its slope reads **-0.312/hr**, which is noise. `host-load-is-not-the-creep-2026-08-15.md` predicted a
7-minute arm could not resolve a 0.034/hr creep, being about 5x too noisy. It could not.

## The host is excluded, and this section was WRONG about how

> ### ⛔⛔⛔ CORRECTED 2026-08-15, AFTER PUBLICATION
>
> This section originally reported `corr(elapsed, load) = +0.078` and `dU/dLoad = +0.00087 ± 0.00015,
> t = 5.6`, and concluded from the second that "host load *does* move the thread, unlike the estimate
> from short arms". **Every one of those three numbers is an interval-level statistic, and this
> document rejects interval-level standard errors thirty lines above, in its own words, for its own
> headline.** I applied a rule to the result I wanted to defend and not to the result I wanted to
> report.
>
> Refitted on the same 12 window means the headline uses:

| | on 12 window means | as first published |
| --- | ---: | ---: |
| corr(elapsed, host load) | **+0.447** | +0.078 |
| slope, unconditional | **+0.0359 ± 0.0013** /hr | +0.0360 ± 0.0006 |
| slope, conditioned on load | **+0.0364 ± 0.0015** /hr | +0.0358 ± 0.0006 |
| `dU/dLoad` | **−0.00127 ± 0.00165**, t = **−0.77** | +0.00087 ± 0.00015, t = 5.6 |

**The conclusion survives and its argument is now the opposite one.**

⛔ **Load trends with elapsed time more than I said.** +0.447 across the windows, not +0.078. On 12
points that is not significant (the 5% critical value is 0.576), but it is not the flat line the
original text described, and it is the number a confounder would have to work through.

⭐ **It cannot be the creep anyway, because conditioning on load makes the slope go UP.** +0.0359
unconditional to +0.0364 conditioned, a move of **+1.4%**. A confounder carrying the trend would take
the slope down when removed. This one does not.

⭐⭐ **And `dU/dLoad` is indistinguishable from zero with the wrong sign for the story**, t = −0.77 on
9 degrees of freedom. ⛔ **So the sentence "host load does move the thread, unlike the estimate from
short arms" is withdrawn.** It never disagreed with `host-load-is-not-the-creep-2026-08-15.md`, whose
8-arm estimate is +0.00000 ± 0.00036 over a far wider load range. **The two agree, and I published a
disagreement that existed only in a standard error I had already declared unusable.**

⚠️ The load range inside this arm is narrow, **7.48 to 10.36**, so this arm alone cannot bound the
sensitivity well. The 4.7-to-56.1 range in the 8-arm study is what bounds it. What this arm shows is
that load did not act as a confounder *here*.

## ⛔⛔ THE MECHANISM I THOUGHT I HAD, AND DID NOT

`heapFloor`, the post-collection baseline of the JS heap, grew **7.4 MB to 31.8 MB** across the arm.
Against the thread series that correlates at **+0.942**, and growing retained memory driving more
collection would explain a creep sitting in the median rather than the tail, which is exactly the
shape #203 found.

⛔ **Both series rise monotonically in time, so they must correlate.** Partialling out elapsed time:

| | |
| --- | ---: |
| raw corr(thread, heapFloor) | +0.942 |
| **partial corr, controlling for elapsed** | **-0.343** |

At df 9 that needs about 0.602 to mean anything. **It does not survive, and it is the wrong sign.**
The heap grows and the thread grows, and this arm cannot say one drives the other.

⭐ Third claim of mine killed this way in two days, after "the tail is invariant to bitrate" and "the
crest factor is compressing". **Any two quantities that both trend in time correlate. Partial out the
trend before believing it.**

## What a viewer actually got

| | |
| --- | ---: |
| stalls | **0** |
| rebuffers | 16 over 3 hours |
| behind live at the end | 2.33s |
| delivered frame rate | 30.0, both arms |
| thread mean / peak | 0.271 / 0.555 of one thread |
| container CPU | 1.92 cores mean, 3.81 peak |

⭐ **Zero stalls across three hours** while the thread grew 45%. The creep is a cost, not yet a
failure, at this profile.

## ⛔ What this does NOT say

**It does not extrapolate.** The measured range is 0 to 3 hours. A quadratic fitted over three hours
says nothing reliable about six, and the last time a curve was extended past its data here it was
wrong by 2x: `1080p-main-thread-2026-08-15.md` predicted a peak of 1.38 of one thread and measured
0.707. Whether the acceleration continues, saturates, or reverses is unmeasured.

**It does not name a cause.** The creep is real, replicated, monotonic, accelerating, and not the
host. Heap growth was the obvious candidate and this arm does not support it.

## ⚠️ And the reader refused this sitting at first, wrongly

`table` returned non-zero because the sampler recorded a stop reason: the browser container was torn
down at the end of the arm, which races the stop file. The arm had covered 10863s of a 10800s window.
The gate has been corrected so coverage decides and the reason is only printed alongside, and the
argument for that change is written to stand without this arm's data.
