# Concurrent viewers

Measured 2026-08-04 on `latbench`, 720p 2500kbps at a 2.0s GOP, gateway in `light` mode with a funded
chequebook. Three broadcasts, about 95 minutes of publishing.

**A viewer adds load rather than sharing it.** Eight viewers on one gateway leave the stream about
**1.30x staler** than one viewer does, and the direction held in **12 of 14** paired comparisons
(sign test p = 0.0129).

This matters because it is the shipped topology, not a synthetic worry: `VITE_READER_BEE_URL` is a
single URL baked into the client build, so every viewer of a deployment polls the same gateway.

## The measure

`meanStalenessMs`: the average, over a window, of how old the newest segment the gateway would serve
was at that moment. Integrated over wall clock between polls rather than averaged per poll, so a
window whose polls bunched up cannot weight itself differently from one whose polls were even.

Chosen because it has no cutoff. `frozenShare` needs a threshold to say what counts as frozen, and a
threshold is a free parameter that can be chosen, accidentally, to produce an effect.

## Why the obvious experiment does not work, measured rather than assumed

The first design was a ladder: one viewer for six minutes, then two, then four, then eight, inside one
broadcast.

Before reading it, the same analysis was applied to **eight past single-reader broadcasts**, slicing
each into quarters and labelling the quarters as if the viewer count had changed. Nothing had changed
in any of them. The metric still moved by up to **1.95x**, median 1.41x.

A four-level ladder reads out exactly one such quarter per level, so it cannot resolve anything under
roughly 2x. It would have produced a confident number either way.

## The design that does work

Short alternating blocks: one viewer for two minutes, eight for two minutes, repeated seven times per
broadcast. Each loaded block is compared against the quiet block immediately before it, so drift over
the broadcast subtracts out in the pairing instead of being assumed absent.

Two details are load-bearing:

- **The block length is not a multiple of the 63 second freeze period.** At 120s a block spans 1.9
  periods, so successive blocks land on different parts of the cycle and the alias washes out.
- **The reference reader is the bench itself**, unchanged, running the whole broadcast. Only the
  number of *other* readers moves, which makes each phase its own control.

Run against the same unchanged broadcasts, this design gives **zero false positives across seven
runs**, with ratios between 0.83x and 1.15x. It resolves to about ±15% where the ladder was ±95%.

## Result

| run | design | pairs | worse under load | median ratio |
| --- | --- | ---: | ---: | ---: |
| 1 | ladder 1 to 8 | - | monotone | **1.87x** across the ladder |
| 2 | alternating | 7 | 6/7 | **1.42x** |
| 3 | alternating | 7 | 6/7 | **1.20x** |
| **pooled 2+3** | | **14** | **12/14** | **1.30x** |

- sign test on the pooled pairs: **p = 0.0129** two-tailed
- exact permutation on the median: p = 0.0554 one-sided, which is the weaker test because a median is
  insensitive by construction. The sign test is the one stated in advance.
- the same statistic on broadcasts where the viewer count never changed: 0.83x to 1.15x over eight
  runs, **none reaching 1.30x**

Run 1's ladder is reported for its shape rather than its significance. Laying its exact phase windows
over six unchanged runs puts the null between 0.86x and 1.25x, and run 1 sits at 1.87x, above all of
them.

## The load arm really was loaded

Taken from Docker, not from the readers and not from the bench, because a null result has to be
distinguishable from the load never arriving.

| run | quiet CPU | loaded CPU | ratio |
| --- | ---: | ---: | ---: |
| 2 | 13.6% | 34.8% | 2.56x |
| 3 | 16.6% | 30.6% | 1.84x |

49 load readers reported their own counts per run, having fetched 858 segments in run 2.

## Mechanism: it is request handling, not retrieval

From the gateway's own `/metrics`, per arm, run 3:

| per second | 1 viewer | 8 viewers | ratio |
| --- | ---: | ---: | ---: |
| chunks retrieved | 87.7 | 96.0 | **1.09x** |
| peer requests | 88.3 | 99.3 | 1.12x |
| gateway CPU | 16.6% | 30.6% | 1.84x |

**Eight viewers produce nine percent more chunk retrieval than one.** A 720p 2500kbps stream is about
76 chunks per second, which is very close to what the gateway fetches with a single viewer, so the
extra seven are being served from what it already holds rather than causing eight times the network
work. That is correct behaviour.

So the cost of a viewer is not bandwidth and not postage. It is in serving requests, and it lands on
feed freshness. Two consequences:

- **This is not a capacity purchase.** The loaded arm averaged 30.6% CPU on a 48-core host, nowhere
  near saturation, so the ceiling is inside bee rather than in the hardware.
- **Horizontal gateways are the lever**, or bee's own request-handling limits are. Adding BZZ will not
  help, since the retrieval volume barely moves.

## Not established

- **Eight is the only loaded arm tested.** Whether the cost is linear, or a knee somewhere between two
  and eight, is unmeasured.
- **RETRACTED 2026-08-04, same day it was written.** This section previously reported
  `bee_retrieval_total_errors` at "38.8% of chunks retrieved" and called it worth investigating. That
  ratio divided two unrelated counters and meant nothing. The metric a caller actually experiences is
  `request_failure_count / request_count`, and on the gateway it is **9.58%, against 11.06% on a
  reference node under a different workload**, with retries per request identical at 1.45 and 1.49.
  Retrieval on this gateway is behaving normally. `total_errors` is genuinely 15.7x the reference,
  but it cannot mean what its name suggests, since 45% of peer attempts failing would demand far more
  attempts per success than the reference and the attempt counts match. The likeliest reading, stated
  as a hypothesis, is that it counts not-found probes, which are a consequence of the freeze rather
  than a cause: during a freeze the reader repeatedly asks for a feed index that is not yet
  retrievable. Settling it needs bee's source rather than another measurement.
- **This is measured against one gateway on the writer's own host.** A viewer on a distant gateway is
  a different question.

## Relationship to LAT-10

Separate effect, same symptom. LAT-10 is a 30 to 45s freeze on a 63 second cycle that survives funding,
segment length, picture size and cache tuning, and is cornered as a Bee single-owner-chunk retrieval
problem. This is a smaller, additive degradation that scales with viewers and lives in our own
deployment topology. Both land on the same number a viewer feels, which is why the freeze period had
to be designed around rather than averaged over.
