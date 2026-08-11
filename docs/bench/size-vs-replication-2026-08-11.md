# #71: it is not size, it is whose content it is

**2026-08-11.** Two headless runs, one weeb-3 node at 177-181 peers, references fetched **one at a
time, alternating between arms**, so adjacent fetches differ only in which corpus they came from.
Order is flipped between rounds so position cannot stand in for arm.

## The result

| arm | what it is | delivered | mean KB | mean KB/s |
| --- | --- | ---: | ---: | ---: |
| **his** | abel-1 segments, a stream people watch | **10/10** | 4,242 | **1,264** |
| **ours-aug03** | GOP sweep of 2026-08-03, uploaded once, read rarely | **2/10** | 3,409 | 459 |
| **ours-today** | latbench recording, read successfully this morning | **4/4** | 95 | 96 |
| **canary** | ours, 2026-08-03, **225 KB** | **0/5** | - | - |

Failures are `503` after **10-14 seconds**, not the 11-100ms fast refusal seen when a node is sick.
The node tried and gave up.

## ⛔⛔ SIZE DOES NOT PREDICT DELIVERY. THE CORPUS DOES.

- His **4.2 MB** delivers 10/10.
- Ours at **3.4 MB** delivers 2/10.
- Ours at **90 KB** delivers 4/4.
- Ours at **225 KB**, from the August 3 batch, delivers **0/5**.

A 225 KB miss and a 4.2 MB hit in the same minute on the same node cannot be a size effect. What
separates the arms is **which upload the reference belongs to**, and how recently anything read it.

## ⛔ Ruled out: postage

Checked on the uploader while the runs were going, all three batches `usable=true`:

| batch | TTL | depth |
| --- | ---: | ---: |
| `46ad34548e54` | 6.7 days | 22 |
| `7849851f4042` | 24.1 days | 24 |
| `b4b44086b77c` | **0.7 days** | 23 |

The chunks are still paid for. ⚠️ `b4b44086b77c` expires within a day, which is worth knowing
separately, but nothing here is explained by an expired batch.

## ⛔⛔⛔ WHAT THIS DOES TO "BIGGER FRAGMENTS ARE WORSE"

That finding compared sizes **within** the August 3 corpus, so it was fair on age at the time. But it
was measuring a corpus that was already decaying, and today the same corpus fails at **225 KB** as
readily as at 3.4 MB. So the size ordering it found is not a property of size in general:

⭐⭐ **A large object needs every one of its ~1,000 chunks to still exist; a 23-chunk object needs 23.**
On decaying content that is a probability, not a bandwidth limit, and it produces exactly the "small
fine, large fails" shape while having nothing to do with throughput. On healthy content it vanishes,
which is why his 4.2 MB segments deliver 10/10.

⚠️ Stated as the reading that fits, not as a mechanism established here. n is small and no per-chunk
measurement was taken.

## ⛔⛔ WHAT IT DOES TO EVERY IN-BROWSER THROUGHPUT FIGURE

The concurrency sweeps fetched **our** references. If a fraction of any reference's chunks must be
retrieved from further away, or cannot be retrieved at all, then those sittings measured **our
content's health as much as the node's capability**. The `410-467 KB/s at c16` curve, the `235 KB/s`
c4 point, and everything derived from them are re-scoped again: they are what this node achieves **on
our content**, which is not what it achieves on content anybody watches.

⭐ The same-day evidence for that gap is stark: **1,264 KB/s on his, 459 KB/s on the one of ours that
arrived at all.**

## ⚠️ The canary was made of our own content, and that is a harness defect

Every fragment sitting discarded rounds whose canary missed, treating that as node sickness. In these
runs the canary failed **0/5 while his arm delivered 4.2 MB at 1,374 KB/s in the same rounds**. A sick
node cannot do that. The canary conflates "the node is unwell" with "our content is gone", and
whichever it is, discarding the round throws away the evidence that would tell them apart.

⭐ **A health canary must be content the harness knows is healthy**, which now means a reference from
a stream someone is actually watching, or a freshly uploaded one.

## What is still open

- **The mechanism.** Reserve eviction of unread chunks, incomplete initial distribution, and slow
  decay are all consistent with this. Nothing here separates them.
- **When ours became unretrievable.** On 2026-08-10 some August 3 references still arrived. Today
  most do not. That is a decay curve nobody has measured.
- ⭐ **Whether reading content keeps it alive.** `ours-today` was read this morning and delivers 4/4.
  That is one observation and an obvious confound with its size, but it points at the question that
  matters most for a product: **does a recording nobody watches stop being retrievable while its
  postage is still paid?**
