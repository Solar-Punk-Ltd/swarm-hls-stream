# A cold gateway needs a minute, and the viewer feels it for less than that

**2026-08-08, 17:10 to 17:19 UTC.** Twelve arms on an unfunded gateway, forcing a cold start at the head
of each round and then running five identical 128-viewer arms to watch the penalty decay. Two rounds.
**Cost: nothing.** The chequebook was byte-identical before and after.

⭐ **This replicates a finding that arrived by accident.**
[The concurrency sweep](the-ceiling-is-bytes-not-viewers-2026-08-08.md) alternated an identical
reference arm, and its first appearance came out three times more expensive than the other seven. That
was a by-product of a sweep about something else. This sitting sets out to reproduce it, and does.

## ⭐ How a cold start is forced twice in one sitting

Arms that share a swap and cache setting run on one continuous node with no recreate between them, so a
plan of five identical arms would be cold exactly once no matter how many rounds it ran. The `X` arm at
the head of each round sits at a different cache capacity, so the `W1` that follows it **has** to
recreate. W1 is therefore cold in round 2 as well as round 1.

## ⭐⭐ The result, and the two rounds agree to within a few percent

| arm | CPU per MB, r1 / r2 | vs settled | median | over budget | ended behind |
| --- | ---: | ---: | ---: | ---: | ---: |
| **W1, cold** | **0.231 / 0.220** | **2.16 / 2.06x** | **199 / 241ms** | **32.3 / 40.4%** | **6045 / 6785ms** |
| W2 | 0.126 / 0.128 | 1.18 / 1.20x | 45 / 40ms | 0.6 / 0.5% | 29 / 0ms |
| W3 | 0.119 / 0.120 | 1.11 / 1.12x | 76 / 102ms | 0.0 / 1.1% | 0 / 0ms |
| W4 | 0.101 / 0.112 | 0.94 / 1.05x | 51 / 91ms | 0.0 / 0.0% | 0 / 0ms |
| W5 | 0.106 / 0.107 | 0.99 / 1.00x | 85 / 94ms | 0.0 / 0.0% | 0 / 0ms |

⛔⛔ **The first arm after a recreate costs about twice what the same work costs settled**, and puts a
third to two fifths of segments over budget where every later arm puts essentially none.

⭐⭐ **The decay curve is the new part, and it is reproducible.** 2.1x, then 1.19x, then 1.12x, then
settled. Every arm matches its counterpart in the other round to within a few percent, which is what
makes this a curve rather than one bad arm and some noise.

## ⭐⭐ The CPU and the viewer recover on different timescales

This is the part that matters operationally, and neither sitting could see it before.

- **CPU takes about four arms to settle.** W2 is still 19% expensive and W3 12%.
- **The viewer is fine after one.** W2's late share is already 0.5-0.6% and its buffer drain is 29ms and
  zero, against W1's 32-40% and six to seven seconds.

Arms are 21 to 24 seconds of work spaced about 42 seconds apart, so in wall-clock terms:

⭐ **A gateway is unfit to serve for roughly its first minute, and is still quietly expensive for about
three.** The expensive part is invisible to viewers. The unfit part is not.

## ⛔ What this changes about running an event

⛔ **Warm a newly provisioned gateway before pointing viewers at it.** One minute of any traffic at all
is enough to move it from 32-40% of segments over budget to under one percent.

⛔ **Treat a restart during a live event as taking that gateway out of service for a minute**, not for
the few seconds the container takes to answer `/health`. The node answers health checks long before it
can serve, which is exactly the shape of failure this project has hit before: a signal that is green
while the thing it is meant to guard is not working.

⚠️ **A load balancer that returns a gateway to the pool on a health check alone will return it too
early.** Nothing here measures a readiness probe that would do better, but the gap between "answers
`/health`" and "serves at budget" is now measured at about a minute.

## ⚠️ The magnitude is 2 to 3x, and the difference is worth noting

The accidental observation gave **2.8x** and this one gives **2.1x**. The two cold starts were not
identical: the earlier one recreated the node across a **funding change** as well, from a funded
baseline to an unfunded arm, while this one changed only the cache capacity.

⚠️ So **the more the recreate disturbs, the more it costs**, and 2.1x is the floor rather than the
figure. ⬅ Whether funding changes specifically account for the difference was not tested.

⚠️ ⛔ **The earlier report's "roughly 3x" should be read as 2 to 3x.** It was accurate for the arm it
described and is not the general figure.

## ⚠️ What this does not show

⚠️ **The mechanism is still described rather than explained.** Peer count is flat throughout, so it is
not a node short of peers, and the accounting counters move while it decays. Naming the cause would need
more than this sitting.

⚠️ **One concurrency, 128 viewers**, which is near this gateway's measured capacity of about 123. A cold
node at a fraction of capacity would have slack to absorb the penalty and might show nothing at all,
which is consistent with why this hid in earlier sittings whose first arms were not near a limit.

⚠️ **Unfunded gateway.** A funded node does far less peer-selection work per chunk, so both the penalty
and its decay could differ.

⚠️ **Probe viewers, not browsers.** The "unfit to serve" claim is about segments missing a 267ms budget
and buffer arithmetic, not about an observed stall.

⚠️ 60 references, one host, two rounds.

## Artifacts

`/home/solarpunk/retrieval-probe/COLD1/`. Probe: `deploy/scripts/retrieval-debt-probe.sh`. Driver:
the `X` arm trick above, which is the only reason round 2 is a second cold start rather than a repeat of
a warm one. Gateway restored to `--swap-enable=true` and `--cache-capacity=0` and confirmed on the node.
