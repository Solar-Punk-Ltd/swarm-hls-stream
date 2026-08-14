# The mid-arm floor check was reading a file nothing wrote

**2026-08-14.** One live broadcast, four arms, 0.3423 BZZ. ⭐ **The sitting's purpose was to validate a
repaired safety control on a real broadcast**, because the driver tests stub the very script the fix
turns on. The byte-source contrast it also produced is a secondary reading and is labelled as such.

## What was broken

`byte-source-arms.sh` and `gateway-funding-arms.sh` poll `STOP_FILE` for the whole length of every arm
and stop the **broadcast** when it appears. `node-metrics.sh watch` is the only writer of that file in
the repo, and `start_sampler` is its only launcher.

⛔ **Neither driver ever called `start_sampler`.** Both listed `stop_sampler` in their EXIT trap, so
the trap line read as evidence the wiring was there. `METRICS_INTERVAL_S` also defaults to 0, at which
`start_sampler` returns before starting anything, so restoring the call alone would have left the same
hole one level down.

⛔⛔⛔ **The test that covered it could not fail.** It looped over the `watch` invocations asserting
none read the ultra-light node. With no sampler there were no invocations, the body never ran, and it
passed. Its docstring carries three lines of correct reasoning about a real hazard. **A `for` over a
filtered list is an `if` that defaults to true.**

⚠️ **The two sittings of 2026-08-13 ran without the check and neither result is affected.** Load peaked
at 11.2 of 48 cores, the batch sat at 55% of 512, both chequebooks stayed above 1.6 BZZ. What was
missing was the net, not the ground.

## Proving the writer, before spending anything

The driver tests stub `node-metrics.sh`, so they can say nothing about whether the real writer works.
Run against the two live bee nodes, **both directions, free**:

| direction | result |
| --- | --- |
| forced, reserve set to 2.0 BZZ | stopped at **sample 1**, wrote `gateway available 1.6204 BZZ is under the 2.00 reserve` |
| normal, default 0.5 BZZ reserve | **4 samples in 35s**, no stop file, still running when the timeout killed it |

⭐ The trip names the right node at its real balance, which the preflight had independently read as
1.6204. **Make the control fire. Do not infer it from a run where it stayed quiet.**

A full `PREFLIGHT_ONLY=1` dry run then passed every gate and published nothing.

## The sitting

One broadcast, 1280x720 at 2500 kbps, **0.5s GOP**, 2.0s latency target, counterbalanced
`gateway weeb3 gateway weeb3`, round 1 discarded as warm-up.

✅ **The fix works on a real broadcast.** Every arm logged `sampling both nodes every 30s into
<arm>-series`, a line that has never appeared in a byte-source sitting, and each of the four arms
wrote **9 samples**. No floor was crossed, so no stop file was written.

### What the viewer got

| arm | source | counted | median latency | past target | `/bytes/` | `/soc/` | advance ratio | stalled samples | rebuffer ms |
| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | :---: | ---: |
| 1 | gateway | warm-up | — | — | 492 | 703 | 1.0039 | 0 | 750 |
| 2 | weeb3 | warm-up | 2.54 | −0.45 | 9 | 651 | 0.9944 | 1 | 1,162 |
| **3** | **gateway** | **counted** | **2.04** | **+0.04** | **494** | 680 | **1.0008** | **0** | 207 |
| **4** | **weeb3** | **counted** | **2.04** | **+0.04** | **7** | 678 | **1.0051** | **0** | 906 |

⭐⭐ **The counted round replicates the 2026-08-13 result at the same target.** Both conditions read
**2.04s against a 2.00s target**, which is the pinning that makes the latency column unable to rank
them. Node side: **23,360 retrievals for the gateway arm against 1,138 for the weeb-3 arm, 20.5x**,
against last night's 20.3x. Browser side, **494 `/bytes/` against 7, 70.6x**, and the weeb-3 arm's
seven are the manifest and init reads PR #183 keeps on the gateway by design.

⚠️ **n=1 per condition counted.** This sitting was sized to validate the harness, not to replicate.
Read the ratios as a third agreeing observation, not as new evidence.

⛔ **`/bytes/` 404s are 0 in every arm.** The `/soc/` 404s are 197 of 680 (29.0%) in the gateway arm
and 198 of 678 (29.2%) in the weeb-3 arm, which is the announcement floor at the same rate in both
conditions and is not a finding. Grouping by route is gate lesson AHS and it is why that is stated
rather than counted as a defect.

### What the nodes say, whole

```
window 1317s   host load 11.65 5.50 3.71 -> 7.26 8.50 7.62

UPLOADER   chunks push-synced 126,791   mean 11.3 ms   push errors retried 3,702 (2.9%)
           unsynced backlog 0 -> 0      invalid stamps 0
GATEWAY    retrieval requests 50,107    mean 42.5 ms   peers asked per request 2.21
           failed outright 3,123 (6.2%) invalid chunks 0
BUDGET     uploader 0.2427 BZZ (0.66/broadcast hour)   gateway 0.0956 BZZ (0.26/hour)
CAPACITY   batch 7849851f 285 -> 287 of 512 (56%), TTL 9.8d
           segmentsSkipped 0   segmentsNeverNamed 0   maxConsecutiveSegmentFailures 0
```

⚠️ **Do not table the gateway's per-arm mean retrieval time across conditions.** It reads 35.5 ms
during the gateway arm and 169.2 ms during the weeb-3 arm, and that is composition rather than
quality: what remains in a weeb-3 arm is feed lookups, about 45% of which are not-founds by design.
Same trap as the failure-rate column flagged on 2026-08-13.

⚠️ **Host load peaked at 11.65 of 48 cores** and the box carries some forty other bee nodes plus other
tenants' stacks. No bound the harness or host imposes was binding.

## ⛔⛔⛔ What the sitting found on its way past: a second setpoint defect

Every arm reported `latencyTarget: {configuredS: 6, raisedByS: 0, held: true}` while running at a
**2s** target and reporting `worstS: 3`.

`judgeLatencyTarget` read the compile-time constant `LIVE_SYNC_DURATION_S` for `configuredS`,
`raisedByS` and `held`, while `BROWSER_TARGET_LATENCY_S` has been moving the real target since
PR #186. **Arms have run at 6, 2 and 1.5 and every one had its target verdict scored against 6.** At a
2s target with the player raised to 3, the honest verdict is a full second of raise and `held: false`,
and what those reports printed was zero and true.

⭐ **Note which field survived.** `medianPastTargetS` subtracts the target from the reading **per
sample** rather than against a constant, so it was correct throughout, and it is what the 2026-08-13
write-up actually leaned on. **That conclusion stands.** What was worthless beside it is the `held`
column.

⭐ Every existing test in `browserLatencyTarget.test.ts` passes the default target, which is why none
could see this. **A parameter with a default is only tested by a case that passes something else.**

## Cost, and where the authorisation stands

| | |
| --- | --- |
| this sitting | **0.3423 BZZ** (uploader 0.2427, gateway 0.0996 by balance) |
| projected by the gate | 0.639 BZZ for 27 min, against 19.6 min of broadcast actually used |
| cumulative | **1.9814 of the 2.4000 BZZ authorised**, 0.4186 left |

⭐ The ledger was **not** rewritten. It still measures against the 2026-08-13 baselines, so the ceiling
it enforces is the total the owner actually chose rather than a fresh allowance stacked on top.

## What this does not say

- **n=1 per condition counted.** A replicate is worth more than any caveat, and this is not one.
- **No CPU was sampled.** Still the named gap from 2026-08-13.
- **Nothing about many in-tab viewers.** One node per tab remains a hard constraint.
- The repaired floor check has now been proven to **write** and to **not write**. It has never yet
  fired **mid-arm** on a real sitting, because no floor was near one.
