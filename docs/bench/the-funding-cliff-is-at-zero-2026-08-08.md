# The funding cliff is a switch, and it flips at zero

**2026-08-08, 11:00 to 11:07 UTC.** Two arms of 800 references through the same gateway, with the
chequebook drained to a known small balance beforehand and its available balance sampled every five
seconds beside the retrieval counters.

Phase 0.6 established that an unfunded node **cannot settle**, and that debt level is not the dial:
arms pegged at the -1.4 billion PLUR ceiling were the best of eleven. That left the question with the
largest consequence for a large event unanswered. **Is the ability to settle a switch or a dial?** If
a trivial deposit restores full-speed retrieval, a thousand-node event needs almost nothing per node.

## ⭐⭐ The answer

| arm | chequebook available | median | over 267ms | **first-peer service** | **skips per chunk** | CPU per MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **A** | **0.05 BZZ** | **43ms** | **0.1%** | **87.6%** | **1.56** | **1.975s** |
| **B** | **0.0000004 BZZ** | **109ms** | **10.6%** | **12.5%** | **39.8** | **3.977s** |

⭐ **0.05 BZZ performs exactly like 6.4 BZZ.** Arm A matches every funded arm measured today (33-44ms
median, 0.0-0.2% late). A hundred-and-twenty-eighth of the balance buys the same retrieval.

⭐ **A chequebook with nothing in it is worth nothing.** Arm B is indistinguishable from a node with no
chequebook at all, which measured 87-131ms median, 0.5-11.8% late and 8.6-9.6% first-peer service
earlier the same day. `--swap-enable=true` and an empty balance is not a partly-funded node, it is an
unfunded node.

⭐ **The transition is total, not gradual**: a **25x** jump in accounting skips and first-peer service
collapsing from 87.6% to 12.5%, with nothing changed but the balance reaching zero.

## The drain, sampled every five seconds

```
11:00:53  500,000,000,000,000   arm A has not started spending
11:01:14  472,590,999,999,900   spending begins
11:01:39  239,410,999,999,900
11:02:04   24,642,999,999,900
11:02:09       28,999,999,900   exhausted
11:02:14       16,999,999,900   flat from here
```

**0.05 BZZ lasted 55 seconds of flat-out retrieval**, or 74 MB, which agrees with the 0.00085 BZZ per
MB this project prices retrieval at. Arm A finished six seconds after exhaustion, so it is a clean
measurement of the funded state. Arm B, run immediately afterwards on the drained node, is the
measurement of the other side.

⚠️ **This is the state found by accident on 2026-08-07**, when the gateway was discovered at
0.0000007 BZZ spendable against a 14.7 BZZ chequebook with **every health signal green**: `/health` in
1.1ms, 134 peers, reachability Public. Nothing reports this fault. It is now reproduced deliberately
and its cost is measured.

## What it means for a large event

⭐⭐ **Balance level buys nothing except time.** So sizing is arithmetic rather than a question:

```
BZZ per node = burn rate x event duration
```

At the measured **0.0102 BZZ per minute** for 720p / 2500 kbps, a two-hour event needs **1.22 BZZ per
gateway**, and any more than that is idle capital.

⭐ **Combined with [viewers sharing a gateway](sixteen-viewers-cost-what-one-costs-2026-08-08.md), the
whole cost model collapses to something small.** A thousand viewers at sixteen per gateway is
**63 gateways**, so a two-hour event is about **77 BZZ**, against **1,220 BZZ** for one node per viewer.

⛔ **And it names the failure that has no alarm.** A gateway that runs dry mid-event does not error, does
not disconnect and does not report anything. It simply becomes an unfunded node, and every viewer
behind it moves from 0.1% late segments to 10.6%. **Anything running this at scale must alarm on
`chequebookAvailableBzz` approaching zero**, because no other signal moves.

## The correction this run also settles

The [concurrency sweep](sixteen-viewers-cost-what-one-costs-2026-08-08.md) reported that accounting
skips looked like a fixed rate rather than a per-chunk cost, because they stayed near 75,000 per arm
while the workload moved 15x. **That reading was wrong, and the denominator was the problem.**

Bee increments `AccountingBlocksCount` in exactly one place, `PrepareCredit`, **once per call on
overdraft**, so it is not time-driven. What is nearly constant across that sweep is the number of
**distinct** chunks fetched from the network, because concurrent viewers share one fetch. Divided by
that instead of by request count:

| viewers | skips | distinct chunks | **skips per distinct chunk** |
| ---: | ---: | ---: | ---: |
| 1 | 74,112 | 3,260 | **22.7** |
| 2 | 67,067 | 3,167 | **21.2** |
| 4 | 77,744 | 3,287 | **23.7** |
| 8 | 82,116 | 3,227 | **25.4** |
| 16 | 89,408 | 3,250 | **27.5** |

⭐ **21.2 to 27.5 across a 15x concurrency range.** It is a stable per-chunk cost after all, and the
chunk has to be a distinct one. This arm agrees independently at **39.8 skips per chunk** on a drained
node against **1.56** on the same node with 0.05 BZZ in it.

⚠️ **Still open:** which subsystems call `PrepareCredit`. It is reachable by anything holding an
`accounting.Interface`, and only the retrieval path has been read.

## What it cost

**Nothing that was not already spent.** Arm A consumed the 0.05 BZZ left in the chequebook, which is
ordinary retrieval spend at the standard rate. Arm B could not spend, because the node was drained.
The 6.366 BZZ withdrawn beforehand went to the node's own wallet and is returned by the matching
deposit. Uploader chequebook and postage untouched.

## Artifacts

`/home/solarpunk/retrieval-probe/cliff1/` and `cliff2/`, plus `cliff1/sampler.tsv` holding the
five-second balance trace beside the counters. Sampler:
`/home/solarpunk/retrieval-probe/cliff-sampler.sh`. Probe:
`deploy/scripts/retrieval-debt-probe.sh`.
