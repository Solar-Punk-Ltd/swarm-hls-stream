# Upstream report: sequential feed lookup costs a whole second per narrowing step

**Ready to file against [ethersphere/bee](https://github.com/ethersphere/bee). Written to stand alone,
so it repeats context a maintainer would not otherwise have. Measured against `v2.8.1`.**

---

## Summary

`GET /feeds/{owner}/{topic}` costs **one second at minimum and grows with the logarithm of the feed
length**, reaching 5 seconds on a feed of 1000 slots. Reading the same chunk by explicit address costs
**4 milliseconds at every length**.

The cost is not retrieval work. It is a hardcoded one second timeout, spent once per narrowing step,
because the lookup must probe past the end of the feed to find where it ends and a probe for a slot
that was never written can only resolve by timing out.

## Measurement

Four feeds of 1, 10, 100 and 1000 slots, one writer, one node, one postage batch, read round robin so
that any drift lands on every arm equally. All four idle at read time. 30 rounds each. No video and no
other load.

| slots written |    min | **head lookup, median** |    p95 |    max | **same chunk by address** | failures |
| ------------: | -----: | ----------------------: | -----: | -----: | ------------------------: | -------: |
|             1 |  896ms |              **1008ms** | 2395ms | 2427ms |                   **4ms** |        0 |
|            10 | 1731ms |              **2008ms** | 2031ms | 2052ms |                   **4ms** |        0 |
|           100 | 3164ms |              **4011ms** | 4536ms | 4771ms |                   **4ms** |        0 |
|          1000 | 4366ms |              **5011ms** | 5017ms | 5043ms |                   **4ms** |        0 |

Three things stand out.

**The by address control is flat.** One request for a known chunk cannot scale with feed length, and
it does not. At 1000 slots the two paths differ by **1250x for the same chunk on the same node**, so
this is not retrieval, propagation, network or payment.

**There is a floor, not just a slope.** The shortest feed that can exist, a single slot, still costs
**1008ms**. No feed is ever cheap.

**The medians are whole seconds**: 1008, 2008, 4011, 5011, each within 11ms of an exact second across
30 rounds. Network variance does not look like that. The cost is a **count of timeouts** rather than a
quantity of work.

## Where it comes from

`pkg/feeds/sequence/sequence.go`, `v2.8.1`. The lookup is `asyncFinder`, and the second is a literal
with a note already on it:

```go
// TODO: remove hardcoded timeout and define it as constant or inject in the getter.
reqCtx, cancel := context.WithTimeout(ctx, 1*time.Second)
```

Three properties combine to make that timeout the dominant cost rather than a safety bound.

**A probe for a slot that does not exist always spends the whole second.** `get` returns `(nil, nil)`
for a local `ErrNotFound`, which is fast, but a slot that was never written is not locally absent, it
is absent everywhere. The retrieval goes to the network and never resolves, `asyncGet` returns without
sending anything, and the caller falls through to `case <-reqCtx.Done()` and reports not found after a
full second.

**Every round probes past the head by construction.** `at()` launches `DefaultLevels = 8` concurrent
probes at `base + 2^l - 1` for `l = 8..1`, so `base+255, +127, +63, +31, +15, +7, +3, +1`. Finding
where a feed stops means asking for indices beyond it, so at least one probe misses in almost every
round, and the round costs a second however many probes it ran.

**The rounds are sequential.** Each round narrows the interval and launches the next, so the total is
one second per narrowing step.

That predicts the table exactly, including the floor: a one slot feed still runs one full round of
eight probes that all miss, which is **one second to establish that index 0 is the head**.

It also explains an artifact we could not account for before finding this. Reading a live feed showed
index plateaus recurring at gaps of exactly **64 and 128**, which are `2^6` and `2^7`, two of the probe
offsets.

## Why it matters beyond a slow endpoint

For a **live stream**, a feed is the announcement channel. A viewer that resolves the head on every
poll is asking a question that gets slower every time the broadcast advances, which reads as the
stream freezing. Our own measurements showed 50 to 57% of a broadcast appearing frozen, at a 2.7s
mean, purely from reading the feed this way. Reading the same chunks by computed slot address showed
**0% frozen at 46ms**.

The decisive control there is worth repeating, because it rules out everything environmental in one
step: **we ran it against the writer's own node, where every chunk was local.** `/feeds/` was still
52.4% frozen and the explicit address read was still 0%.

For a **catalog or index feed**, which grows one slot per event and is never reset, the endpoint gets
permanently slower. A deployment that has recorded a thousand events pays about 5 seconds per read.

## What we did about it, which is a workaround rather than a fix

Clients resolve the head **once**, then walk `soc/{owner}/{identifier}` addresses computed locally
from `keccak256(topic || index)`. That is the 4ms path. It works because a client following a feed
already knows where it is, so it never needs to ask where the end is.

It does not help the first read, and it does not help any consumer that legitimately needs the head of
a feed it has not been following.

## Possible directions, offered without knowing the constraints

1. **Make the timeout configurable or injectable**, which the existing `TODO` already proposes. Even
   dropping it to 200ms would take the floor from 1000ms to 200ms with no change in behaviour.
2. **Distinguish "not found because it was never written" from "not found yet".** The whole cost is
   that these are the same answer. If the neighbourhood can answer authoritatively that a SOC address
   has no chunk, the probe does not need to wait out a timeout.
3. **Return the epoch or a hint with each feed update**, so a reader can jump rather than search.
4. **Cache the last known head per feed**, so repeat readers of a live feed pay the search once. This
   is what our client does by hand.

We are happy to re-run the probe against any patch. The measurement is a standalone script with no
video and no product code in it, and a full pass costs about a minute.

## Reproducing

Write N slots to a sequence feed, let it settle, then time `GET /feeds/{owner}/{topic}` against a
direct `GET /soc/{owner}/{identifier}` for the same chunk, round robin across several feed lengths.
Our version is `e2e/src/probes/feed-head-scaling.mjs` in this repository, raw output in
`docs/bench/feed-head-scaling.json`, analysis in `docs/bench/feed-head-scaling.md`.

The one thing worth copying from it: **read the arms round robin rather than one length at a time.**
We have measured 1.05s of between sitting drift on identical settings in this environment, which is
larger than several of the differences here, and interleaving is what keeps that from landing on one
arm.
