# What separates a collapse from a clean run

**A re-read of two archived sittings. No new measurement, no BZZ, nothing deployed.**

Phase 0.6 has had one open term since it began: an unfunded gateway collapsed a viewer on 2026-08-06
and held for forty-five minutes on 2026-08-08, and the only difference anything had measured was a
**24% gap in median segment transfer time**. That is a small number to hang a deployment decision on.

Every `browser-watch` report has a `.requests.json` companion carrying the start and end of every
request the viewer made. Nobody had read them. They contain the answer.

## The term is not the median. It is the rate of one-second stalls.

| arm | median | over the 267ms budget | **retrievals ≥ 1s, per 1000** | what the viewer got |
| --- | ---: | ---: | ---: | --- |
| 08-06 funded | 91ms | 0.4% | **0.0** | ✅ clean |
| 08-06 unfunded 1 | 156ms | 31.9% | **17.4** | ⛔ 3 rebuffers |
| 08-06 unfunded 2 | 172ms | 33.3% | **21.7** | ⛔ **17 rebuffers**, buffer 4.60s → 1.46s |
| 08-08 funded 1 | 63ms | 2.8% | 1.2 | ✅ clean |
| 08-08 funded 2 | 63ms | 0.8% | 0.0 | ✅ clean |
| 08-08 unfunded 1 | 132ms | 23.1% | **0.5** | ✅ clean |
| 08-08 unfunded 2 | 146ms | 24.0% | **1.6** | ✅ clean |

⭐ **Between the night that collapsed and the night that held, the median moved 1.18x and the rate of
one-second retrievals moved 10 to 40x.** The statistic everything was decided on is a shadow of the
one that matters.

⭐ **On 2026-08-08 the unfunded arm produced fewer one-second stalls than the funded arm** (0.5 per
thousand against 1.2). By this measure ultra-light was not merely acceptable that night, it was
indistinguishable from funded. On 2026-08-06 the same configuration ran at 17 to 22 per thousand.

## Why one second, and why it drains a buffer

⚠️ **Every one of these stalls is 1.0 to 1.1 seconds.** Not a spread, a value. That is not a slow
transfer, it is a **retry timer**: a retrieval asks a peer that will not serve it, waits out a fixed
timeout, and asks someone else. It is the shape a per-peer allowance refusal takes at the client end.

⚠️ **They arrive in bursts.** In the worst arm, six of the twelve landed between 35% and 38% of the way
through, and in the next, six of the fourteen between 26% and 30%. A single one-second stall against a
267ms budget puts the player about four segments behind, which a 4.8s buffer absorbs without a mark.
**Six in a row does not get absorbed**, and that is what a rebuffer is.

That also explains why a median cannot see this. Twelve events in 689 requests is 1.7% of them: they
do not move the middle of a distribution at all, and they are the entire failure.

## What this changes

⛔ **Every ultra-light figure this project has published is a median**, including the segment-budget
share table the ship/do-not-ship threshold was built on. They rank the arms correctly and they
understate the gap by more than an order of magnitude.

✅ **The standing answer does not change: do not ship an unfunded viewer gateway.** If anything it is
firmer. The failure is not a stream that is uniformly slower, which a bigger buffer would cover. It is
**bursts of second-long stalls at a rate that varies 40x for reasons nothing controls**.

✅ **A 1.0s GOP still absorbs it**, and now for a legible reason: a one-second stall against a 1000ms
budget costs one segment rather than four.

⭐ **The next measurement is named.** Count one-second retrievals, not medians. That is what
`retrieval-debt-probe.sh` now reports, and what the unfunded-only sweep is varying idle time against.

## What this cannot say

The request log times a fetch from the browser, so it includes anything happening between the player
and the gateway. What it cannot separate is a retry inside bee from a retry inside hls.js. The
uniformity at 1.0-1.1s and the absence of the same events in the funded arms both point at the
retrieval path, and a node-side measurement would settle it.

Arm lengths differ between the sittings (about 690 requests against about 1850), which is why every
rate here is per thousand rather than a count.

## Artifacts

`docs/bench/browser-watch-2026-08-06T06-*.requests.json` and `...2026-08-08T03-*.requests.json`, all
already in the repository. Read with nothing but the archive.
