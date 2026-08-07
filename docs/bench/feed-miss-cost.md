# Asking for a feed slot that does not exist costs 4ms, and occasionally 1.4s

**2026-08-05. The prerequisite for taking the catalog off the head lookup, and it could have refuted
that plan. It does not. Probe: [`feed-miss-cost.mjs`](../../e2e/src/probes/feed-miss-cost.mjs), raw
figures in `feed-miss-cost.json`.**

One feed of 20 slots, one writer, one node, one stamp. Four arms read round robin, 30 rounds each.
No video, no broadcast.

| arm                                 |    min | **median** |    p95 |    max | status |
| ----------------------------------- | -----: | ---------: | -----: | -----: | ------ |
| **hit**, the slot a walker has      |  2ms   |    **5ms** |    9ms |  101ms | 200    |
| **miss**, the slot it asks for next |  3ms   |    **4ms** | 1405ms | 1477ms | 404    |
| **farMiss**, 5000 past the end      |  2ms   |    **5ms** | 1547ms | 1558ms | 404    |
| **head**, what the catalog does now | 2560ms | **4012ms** | 5570ms | 5617ms | 200    |

## The question this was built to answer

A walking reader asks for the slot *after* the one it holds. For a live stream that slot almost
always exists, because segments are constant, and the walk is cheap. **For a catalog it almost never
exists**, because broadcasts are rare, so the walk is mostly misses.

If a miss cost the same second that a head probe costs, walking an idle catalog would be no cheaper
than resolving its head and the plan in
[`catalog-off-the-head-lookup.md`](../reviews/catalog-off-the-head-lookup.md) would have been wrong.
The decision rule was written into the probe before it ran.

## The answer: walking wins, by about a thousand times at the median

**A miss costs 4ms.** It returns a real 404 of 62 bytes rather than an error, and it is
indistinguishable in cost from a hit. So the catalog fix is sound as designed: a reader that walks
pays about 4ms per poll where it currently pays 4012ms.

**Even the tail beats the head lookup.** A miss at p95 is 1405ms, still well under the head lookup's
4012ms *median*, and under its 2560ms best case.

## But the tail is real and should not be rounded away

**About one miss in twenty costs ~1.4 seconds.** That is the hardcoded one second timeout in bee's
retrieval showing through, plus network. The distribution is not noisy, it is bimodal: fast almost
always, and a full timeout occasionally.

`farMiss` behaves identically to `miss`, so this is not about being one slot past the end versus five
thousand. Whatever decides fast-404 against timeout-404 is not distance.

**What this means for a polling catalog**: at a 5 second interval, roughly one poll in twenty takes
1.4s instead of 4ms. That is invisible to a user and still 3x better than the current median. It
would matter for anything polling much faster than 5 seconds, and it caps how aggressive a walk can
usefully be.

## What this does not settle

- **Why some misses time out and most do not.** Not chased, because it does not change the decision.
  Worth knowing before anything is built that polls a feed edge at high frequency.
- **The first read.** A reader with no position still needs one head lookup, which nothing here
  avoids. It is once per session rather than once per poll.
- **Anything about a loaded node.** This ran against an idle stack. The 4ms is a floor, not a promise
  under load.
- **Whether the catalog UI improves.** This measures the read path. Browser validation is separately
  blocked, so the last step from "the read is faster" to "the page is better" is not covered here.

## Cost

30 rounds of 4 reads plus 20 feed writes. The postage batch moved from 30 to 33 of 128 buckets across
this and other work in the same window, so under three buckets and closer to one.
