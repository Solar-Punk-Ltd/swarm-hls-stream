# The feed head lookup costs seconds, and more of them the longer the feed is

**2026-08-04. Four feeds of different lengths, one writer, one node, one stamp, read round-robin at
rest. No video. Probe: [`feed-head-scaling.mjs`](../../e2e/src/probes/feed-head-scaling.mjs), raw
figures in `feed-head-scaling.json`.**

| slots written |    min | **head median** |    p95 |    max | **same chunk by address** | failures |
| ------------: | -----: | --------------: | -----: | -----: | ------------------------: | -------: |
|             1 |  896ms |      **1008ms** | 2395ms | 2427ms |                   **4ms** |        0 |
|            10 | 1731ms |      **2008ms** | 2031ms | 2052ms |                   **4ms** |        0 |
|           100 | 3164ms |      **4011ms** | 4536ms | 4771ms |                   **4ms** |        0 |
|          1000 | 4366ms |      **5011ms** | 5017ms | 5043ms |                   **4ms** |        0 |

30 rounds each, interleaved so that drift lands on every arm equally. Every feed was idle by the time
it was read, which is the catalog's condition rather than a live broadcast's.

## What it says

**The explicit-address read is flat.** 4ms median and 11ms worst at every length, which is the control
doing its job: one request for a known chunk cannot scale with anything, and it does not. At 1000
slots the two paths differ by **1250x** for the same chunk on the same node.

**The lookup has a floor of a second.** Not a slope, a floor. The shortest feed that can exist, one
single slot, still costs **1008ms** against 4ms by address. Feed length makes it worse, but no feed is
ever cheap.

**Above that it grows with the logarithm of the length**, about 0.4s per doubling, which is consistent
with an exponential probe followed by a binary search. That is the merciful shape: 10,000 slots
extrapolates to roughly 6s rather than to 50.

**The medians are whole seconds.** 1008, 2008, 4011, 5011, each within 11ms of an exact second across
30 rounds. Network variance does not look like that. Something in the lookup waits in whole seconds,
so the cost is a count of timeouts rather than a quantity of work, and a probe for a slot that does
not exist is what is being counted.

## What it costs the product

**The catalog is on this path and grows forever.**
[`App.tsx:67`](../../packages/client/src/providers/App.tsx) resolves
`/feeds/{appOwner}/{rawAppTopic}` and
[`StreamBrowser.tsx`](../../packages/client/src/pages/StreamBrowser/StreamBrowser.tsx) polls it
through SWR on `refreshInterval: 5000`. The feed gains a slot per broadcast lifecycle event and is
never reset, so a deployment that has run a thousand broadcasts pays **5 seconds per poll against a 5
second poll interval**. The catalog is then never not in flight.

**Every thumbnail pays it again.**
[`StreamPreview.tsx:60`](../../packages/client/src/components/StreamPreview/StreamPreview.tsx) makes
one head lookup per card, and the queue around it runs at concurrency 1. Ten cards is ten lookups end
to end: **20 seconds on a young deployment, 50 on a thousand-slot one**, before the last thumbnail
appears.

**The player is fine and stays fine.** It resolves the head once on mount and then walks slot
addresses at 4ms, which is what `f1bfc7c` moved the bench onto and what
[`nextFeedRequest`](../../packages/shared/src/feedFollow.ts) now guarantees for both.

## What it explains, and what it does not

It accounts for the old bench's behaviour exactly. That run completed **133 polls in 10 minutes**,
which is 4.5s per poll, and this table says 4 to 5 seconds at a feed of one to several hundred slots.
Its longest stall was **37.22s across 8 polls**, which is eight consecutive lookups at that cost, and
the **19-slot index jump** is how far a 2.0s-GOP broadcast advances in 37 seconds. So the freeze was
never a throttle releasing in bursts. It was one slow call, repeated.

**It does not settle the 63 second period** that earlier work reported, nor whether funding the
gateway helped for the reason claimed. Both were measured through this lookup, and neither is
addressed here.

**It does not measure a feed that is advancing.** Every arm here was idle. A live feed is the harder
case, because the head moves between probes.
