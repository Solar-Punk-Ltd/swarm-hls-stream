# Validating the fragment #155 shipped, which had never been measured

**2026-08-12, free.** Five arms on the local segment-duration probe, own container, own ports, no bee
and no postage. Predictions registered before the run.

`gop-vs-fragment-2026-08-12` established `segment = ceil(fragment / GOP) * GOP` over 20 arms at
fragments **0.25, 1.0 and 2.0**. #155 then shipped **0.5**, a value that sweep never tested. This
checks the shipped pair against a running SRS rather than against the rule.

| fragment | GOP | aof | ceiling | predicted | settled at | verdict |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| **0.5** | **0.5** | 10 | 5.00s | **0.500** | **0.500** | ✅ **the shipped pair** |
| 0.5 | 1.0 | 10 | 5.00s | 1.000 | 1.000 | ✅ |
| 0.5 | 2.0 | 10 | 5.00s | 2.000 | 2.000 | ✅ |
| 0.5 | 2.0 | **4.2** | **2.10s** | 2.000 | **2.117** | ⛔ **differs, see below** |
| 0.5 | 3.0 | 4.2 | 2.10s | ~2.100 | 2.117 | ✅ force-closed as predicted |

✅ **The shipped pair produces exactly what #155 claimed.** The rule holds at a fragment it was never
fitted on.

## ⭐⭐ The overshoot, which no previous sweep could see

Every arm's segments **overshoot the settled value and ramp back down to it**, then reset. Reading
raw `#EXTINF` values instead of a median makes it obvious:

```
GOP 0.5:  0.583 0.571 0.559 0.547 0.535 0.523 0.511 0.500 0.500 0.500  0.633 0.621 ...
```

| GOP | settles at | peaks at | overshoot |
| ---: | ---: | ---: | ---: |
| 0.5 | 0.500 | 0.636 | **+0.136s** |
| 1.0 | 1.000 | 1.136 | **+0.136s** |
| 2.0 | 2.000 | 2.133 | **+0.133s** |

⭐⭐⭐ **The overshoot is a constant ~0.135s, not a proportion of the GOP.** Every sweep before this
one reported medians, and the median sits at the settled value, so this was invisible.

## ⛔ The consequence, and it is about a number I shipped

**A ceiling has to clear `GOP + 0.135s`, not `GOP`.**

| GOP | needs a ceiling of | shipped 2.1s |
| ---: | ---: | --- |
| 0.5 | 0.635s | fine |
| 1.0 | 1.135s | fine |
| **2.0** | **2.135s** | ⛔ **35 ms short** |

That is the fourth arm above. At `aof 10` a 2.0s GOP settles cleanly on 2.000. At the shipped
`aof 4.2` the ceiling is 2.1, the natural overshoot crosses it, and SRS force-closes: the mode moves
to **2.117** and the spread opens to **1.861-2.219**.

⚠️ **This is pre-existing and #155 did not introduce it.** The old config was `fragment 1.0 * aof 2.1`,
which is the **same 2.1s ceiling**. #155 held the product constant on purpose, and it held this with
it. What is new is that the ceiling has now been measured against the overshoot rather than against
the GOP alone.

⛔ **It matters because 2.0s is the common broadcaster default**, including OBS's, so it is the GOP
most likely to arrive uninvited.

## ⭐⭐⭐ What force-closing actually does, observed directly

The fifth arm puts a 3.0s GOP against the 2.1s ceiling, and the result is not one bad number. It is
an **alternating pattern**:

```
2.115 + 0.906 = 3.021
2.117 + 0.982 = 3.099
2.117 + 0.910 = 3.027
...  14 pairs, mean sum 3.060, stdev 0.044
```

**Each pair sums to the GOP.** SRS force-closes at the ceiling with no keyframe in hand, then the next
segment runs only until the real keyframe arrives. So **every other segment is the tail of a GOP**,
and the one after a force-close cannot begin on a keyframe.

⚠️ The keyframe itself is not measured here, only the durations. The pairing and the sums are the
evidence, and they match the documented behaviour exactly.

## The fix

`HLS_AOF_RATIO` 4.2 → **5.0**, so at the shipped 0.5s fragment the ceiling becomes **2.5s**. That
clears a 2.0s GOP plus its overshoot with margin, and it is the ceiling `latbench` has been running
all along (0.25 * 10), so it is not a new operating point.

**Strictly more permissive than either the old or the current value**, so no broadcaster's GOP leaves
the range: [1.0, 2.1] before #155, [0.5, 2.1] after it, **[0.5, 2.5]** now.
