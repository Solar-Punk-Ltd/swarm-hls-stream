# The neighbours cannot account for the creep, and the arms that found it were barely long enough

No broadcast, no BZZ. Every number here comes from the eight arms of
`1080p-main-thread-2026-08-15.md` and the published window medians of
`thread-scaling-shape-2026-08-15.md`.

Written because #106 is **one** three-hour in-tab arm, and a single long arm on this box invites an
obvious objection: forty neighbour bee nodes share the host, so a thread that rises over three hours
could be the session ageing or it could be the neighbours waking up. Those are the same column.

The sampler has been writing `/proc/loadavg` beside every arm since #28, thirty seconds apart. The
objection was answerable from files already held. Nobody had asked, because nothing joined the two
series.

## What the join costs, and why it had never been done

The two files do not share a clock. `*-mainthread.jsonl` carries CDP's `Timestamp`, which is the
host's monotonic clock, and `sample-NNNN.json` carries `atMs`, which is epoch. On this host they are
about 234 million seconds apart.

⛔⛔⛔ **A reader that joins on the raw numbers pairs every thread reading with the same one sample
and reports a sensitivity of exactly zero.** Zero is also what a healthy host reports. The defect and
the finding are the same output, which is why the test for this plants a sensitivity and makes load
zig-zag rather than drift: a join one sampling interval out returns the planted slope with its sign
reversed, and that is a failure no summary would show.

## The bound

`read-sitting.py load <dir> [creep]`, six counted arms, each demeaned before pooling so no
between-arm difference survives.

| arm | n | load range | corr(t, load) | dU/dLoad | ± se |
| --- | ---: | ---: | ---: | ---: | ---: |
| arm03 gateway | 85 | 6.9-22.1 | -0.027 | +0.00001 | 0.00034 |
| arm04 weeb3 | 84 | 7.7-56.1 | -0.573 | +0.00003 | 0.00047 |
| arm05 weeb3 | 85 | 5.9-34.6 | +0.777 | -0.00001 | 0.00065 |
| arm06 gateway | 84 | 6.1-18.2 | -0.888 | +0.00079 | 0.00032 |
| arm07 weeb3 | 84 | 5.9-25.3 | +0.501 | -0.00010 | 0.00108 |
| arm08 gateway | 85 | 4.7-12.5 | +0.522 | +0.00029 | 0.00091 |

| condition | dU/dLoad | t | upper bound at 2 se |
| --- | ---: | ---: | ---: |
| in-tab (weeb3) | +0.00000 ± 0.00036 | +0.01 | 0.00073 |
| gateway | +0.00029 ± 0.00025 | +1.15 | 0.00080 |

⭐ **Neither is distinguishable from zero, across a load range of 4.7 to 56.1 on a 48-core box.**

The number that matters for #106: to manufacture the **+0.034 cores/hr** in-tab creep, host load would
have to rise **47 units every hour, monotonically, even at the two-standard-error upper bound**. Over
three hours that is a load climbing from five to roughly a hundred and fifty and never falling back.
That does not happen here, and the three-hour arm carries its own 360-sample load series, so it can be
checked directly rather than assumed.

### ⚠️ The point estimate is not robust, the bound is

A first pass took the clock offset from `/proc/uptime` instead of centring the two windows. That moves
the join by about ten seconds and moves the in-tab estimate from +0.00000 to +0.00031. Both are noise
around zero, and the upper bound only moves from 0.00073 to 0.00103, so the conclusion holds either
way. **A slope that flips on a ten-second shift of a sixty-second average is not measuring anything**,
which is the same thing the t values say. Quote the bound, never the point estimate.

### ⚠️ And a short arm cannot separate load from time at all

The `corr(t, load)` column runs from -0.888 to +0.777. Inside seven minutes, host load and elapsed time
are strongly correlated by accident, in whichever direction the neighbours happened to move. That is
not a defect in the arms, it is what seven minutes buys. A three-hour arm, where load fluctuates on a
scale of minutes, is the first one where the two are separable within a single arm.

## The uncomfortable half: the creep rests on less than it looked like

The same files price the evidence that prompted #106. Fitting a slope to the six published window
medians of each 41-minute arm, with the standard error taken from the residual scatter about that
line, four degrees of freedom:

| arm | slope /hr | ± se | t |
| --- | ---: | ---: | ---: |
| weeb3 A | +0.0341 | 0.0078 | 4.35 |
| weeb3 B | +0.0359 | 0.0083 | 4.32 |
| gateway A | +0.0509 | 0.0023 | 22.15 |
| gateway B | +0.0452 | 0.0032 | 14.23 |

⛔ **The in-tab creep is t ≈ 4.3 on four degrees of freedom, which is p ≈ 0.012 per arm.** It is
replicated, both arms agree on sign and magnitude, and it is monotonic in both. That is a real effect
and it is also a good deal thinner than "measured, replicated" reads.

⚠️ The two arms are not independent enough to multiply. They ran in the same sitting on the same host
against the same broadcast, so combining them into a single t of 6.1 would claim an independence they
do not have. Read it as two agreeing observations at p ≈ 0.012, not as one at p ≈ 1e-9.

⭐ The gateway creep is a different matter entirely, at t = 22 and t = 14. Whatever it is, it is not
marginal, and it is **larger** than the in-tab one. That asymmetry is still unexplained.

## What this settles about #106

Both halves point the same way, and neither was worth a broadcast to learn.

1. **The confound is closed in advance.** The neighbours would need an impossible load ramp to produce
   the effect, and the arm will record the load anyway.
2. **The purchase is justified more precisely than it was.** A 41-minute arm resolves the slope to
   about ±0.008/hr. Three hours is 4.4 times the lever arm, and a slope's standard error falls faster
   than the window grows, so the same question is answered several times over. More usefully, three
   hours contains its own first 41 minutes, so the arm **replicates the known result and tests the
   extension against it inside one broadcast**.

⚠️ What this does not do is predict the three-hour arm's error bar. That needs the autocorrelation of
the interval series at lags of minutes, and seven-minute arms cannot measure it. A figure of the form
"the creep will be resolved at N standard errors" was computed during this work and is **withheld**
for exactly that reason.
