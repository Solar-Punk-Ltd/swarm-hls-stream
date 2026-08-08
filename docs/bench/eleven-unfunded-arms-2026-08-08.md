# Eleven unfunded arms, one node, two hours

**2026-08-08, 05:54 to 07:52 UTC.** Three sittings on `latbench`, eleven unfunded arms in total, every
one retrieving **the same 800 references in the same order** through the same gateway. Cost: the three
funded control arms in the first sitting, 0.184 BZZ. **The eight arms after that cost nothing at all**,
because a node with no chequebook cannot spend.

This set out to find what varies between unfunded runs, after
[the archive showed](what-separates-a-collapse-from-a-clean-run-2026-08-08.md) that the term is the
rate of one-second stalls rather than the median. It refuted the leading hypothesis and found
something more useful.

## The refill hypothesis is refuted, twice over

The idea was that an unfunded node saturates a per-peer allowance and then runs at the rate that
allowance refills, which would make **time spent idle** the term that moves it.

⛔ **Idle refills nothing.** Debt read **-1,357,400,000** PLUR at the end of one arm and
**-1,357,270,000** at the start of the next, **fifteen minutes of idle later**. A second pair was
identical to the unit: -1,430,120,000 both sides of a 900-second idle. There is no time-based
settlement at this timescale.

⛔ **Idle changes nothing a viewer would feel**, in either sitting that varied it:

| sitting | idle | share of segments over the 267ms budget |
| --- | ---: | --- |
| continuous node | 60s | 3.0%, 1.9% |
| continuous node | 900s | 3.4%, 2.4% |
| recreated each arm | 0s | 10.6%, 14.6% |
| recreated each arm | 90s | 12.2%, 15.0% |

Fifteen minutes of idle is indistinguishable from one minute, and ninety seconds is indistinguishable
from none.

## Debt level does not predict performance either

Debt **saturates**. The first arm took it from -407M to -1,357M; the three after it added 28M, 45M and
20M against a ceiling near **-1.4 billion**. Those three arms ran **pegged at the ceiling** and were
the best of the eleven, at 1.9% to 3.4% late.

⛔ So an unfunded node carrying its maximum debt outperformed the same node starting near a third of
it. Whatever throttles retrieval, the size of the debt is not the dial.

## What eleven arms actually say

| sitting | condition | late share |
| --- | --- | --- |
| 05:54-06:07 | recreate before each arm, interleaved with funded arms | 8.4%, 19.5%, 17.0% |
| 06:55-07:35 | **no recreate** after the first, 60-900s idle | **3.0%, 3.4%, 1.9%, 2.4%** |
| 07:38-07:52 | recreate forced before every arm, 0-90s idle | 10.6%, 12.2%, 14.6%, 15.0% |

⭐ **The late share ranged from 1.9% to 19.5% across eleven arms of identical work, on one node, in
under two hours.** A tenfold spread, and none of idle, debt level or arm order accounts for it.

⚠️ **A container recreate is the strongest candidate.** The three arms measured on a continuously
running node are the three best, and every arm above 8% followed a recreate. It is not clean: one
recreated arm came in at 3.0%, which the theory does not explain, so this is a lead rather than a
finding. A recreate drops every peer connection, and the first retrieval after one took **9.7 and 9.2
seconds** where the same fetch after a ninety-second idle took **0.03**. That single fetch is
discarded, but the disturbance plainly outlives it.

⚠️ **Something slow-moving is also present.** Within the last sitting the late share climbed
monotonically, 10.6 → 12.2 → 14.6 → 15.0, across arms whose idle alternated. That ordering is time,
not treatment, and nothing here measures the network's own load.

## Why this is the answer to the deployment question anyway

The question was never "what causes the variance", it was "can an unfunded viewer gateway be relied
on". Eleven arms say no, and say it more firmly than a cause would:

⛔ **There is no operator setting that makes it reliable.** Idle does not. Debt does not. Warming the
node does not. The one lead, avoiding a restart, is not something a deployment can promise, and it
does not explain every arm.

⛔ **The spread is larger than the margin.** A viewer collapsed at 32-33% late on 2026-08-06 and held
at 23-24% on 2026-08-08. This node moved across a **tenfold** range in two hours without being asked
to. Whatever the mechanism, the variation is not controllable from the deployment side.

✅ **The funded arm has no such problem**, at 0.3% late across three arms of the same work.

## What would settle the mechanism

A node-side measurement during a bad arm. Every figure here is taken at the client, so a one-second
stall cannot be attributed to a peer refusing, a retry timer, or a route being re-established. Bee's
own retrieval metrics would separate them, and the run they need is one already happening.

## Artifacts

`/home/solarpunk/retrieval-probe/{run1,refill1,idle-isolated}/` on the host, each holding `probe.log`,
`probe-state.tsv`, `probe-series.tsv` and per-arm timing files. Probe:
`deploy/scripts/retrieval-debt-probe.sh`. The gateway was restored to `--swap-enable=true` and
confirmed on the node after every sitting.
