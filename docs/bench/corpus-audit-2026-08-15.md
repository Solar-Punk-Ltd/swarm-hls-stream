# What a fan-out audit of the whole corpus found

**2026-08-15, free. No broadcast, no BZZ.** Fourteen agents over the 147 tracked finding documents
and the 119 raw data files behind them, five lenses, each finding then handed to a separate agent
told to refute it.

**28 candidate defects. 9 killed by the skeptics. 19 confirmed and all 19 fixed.**

## The lenses, and what each was worth

| lens | asked | confirmed |
| --- | --- | ---: |
| **arithmetic** | recompute the headline from the raw file it points at | 1 |
| **statistics** | is the conclusion supported at the strength claimed | 4 |
| **contradiction** | two documents that cannot both be right | 3 |
| **retraction leakage** | a withdrawn number still asserted as live somewhere else | 6 |
| **memory fidelity** | does the summary a future session loads match its source | 5 |

⭐⭐⭐ **Retraction leakage was the highest-yield lens by a distance, and it is the one this project
was already trying to defend against.** Every withdrawal in this corpus was written correctly, in the
document that did the withdrawing. **Not one of them propagated to the documents that quoted the dead
number.** Six live claims were resting on figures this project had itself refuted, days earlier, in
writing.

⭐⭐ **The second-highest was memory fidelity**, which had never been checked at all.

## The two that could have cost something

**`deploy/README.md` told an operator that a GOP below 0.5s loses 18-21% of live-edge reads**, and
that roughly one segment in five is unretrievable. That was withdrawn on 2026-08-12 by a replicate on
the same rig which gave 2.9%, 13.1% and 0.0%, and found all 19 refusals retrievable again within
140ms. **The README linked the very document whose first line is the withdrawal**, and was last
edited hours before it landed. The recommendation was right the whole time. The reason given for it
was dead.

**`docs/scale/running-a-high-scale-event-on-swarm.md` told another repository that a 0.25s GOP
ships**, and derived from it the 267ms segment budget that every over-budget share in that document
is scored against, at nine sites. What ships is 0.5s and a **500ms** budget. A simulation built from
that handover would have set its pass threshold at roughly half the real one.

⭐ The correction there is a direction rather than a rescale: 267ms is *stricter*, so every share in
the document is an upper bound and no conclusion becomes more optimistic. **An over-budget share is a
count against a threshold and does not convert**, so rewriting the tables would have been inventing
data.

## The three the corpus found in its own newest work

**A three-hour result published the day before quoted three interval-level standard errors thirty
lines after rejecting interval-level standard errors.** Its headline was fitted on 12 window means
because residual autocorrelation makes the naive error far too small, and it says so in bold. Its
host-load section then quoted the naive errors and drew an inference from a t of 5.6. Refitted on the
same windows, `dU/dLoad` is **-0.00127 ± 0.00165, t = -0.77**, and the correlation it reported as
+0.078 is **+0.447**.

⭐ **The conclusion held and its argument inverted.** Load trends with time more than the document
said, and still cannot be the creep, because conditioning on load moves the slope **up** 1.4%. A
confounder carrying a trend lowers the slope when removed.

**A sitting's per-minute BZZ rates divided a 320s chequebook delta by a 240s playback window**,
inflating every rate 1.34x. The two sittings compared inflate by different factors, 1.34x and 1.23x,
so the cross-sitting ratio was distorted rather than shifted. The in-tab excess at a tighter target
is **1.62x, not the published 1.9x**.

**Two documents miscounted their own arms**, in one case claiming fourteen from sources holding
eleven, in the other reporting 4 and 4 where the sources say 6 and 2, wrong in opposite directions.
One of those rows rests on n=1 per condition.

## The one that had no document at all

A paid overnight sitting from 2026-08-10 existed **only in a memory file**. The audit found it
because the memory cited no source. Its raw log survived, so it is now written up in
`golden-zone-2026-08-10.md`, and **re-reading it changed the finding**:

- an exact permutation test over all 252 arrangements says its two smaller profiles are **not
  separated**, p = 0.47, and that contrast was the sole evidence for the lesson the sitting was
  remembered for
- the statistic it told readers to distrust, the median, separates all three profiles cleanly
- its headline "size in bytes orders the result, not duration" is **not a result of the design**,
  which moves bytes together with duration or resolution in every significant contrast
- its cross-instrument corroboration had been withdrawn as corpus decay

⛔ **A result that lives only in a summary has never been checked**, because there is nothing to check
it against.

## ⭐⭐⭐ What generalises

1. **A withdrawal is not a correction until it reaches every document that cited the number.** This
   corpus writes excellent withdrawals and does not propagate them. That is now the most likely place
   to find a live error in it.
2. **Rigour applied only where you expect to be challenged is anticipation, not rigour.** The
   three-hour document hardened the number it expected to defend and took whatever the fit printed
   for the number it expected to be believed.
3. **A claim with no document behind it is not a weak claim, it is an unchecked one.** Writing up the
   golden-zone sitting five days late overturned three of its four headlines, and nothing about the
   data had changed.
4. **Prefer the test whose direction answers the question over the test whose p-value does.** What
   saved the drift conclusion was that conditioning moved the slope the wrong way for a confounder,
   which needs no standard error at all.
5. **Nine of 28 candidates were killed by an agent told to refute them.** A finding that has not
   survived someone trying to destroy it is a candidate, not a finding.

⚠️ **What this audit did not do.** It did not re-run anything, so a defect that only shows up on the
wire is invisible to it. It read 147 documents and recomputed from 119 data files. Sittings whose raw
artefacts have left the host cannot be checked at all, and one of them, `long-arm-drift-2026-08-14`,
is why an estimator disagreement in the drift document is recorded as unresolved rather than settled.
