# Jitter is not what breaks a herd, and the shipped bound buys nothing

**2026-08-08, 14:02 to 14:16 UTC.** Eight arms at 128 concurrent paced viewers on an unfunded gateway,
sweeping per-request jitter against positional spread. **Cost: nothing.** The chequebook was
byte-identical before and after.

⛔ **This measures a default this repository shipped an hour earlier, in #108, and finds it does not
work.** It also corrects how the finding that motivated it was framed.

## What was being checked

[The cohort finding](a-synchronised-audience-is-the-failure-2026-08-08.md) was measured with `spread`,
which gives each viewer one fixed offset held for the whole walk. At `spread=16` on a 267ms segment
that is **4.3 seconds** of separation. What #108 shipped to the client is a different thing: a bounded
uniform delay **re-drawn in front of every request**, bounded at **60ms**.

Seventy times apart, and the smaller one had never been tested. The docblock justifying 60ms reasoned
that 128 viewers spread across it land about two per millisecond, which is the order of the cohort size
that held. **That reasoning is now measured to be wrong.**

## ⭐⭐ The result

| arm | jitter | spread | over 267ms | **ended behind** |
| --- | ---: | ---: | ---: | ---: |
| J0, the herd | 0 | 1 | 41.5 / 32.7% | 9437 / 9711ms |
| **J60, what shipped** | **60ms** | 1 | **28.9 / 31.0%** | **8041 / 10826ms** |
| J267, a whole segment | 267ms | 1 | 28.4 / **0.0%** | 6774 / **9ms** |
| **S16, positional** | 0 | **16** | **1.3 / 0.1%** | **0 / 0ms** |

⛔ **60ms of per-request jitter is indistinguishable from no jitter at all.** 8041 and 10826ms of
ending lag against the herd's 9437 and 9711, which is inside the run-to-run spread an unfunded node
shows on identical work. Both rounds. **The shipped default does not break a 128-viewer herd.**

✅ **Positional spread works, reliably, both rounds, exactly as before.**

⚠️ **A whole segment duration of jitter is ambiguous and must not be quoted as working.** One round
came back essentially perfect (9ms of ending lag, nothing over budget) and the other did not (6774ms).
Suggestive of a boundary, not a result.

## ⭐⭐ Why, and it reframes the earlier finding

The earlier report said what limits a gateway is **how many viewers arrive in the same instant**. On
this evidence that is not quite it. What limits it is **how many viewers want the same chunk at the
same time**, and the two come apart exactly where jitter lives:

- **Positional spread gives chunk diversity.** Viewers at sixteen different playback positions want
  sixteen different chunks. At any instant only eight are asking for any one of them.
- **Per-request jitter does not.** Every viewer is still at the same playback position, still wants the
  same chunk, and has merely moved by a few tens of milliseconds. There is nothing for the gateway to
  spread the work across.

⭐ That also explains the ambiguous middle. At 267ms of jitter on a 267ms segment, a viewer's requests
drift by up to a whole segment relative to its neighbours, so temporal jitter starts **turning into**
positional spread. It only begins to help at the point where it stops meaning "the same chunk, later"
and starts meaning "a different chunk".

⛔ **So a client cannot jitter its way out of a live herd at any bound it can afford.** Buying the
effect needs a jitter of a segment duration or more, which is a direct latency cost at the live edge,
and even then it did not hold across two rounds.

## What actually mitigates a live herd

Both were measured earlier the same day and neither is a client change:

1. ⭐⭐ **The gateway cache.** With a scattered audience it takes network contacts to **one fetch per
   distinct chunk serving 128 viewers**, the theoretical floor, and collapses the buffer a viewer needs
   from 8.3 seconds to 0.3. It is `--cache-capacity=0` in everything shipped.
2. ⭐ **Pooling viewers behind fewer gateways**, so the fetch that does happen is shared.

## ⛔ What was changed in response

The stagger in front of every gateway request now **defaults to 0**, which runs it synchronously and
restores exactly the behaviour before #108. The mechanism, its configurability and its tests all stay,
so it can be turned on where an operator has evidence for it. This one has none, and it was costing up
to 60ms per fragment for it.

⚠️ **The manifest backoff jitter stays on**, and it is a different case. `backoffDelayMs` is a pure
function of the failure count, so viewers that lost a gateway together retry in the same millisecond,
and 25% of a 2 to 30 second backoff is **0.5 to 7.5 seconds** of separation, which is the scale that
worked rather than the scale that did not. It costs nothing, because the viewer is already waiting.
⬅ **It has not been measured here**, and is kept as standard practice rather than as a result.

## ⚠️ What this does not show

⚠️ **One concurrency, 128, and one gateway.** A jitter that does nothing against a herd of 128 might
still matter at a concurrency where the node is not already saturated. Nothing measured that.

⚠️ **The J267 disagreement is unresolved.** Two rounds, opposite answers, and the mechanism above
predicts it sits on a boundary. A third round would be free and has not been run.

⚠️ **The herd being modelled is every viewer at the identical playback position**, which is the shape
after a common shock rather than the steady state. A live audience in steady state is naturally
scattered, and the earlier report covers that case.

⚠️ Unfunded gateway, 0.25s profile, 100 references, one host, two rounds.

## Artifacts

`/home/solarpunk/retrieval-probe/{jitproving,jitproving2,jitter1}/`. Probe:
`deploy/scripts/retrieval-debt-probe.sh`, jitter is the 8th arm field.

The instrument was proved both ways before use. A jitter smaller than the pace is absorbed and leaves
lag at exactly zero, which is the check that a deliberate offset is not charged as buffer drain. A
jitter larger than the pace cannot be absorbed and took the deepest lag from **365ms to 1108ms**, the
bound plus drift, which is the check that the drawn value reaches the sleep at all: a jitter that was
computed and then ignored would have left it unchanged.
