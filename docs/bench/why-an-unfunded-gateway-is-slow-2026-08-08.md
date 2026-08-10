# Why an unfunded gateway is slow, from the node rather than the browser

**2026-08-08, 08:03 to 08:11 UTC.** Four arms on `latbench`, funded and unfunded interleaved, each
retrieving the same 800 references in the same order, with **bee's own retrieval and accounting
counters** read before and after every arm.

Every previous figure in this investigation was taken at the browser. A browser can see that a
retrieval took a second. It cannot see whether that second was a peer refusing, a retry timer, or a
route being rebuilt. This is the measurement that separates them, and it settles the question.

## The mechanism, counted

| arm | chunk requests | **peers skipped for accounting** | per 10k requests | **loop iterations per request** |
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

### ⛔ CORRECTED 2026-08-08: those 38 are loop iterations, not requests on the wire

The first version of this report read the right-hand column as peers contacted and called it a 34x
increase in network work. **That is wrong**, and bee's own source says so. In `pkg/retrieval`:

```go
totalRetrieveAttempts++
s.metrics.PeerRequestCounter.Inc()      // incremented here
...
action, err := s.prepareCredit(ctx, peer, chunkAddr, origin)
if err != nil {
    skip.Add(chunkAddr, peer, overDraftRefresh)
    retry()
    continue                            // peer never contacted
}
```

`bee_retrieval_peer_request_count` and `bee_retrieval_request_attempts` are both incremented **before**
the accounting call that decides whether to contact the peer at all, so a skipped peer is counted and
never asked. The requests that actually leave the node are **attempts minus skips**:

| arm | attempts | − skips | **real peer contacts** | **per chunk** |
| --- | ---: | ---: | ---: | ---: |
| 1 funded | 23,924 | 5 | 23,919 | **1.142** |
| 2 funded | 23,950 | 22 | 23,928 | **1.142** |
| 1 unfunded | 825,931 | 799,072 | **26,859** | **1.281** |
| 2 unfunded | 801,062 | 773,898 | **27,164** | **1.296** |

⛔ **READ THIS BEFORE QUOTING THE TABLE BELOW.** Both columns behave like **rates** rather than
per-chunk costs. Across a later sweep whose workload varied 15x, skips held at 4,715 to 6,317 per
second and network contacts held at 3,167 to 3,287 **in absolute count**, so dividing either by a
chunk count gives whatever the throughput of that arm happened to make it. **These figures are valid
for the single-viewer arms they were taken from and do not generalise.** And
`bee_accounting_accounting_blocks_count` lives in the accounting package, which serves pushsync and
pullsync too, so it may count more than the retrieval loop's skips. Nobody has read that part of the
source. See [the concurrency sweep](sixteen-viewers-cost-what-one-costs-2026-08-08.md).

⭐ **An unfunded node puts about 13% more load on the network in bytes, not 34x.** Two independent arms
landing at 1.281 and 1.296 against a funded 1.142 is not a coincidence, and it is corroborated by rate:
825,931 requests in 151 seconds would be **5,470 per second**, which is a peer-selection loop spinning
rather than a light node saturating a link.

⛔ **Read that as a byte figure and never as the whole answer, which this report was first written to
say.** Retrievals go up 1.13x, but the pseudo-settlements measured below go up **10.9x**, so total
messages go up **1.50x**. A settlement message is tiny and a retrieval drags a 4 kB chunk back with it,
which is the whole reason the two answers differ by 4x. **In bytes it is ~13%. In messages and
connections it is ~50%.** Which one matters depends on what is scarce, and at fleet scale that is more
likely to be connections than bandwidth.

⭐ **So the 37 extra iterations per chunk are local: CPU and latency inside one node.** That does not
soften the deployment answer, since the late share and the one-second stalls are measured at the
client and unchanged. It changes **where the cost lands**, and therefore what a fleet of these nodes
does to a network as against what it does to its own host.

## The causal chain, now complete and measured end to end

1. **An unfunded node cannot settle what it owes.** Three arms grew debt by 604, 721 and 479 million
   PLUR where funded arms **settled** it. [Measured 2026-08-08.](what-throttles-an-unfunded-gateway-2026-08-08.md)
2. **So it sits near every peer's disconnect threshold**, and bee skips those peers rather than be
   disconnected. **786,000 skips per arm**, measured here.
3. **So each chunk costs around 38 peer-selection iterations instead of one**, of which about 37 end
   in a skip and 1.28 reach a peer. Measured here.
4. **Usually an eligible peer is found quickly**, which is why the median only moves 2.9x and why every
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
more often, it is spending 38 iterations to fail at the same rate.

⚠️ **Time-settlement is not idle-driven, it is demand-driven.** The unfunded arms sent **10,512 and
10,332** pseudo-settlements against the funded arms' **909 and 1,005**. The node is attempting to
settle constantly and cannot keep up. That refines the earlier finding that fifteen minutes of idle
refills nothing: bee sends a time-settlement when it needs headroom with a peer, not on a timer, so an
idle node settles nothing because an idle node needs nothing.

## What this changes

✅ **The mechanism is no longer a lead.** "Ultra-light is slower" and "ultra-light is starved" are
separated, and it is starved: 786,000 accounting skips per arm is not a network being slow.

⛔ **The standing answer is unchanged and now has a reason.** Do not ship an unfunded viewer gateway.
Not because it always breaks, but because every chunk it fetches is a search across 38 candidate peers
for one it is still allowed to pay, and how many of those searches run out is not something a
deployment controls.

⭐ **And it names where a fleet of these costs something.** The load is local, so the constraint on
running many of them is **host CPU and node density**, not network capacity. That is the opposite of
what the uncorrected reading implied, and it is the single most load-bearing input to any plan that
runs thousands of unfunded nodes at once.

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

The retry timer itself is inferred from the client side: the counters show 38 iterations per request
but not the wall-clock shape of the one that ran out. Bee's `bee_retrieval_request_duration_time`
histogram would show it directly and is one line more of the same sampler.

Nor does it separate the local cost into CPU against wall-clock waiting. 5,470 loop iterations a second
is cheap or expensive depending on what `prepareCredit` does per call, and no host-load sample was
taken during these arms.

## Artifacts

`/home/solarpunk/retrieval-probe/metrics1/`, holding `probe-metrics.tsv` with every counter before and
after each arm. Sampler: `deploy/scripts/gateway-retrieval-metrics.sh`. Probe:
`deploy/scripts/retrieval-debt-probe.sh`.
