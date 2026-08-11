# ⛔⛔⛔ "Bigger fragments are worse to deliver" is dead. It was decay all along.

**2026-08-11.** Four fragment lengths broadcast within hours of each other, so every arm is content of
known health and age is held constant across sizes. One weeb-3 node at 191 peers, one fetch at a time,
arm order rotated between rounds. Control is abel-1. Rows in `size-on-healthy-content-rows-2026-08-11.json`.

| arm | segment | **delivered** | mean KB/s |
| --- | ---: | ---: | ---: |
| `his` abel-1 | 4,262 KB | **8/8** | 967 |
| ours, fragment 0.5 | 407 KB | **8/8** | 244 |
| ours, fragment 1.0 | 801 KB | **8/8** | 335 |
| ours, fragment 2.0 | 1,683 KB | **8/8** | 593 |
| **ours, fragment 4.0** | **3,361 KB** | **8/8** | **1,007** |

**40 fetches, 40 delivered, not one failure at any size.**

## What this replaces

The fragment-size cliff was recorded as **≤500 KB 20/20, 1.3 MB 3/5, 3.5 MB 0/5**, replicated, always
as a within-round contrast. It looked airtight. Every one of those rounds fetched references from the
2026-08-03 corpus, and that corpus is now known to have been decaying
(`fresh-vs-decayed-2026-08-11.md`).

⭐⭐ **The mechanism is arithmetic, and it was proposed in the decay write-up before this test ran.** A
3.4 MB object needs all ~820 of its chunks to still exist. A 400 KB object needs ~100. On a corpus
losing chunks, that difference alone produces "small fine, large fails" with **no bandwidth effect of
any kind**. Give the same node the same sizes in fresh content and the ordering does not weaken, it
**vanishes**.

## ⭐⭐⭐ AND THE ORDERING INVERTS: BIGGER IS STRICTLY BETTER

Throughput rises monotonically with segment size, **4.1x from end to end**, at identical delivery.
Per-request overhead amortises and a larger segment fills more of the chunk semaphore that binds:

| segment | chunks | occupancy at one fetch | KB/s |
| ---: | ---: | ---: | ---: |
| 407 KB | 102 | 5.0% | 244 |
| 801 KB | 200 | 9.8% | 335 |
| 1,683 KB | 421 | 20.5% | 593 |
| 3,361 KB | 840 | **41.0%** | **1,007** |
| 4,262 KB | 1,066 | 52.0% | 967 |

⭐ It flattens above ~40%: 3.4 MB and 4.3 MB are within 4% of each other. **The gain is real up to
about 3 MB and then stops**, which is a usable design rule rather than an open-ended "bigger is better".

## ⭐⭐ OUR CONTENT NOW PERFORMS LIKE HIS

Our 3.4 MB arm returns **1,007 KB/s** against his 4.3 MB arm's **967**. Fresh content of ours is not
merely retrievable, it is as fast as a stream people watch. Nothing about our upload path is
disadvantaged, which closes the question #71 opened for good.

## What it costs to choose

Longer fragments raise the latency floor a viewer waits through, one segment at a time. The trade is
now quantified rather than guessed: going from 0.5s to 4.0s segments buys **4.1x the retrieval
throughput** and costs **3.5s of additional startup and live latency**. That is a product decision, and
it is the owner's.

⚠️ Both arms of this comparison were measured at **concurrency 1**. A player fetches four segments at
once, so the absolute figures are not a player's, though the ordering between sizes should hold.
