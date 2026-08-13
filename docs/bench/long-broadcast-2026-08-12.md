# Six hours of continuous broadcast, and the only thing that moves is the stall ratchet

**Two soaks, 2026-08-12 night.** 118.6 minutes at the shipping profile (0.5s GOP) and 238 minutes at
the OBS default (2.0s GOP), both 720p 2500 kbps, both watched in a real browser throughout, both with
**every bee-node metric sampled every 120 seconds**: 60 and 119 readings.

⭐⭐⭐ **The longest run this project had ever done before tonight was ten minutes.**

## ⭐⭐⭐ The finding: one stall in four hours costs a viewer a permanent second

| | **0.5s GOP, 2h** | **2.0s GOP, 4h** |
| --- | ---: | ---: |
| samples, all sound | 6,974 | 13,983 |
| **buffer stalls** | **0** | **1** |
| rebuffers | 0, 0 ms | 1, 195 ms |
| **player's own target** | **held at 6.00s** | **steered to 7.00s, permanently** |
| frozen samples | 0 | 0 |
| advance ratio, whole session | 1.000 | 1.000 |
| fatal errors | 0 | 0 |
| latency on joining | 6.26s | 6.38s |
| latency median | 5.20s | 5.38s |
| **latency best** | **3.08s** | **5.03s** |
| latency worst | 18.01s | 20.01s |

**The 2.0s publisher stalled once in four hours and paid a second of latency for the rest of the
session.** hls.js adds `min(stallCount * liveSyncOnStallIncrease, targetduration)` to its target and
`stallCount` only falls back to zero on a fresh manifest load, so the raise never comes back. The
mechanism was derived from source on 2026-08-07; **this is the first time it has been watched firing
in the wild**, and it took hours of exposure to catch it.

⭐ **Nothing else in the report shows it.** Rebuffers, frozen samples and fatal errors can all read
zero while the target has moved, because a stall need not fire a `waiting` event.

## ⚠️ And the shipped 6s buffer hides most of the GOP's advantage

Median latency is nearly the same, **5.20s against 5.38s**, because both are pinned by the 6s buffer
target rather than by the GOP. The GOP shows up in **best** latency, 3.08s against 5.03s, which is the
segment-duration arithmetic: a 2.0s publisher can never get as close to live.

⭐ Read beside #87, which found the 6s buffer can be cut to 2s for nothing measurable, this says the
two changes **compound**: the buffer is what a viewer is currently paying, and the GOP is what decides
how close they could get once it is cut.

## ⚠️ What these two runs cannot settle

- **They are not interleaved.** 0.5s ran 18:31-20:30 and 2.0s ran 20:36-00:35, so time of night and
  network conditions are confounded with the axis. Every within-sitting comparison below is safe; the
  between-sitting one is n=1 each.
- **Different lengths.** The 2.0s run had twice the exposure, so twice the chance to stall. One stall
  against zero is a weak count on its own, and it is the mechanism that makes it worth reporting.

---

# Nothing degrades over four hours

**2026-08-12 night, funded, 1.5501 BZZ uploader and 1.2633 gateway, 14 postage buckets.** Task #89.
One unbroken 720p broadcast at the shipping profile (2500 kbps, 0.5s GOP), 7,115 seconds, watched in
a real browser throughout, with **both bee nodes sampled every 120 seconds: 60 readings**.

⭐⭐⭐ **The longest run this project had ever done before tonight was ten minutes.** Every statement
about a longer broadcast was a projection from a synthetic fill. This is twelve times that, and it is
the first time the nodes' own account of a run has been recorded alongside the viewer's.

## The result: flat, on both runs, on every counter

**0.5s GOP, four windows of ~30 minutes:**

| window | push-sync | push errors | retrieval | peers asked | retrieval failures | uploader | gateway |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0-30 min | 11.8 ms | 5.6% | 25.4 ms | 1.59 | 4.9% | 0.80 BZZ/hr | 0.61 |
| 30-60 min | 11.2 ms | 3.9% | 27.5 ms | 1.60 | 4.8% | 0.75 | 0.65 |
| 60-90 min | 11.2 ms | 6.2% | 27.2 ms | 1.62 | 4.9% | 0.79 | 0.64 |
| 90-120 min | 11.9 ms | 4.8% | 29.0 ms | 1.66 | 5.0% | 0.80 | 0.67 |

**2.0s GOP, four windows of ~59 minutes:**

| window | push-sync | push errors | retrieval | peers asked | retrieval failures | uploader | gateway |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0-59 min | 15.4 ms | 4.6% | 32.0 ms | 1.42 | 1.7% | 0.70 BZZ/hr | 0.59 |
| 59-118 min | 15.1 ms | 4.7% | 32.2 ms | 1.41 | 1.7% | 0.71 | 0.58 |
| 118-178 min | 14.6 ms | 4.6% | 32.4 ms | 1.46 | 1.7% | 0.71 | 0.60 |
| 178-237 min | 15.1 ms | 4.8% | 30.5 ms | 1.43 | 1.7% | 0.71 | 0.60 |

**Nothing that matters moves, on either run.** Push-sync flat to a rounding error, retrieval failure
rate flat to a tenth of a point, cost per hour flat on both nodes.

⭐ **The one drift flagged in the two-hour run does not survive.** Retrieval time there rose 25.4 to
29.0 ms and peers asked 1.59 to 1.66, and I wrote that whether it plateaus is what the four-hour run
is for. It is flat at ~32 ms and ~1.43 peers for four hours. **That drift was noise.**

## ⚠️ The 2.0s GOP retrieves more reliably, and this is not the axis anyone was sweeping

**1.7% of retrievals failed outright against 4.9%**, and it asks fewer peers per request, 1.43 against
1.62. Larger segments mean fewer, larger fetches. ⛔ The two runs are sequential rather than
interleaved, so this is n=1 each and confounded with time of night, but a 2.9x gap that holds across
all four windows of both runs is worth a designed test rather than a footnote.

## Over the whole soak

| | |
| --- | ---: |
| chunks push-synced | **789,015** at 11.5 ms mean |
| push errors, retried | 40,737, 5.2% of pushes |
| unsynced backlog | **0 → 0** |
| invalid stamps | **0** |
| retrieval requests | **666,461** at 27.3 ms mean |
| retrievals failed outright | 32,749, 4.9% |
| invalid chunks retrieved | **0** |
| `segmentsSkipped` | **0 → 0** |
| `segmentsNeverNamed` | **0 → 0** |
| `maxConsecutiveSegmentFailures` | **0 → 0** |
| postage | 215 → 229 of 512 buckets, 7.1 per broadcast hour |

⭐ **The uploader dropped nothing across two hours and 789,015 chunks.** `segmentsSkipped`,
`segmentsNeverNamed` and `maxConsecutiveSegmentFailures` all held at zero, and the unsynced backlog
never left zero, so the write path kept up with a live encoder for the whole run without queueing.

## ⭐⭐⭐ What this changes about cost, which is the finding with the widest reach

**0.78 BZZ per broadcast hour on the uploader, 0.64 on the gateway**, and flat.

⛔⛔⛔ **RETRACTED 2026-08-13: the per-broadcast premium this section claimed does not exist.**

It said the arm sitting three hours earlier cost **2.06 BZZ per broadcast hour** idle-to-idle against
this soak's 0.78, and attributed the difference to its eight broadcast starts against this one's
single start, fitting roughly **0.15 BZZ per broadcast**. That went straight into the funding gate.

**The 2.06 is not reproducible from the node's own chequebook.** The arm sitting's snapshots bracket
48.1 of its 48.5 minutes and record **0.5650 BZZ, which is 0.70 BZZ per broadcast hour with eight
starts inside it**, cheaper per hour than this soak with one. There is no spend outside the window,
because the chain log puts the sitting at 15:54:30 to 16:43:01.

Each of that sitting's six counted arms holds exactly one broadcast start, so the marginal rate
subtracts out and leaves the setup term alone. It came out between **-0.0089 and +0.0030 BZZ, five of
six negative**. The constant was fifty times the largest residue.

⭐⭐⭐ **So cost is per minute, and the rate depends on the GOP rather than on the arm count.** The
0.5s arms burned 0.76 to 0.81 BZZ/hr against this soak's 0.78, and the 2.0s arms 0.62 to 0.67 against
the four-hour soak's 0.71. Two designs, two GOPs, in agreement.

⭐ **Ten BZZ buys about twelve and a half hours of broadcast however it is divided.** Sixty short arms
and one long soak of the same total minutes cost the same, which reopens arm-heavy designs the wrong
constant was pricing out.

⚠️ **The lesson is the one this night already taught and I repeated anyway.** Three burn constants
were set in one evening and both refits were wrong, and the rule written down at the time was that
only a rate measured over a long continuous window and replicated inside it survives. The 0.15 was
fitted from a *difference between two windows* rather than measured in either, which is the same
mistake wearing different arithmetic. See `interleaved-gop-arms-2026-08-12.md`.

## What this sitting does not answer

- ⛔ **The four-hour figure itself.** This is two hours. The 14% retrieval drift has not been given
  long enough to show whether it plateaus.
- ⛔ **The viewer-side half is not in this document.** `#EXT-X-TARGETDURATION`, the stall count, the
  latency and the advance ratio come from the browser report in the same run directory and are read
  separately; nothing here should be quoted as a viewer's experience.
- **n=1.** One sitting, one box, one gateway, one browser. The four windows replicate the rate within
  the sitting, which is not the same as replicating the sitting.
- ⚠️ **Host load ran 7 to 11 of 48 cores** and roughly four of those were ours. A quiet night on a
  shared box, and the interleaving that usually defends against neighbours does not exist in a soak.

## Ledger

| | |
| --- | ---: |
| broadcast | 118.6 min |
| uploader | **1.5501 BZZ** |
| gateway | **1.2633 BZZ** |
| postage | 14 buckets |
| node-metric samples | **60** |
| arms lost | none, it ran to its own end with no floor crossed |
