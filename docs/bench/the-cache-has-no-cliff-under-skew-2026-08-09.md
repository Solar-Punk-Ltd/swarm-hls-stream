# Under a skewed pattern the cache has no cliff at all, and "size for the hot set" was wrong

**2026-08-09, 05:56 to 06:55 UTC.** Twenty-two arms on an unfunded gateway, bisecting `--cache-capacity`
below the one capacity a skewed pattern had ever been tested at. Two rounds. **Cost: nothing**, and
`availableBalance` was byte-identical before and after.

[The access-pattern sitting](the-cache-cliff-belongs-to-the-access-pattern-2026-08-09.md), earlier the
same day, found that the cliff belongs to the access pattern and concluded **"size for the hot set, not
the working set"**. That conclusion rested on a single capacity, 8,000 chunks, which is **3.8x** the
2,096-chunk hot set. This tests below it, and the rule does not survive.

## ⭐⭐ There is no step anywhere, and none at the hot set

Retrieval operations off bee's own counter, each capacity against its own cache-off arm on the same
pattern:

| capacity  | × hot set | % of working set | removed, r1 / r2  | share of what a full cache achieves |
| --------: | --------: | ---------------: | ----------------: | ----------------------------------: |
|       500 |     0.24x |             4.8% |   **4.1 / 4.5%**  |                            9 / 10%  |
|     1,000 |     0.48x |             9.5% |   **8.2 / 8.1%**  |                           18 / 17%  |
| **2,100** | **1.00x** |        **20.0%** | **17.7 / 17.5%**  |                       **38 / 38%**  |
|     3,200 |     1.53x |            30.5% |  **22.1 / 21.8%** |                           47 / 47%  |
|     5,000 |     2.39x |            47.7% |  **28.7 / 29.2%** |                           62 / 63%  |
|     8,000 |     3.82x |            76.3% |  **36.8 / 36.8%** |                           79 / 79%  |

⭐⭐ **A smooth concave curve with no discontinuity anywhere, and both rounds agree to within 0.5
percentage points at every capacity.**

⛔⛔ **There is no step at the hot set.** At exactly 1.00x the hot set a cache collects **38%** of what a
full one collects, not all of it, and it keeps buying steadily past that. **The hot set is a scale, not
a threshold**, and the rule published earlier today has to go.

⭐ The median transfer moves the same way, monotonically: 99 / 103ms at 500 chunks, then 85 / 88, 71 /
81, 74 / 66, 74 / 59, against 93 to 111ms with the cache off.

## ⭐⭐ What replaces it: read a capacity off the value curve

⭐ **Early capacity is worth about twice its share.** 4.8% of the working set buys 9 to 10% of the
achievable benefit, 9.5% buys 17 to 18%, and 20% buys 38%. The premium decays as capacity grows and is
gone by 76%, where the share bought and the share held are both about 79%.

That is exactly what an 80/20 distribution should do, and it is **the first graceful cache behaviour
this project has measured.**

⛔ **So there is no threshold to clear and no capacity that is "wasted".** Under a realistic pattern a
cache is a dial, and the only question is where on the curve the deployment wants to sit. For DVR, where
a re-watchable hour is ~353,000 chunks, **5% of that buys a tenth of the benefit and 20% buys nearly
four tenths**, which is a very different procurement conversation from "clear the working set or get
nothing".

⚠️ **What stays true is the cyclic result.** At any capacity below 100% a cyclic scan still collects
exactly nothing, reproduced twice. **Every cliff this project has measured belongs to that pattern**, and
a workload that reads a catalogue uniformly, which a seek-everywhere VOD audience can resemble, still
gets the step.

## ⛔ On correcting the same claim twice in one day

The morning's sitting was right that the cliff belongs to the pattern and wrong about what replaces it,
because it measured one capacity and named a threshold. **The hot set was the obvious candidate for a new
cliff, the arithmetic was tidy, and nothing had tested it.**

⭐ The habit that caught it is the one that has caught every other error here: **go back and measure your
own default against the measurement that justified it.** The prediction going in was a step at 2,096
chunks. There is no step at 2,096 chunks.

## ⚠️ What this does not show

⚠️ **80/20 is a chosen shape.** No real audience's popularity distribution has been observed here, so the
curve's exact heights are a property of this skew. What generalises is that skew removes the
discontinuity.

⚠️ **One viewer, flat out, unfunded, 400 references, two passes, two rounds.** The hot set is 80
references and the pool is 400, and both were held fixed while only capacity moved.

⚠️ **The "share of what a full cache achieves" column divides by 46.5%**, which is the ceiling measured
at 100.1% capacity under a cyclic scan, because lap one must miss whatever the pattern is. It is an
empirical denominator, not a derived one.

⚠️ **Nothing between 5,000 and 8,000 was run**, and nothing below 500.

## Artifacts

`/home/solarpunk/retrieval-probe/HOTSET1/`. Probe:
[`deploy/scripts/retrieval-debt-probe.sh`](../../deploy/scripts/retrieval-debt-probe.sh), capacity is the
4th arm field and the pattern is the 9th. Sequences:
[`deploy/scripts/make-access-pattern-refs.sh`](../../deploy/scripts/make-access-pattern-refs.sh).

Gateway restored to `--swap-enable=true` and `--cache-capacity=0` and confirmed on the node.
