# ✅✅✅ It is decay. Our fresh content delivers 8/8, our eight-day-old content delivers 0/8

**2026-08-11, one weeb-3 node at 179 peers, one fetch at a time, arm order rotated between rounds.**
Instrument `deploy/scripts/corpus-delivery.mjs`, rows in `docs/bench/fresh-vs-decayed-rows-2026-08-11.json`.

| arm | what it is | delivered | mean KB | mean KB/s |
| --- | --- | ---: | ---: | ---: |
| **his** | abel-1, a stream people watch | **8/8** | 4,214 | **1,121** |
| **ours-live-1080p** | broadcast 65 minutes earlier, today | **8/8** | 801 | **348** |
| **ours-aug03** | our GOP-4 sweep of 2026-08-03 | **0/8** | - | - |

The aug03 failures are `503` after **11.0 to 14.9 seconds**. The node tried and gave up. Every other
fetch in the same rounds, on both other arms, returned 200.

## ⭐⭐⭐ This settles the fork #71 opened, and it settles it against my own suspicion

#71 left two live hypotheses and could not separate them.

| | claim | predicted for our fresh content | **measured** |
| --- | --- | ---: | :--- |
| **H1 decay** | content stops being retrievable when nothing reads it | ≥8/10 | **8/8 ✅** |
| **H2 upload path** | our uploads were never distributed well; age is a coincidence | ≤5/10 | **refuted** |

⭐ **Our uploader is fine.** Content it wrote 65 minutes before the test came back every single time,
at 801 KB a fetch, while content it wrote eight days earlier came back never. The two were fetched
alternately, on one node, inside the same four minutes.

⛔ **So the thing to worry about is not how we upload. It is that Swarm stops returning what we
uploaded, while the postage is still paid for it.**

## The decay is still moving

| date | aug03 corpus |
| --- | ---: |
| 2026-08-10 | some references still arrived |
| 2026-08-11, morning | **2/10** |
| 2026-08-11, midday | **0/8** |

Postage on those chunks was `usable: true` throughout, checked on the uploader while the runs ran.

## ⛔⛔ WHAT THIS DOES TO THE THROUGHPUT FIGURES, WHICH IS NOT WHAT I EXPECTED

Every in-browser throughput number this project holds was measured by fetching **our** references, and
the corpus they came from was already decaying. So those sittings measured a mixture of the node's
capability and our content's health.

⭐ **The correction runs the other way from a caveat: they are floors, not ceilings.** A sweep whose
arm silently included unretrievable references was fighting timeouts, so its number understates what
the node can do on healthy content. `410-467 KB/s at concurrency 16` and the `235 KB/s` c4 point
should be read as **at least that, on content of mixed health**.

**This is the first time our own content has ever been measured while it was known healthy**: 348 KB/s
on 787 KB segments at concurrency 1.

## ⭐ Size is ruled out for the second time, on new evidence

The three arms span 801 KB, 4,214 KB and (failing) 3,409 KB. Ours at 801 KB delivers 8/8 while ours at
3,409 KB delivers 0/8, which looks like a size effect until his 4,214 KB arm delivers 8/8 beside it.
Yesterday the same corpus failed 0/5 at **225 KB**. Whatever orders delivery here, it is not size.

## What is still open

- **The mechanism.** Reserve eviction of unread chunks, incomplete initial distribution that decays
  below a retrievable threshold, and neighbourhood churn are all consistent with this. Nothing here
  separates them.
- **The shape of the curve.** Two points eight days apart and one in between is not a curve. ⭐ Today's
  broadcast is a dated cohort that costs nothing to re-test, which is what #74 now runs on.
- **Whether reading keeps content alive.** Untested. It is the difference between a product that needs
  re-upload on a timer and one that needs an audience.
