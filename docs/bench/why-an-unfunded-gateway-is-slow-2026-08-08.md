# Why an unfunded gateway is slow, from the node rather than the browser

**2026-08-08, 08:03 to 08:11 UTC.** Four arms on `latbench`, funded and unfunded interleaved, each
retrieving the same 800 references in the same order, with **bee's own retrieval and accounting
counters** read before and after every arm.

Every previous figure in this investigation was taken at the browser. A browser can see that a
retrieval took a second. It cannot see whether that second was a peer refusing, a retry timer, or a
route being rebuilt. This is the measurement that separates them, and it settles the question.

## The mechanism, counted

| arm | chunk requests | **peers skipped for accounting** | per 10k requests | **attempts per request** |
| --- | ---: | ---: | ---: | ---: |
| 1 funded | 20,940 | **5** | 2.4 | **1.14** |
| 1 unfunded | 20,957 | **799,072** | 381,291 | **39.41** |
| 2 funded | 20,957 | **22** | 10.5 | **1.14** |
| 2 unfunded | 20,957 | **773,898** | 369,279 | **38.22** |

The skip counter is `bee_accounting_accounting_blocks_count`, and bee's own description of it is
**"Number of occurrences of temporarily skipping a peer to avoid crossing their disconnect
thresholds"**. That is the mechanism, in the node's own words, counted.

⭐ **An unfunded node skips a peer for accounting reasons about 37 times for every chunk it fetches.**
A funded node doing identical work does it five times in total.

⭐ **It has to ask 38 peers where a funded node asks one.** 1.14 attempts per request against 38-39, a
**34x** increase in the work of finding somebody willing to serve.

## The causal chain, now complete and measured end to end

1. **An unfunded node cannot settle what it owes.** Three arms grew debt by 604, 721 and 479 million
   PLUR where funded arms **settled** it. [Measured 2026-08-08.](what-throttles-an-unfunded-gateway-2026-08-08.md)
2. **So it sits near every peer's disconnect threshold**, and bee skips those peers rather than be
   disconnected. **786,000 skips per arm**, measured here.
3. **So each chunk must try around 38 peers instead of one.** Measured here.
4. **Usually one of the 38 answers quickly**, which is why the median only moves 2.9x and why every
   median-based figure understated this by an order of magnitude.
5. **Sometimes the willing peers run out and the request waits out a retry timer.** Every stall in the
   archived viewer logs is **1.0 to 1.1 seconds**, a value rather than a spread.
6. **Those stalls arrive in bursts**, six inside a 3% window of one arm, and a burst against a 267ms
   segment budget is what drains a 4.8s buffer into a rebuffer.
   [From the archive.](what-separates-a-collapse-from-a-clean-run-2026-08-08.md)

Every step now has a number behind it.

## Two things the counters correct

⚠️ **It is not failure, it is the work of avoiding failure.** Request failure rates are
indistinguishable between the arms: **7.1% funded, 7.4% unfunded**. The unfunded node is not failing
more often, it is spending 38 attempts to fail at the same rate.

⚠️ **Time-settlement is not idle-driven, it is demand-driven.** The unfunded arms sent **10,512 and
10,332** pseudo-settlements against the funded arms' **909 and 1,005**. The node is attempting to
settle constantly and cannot keep up. That refines the earlier finding that fifteen minutes of idle
refills nothing: bee sends a time-settlement when it needs headroom with a peer, not on a timer, so an
idle node settles nothing because an idle node needs nothing.

## What this changes

✅ **The mechanism is no longer a lead.** "Ultra-light is slower" and "ultra-light is starved" are
separated, and it is starved: 786,000 accounting skips per arm is not a network being slow.

⛔ **The standing answer is unchanged and now has a reason.** Do not ship an unfunded viewer gateway.
Not because it always breaks, but because every chunk it fetches is a search across 38 peers for one
that will still serve it, and how many of those searches run out is not something a deployment
controls.

✅ **A 1.0s GOP remains the one reliable fix**, for the same reason as before: a retry timer costs one
segment against a 1000ms budget and four against 267ms.

## What it cost

| | before | after | spent |
| --- | ---: | ---: | ---: |
| gateway chequebook | 6.6229 | 6.5124 | **0.1105 BZZ** |
| uploader chequebook | 2.3238 | 2.3238 | **nothing** |
| postage | — | — | **nothing** |

The whole bill is the two funded control arms. **The unfunded arms, which carry the result, cost
nothing at all.** The gateway was restored to `--swap-enable=true` and confirmed on the node.

## What this still cannot say

The retry timer itself is inferred from the client side: the counters show 38 attempts per request but
not the wall-clock shape of the one that ran out. Bee's `bee_retrieval_request_duration_time` histogram
would show it directly and is one line more of the same sampler.

## Artifacts

`/home/solarpunk/retrieval-probe/metrics1/`, holding `probe-metrics.tsv` with every counter before and
after each arm. Sampler: `deploy/scripts/gateway-retrieval-metrics.sh`. Probe:
`deploy/scripts/retrieval-debt-probe.sh`.
