# What an in-tab node costs, and what it saves, 2026-08-14

> ## ⛔⛔⛔ WHAT THE CLIENT UNDER TEST ACTUALLY WAS, AND WHO CHOSE IT
>
> The `weeb3` arms here fetch **segment bytes only** from the in-tab node. The feed and every
> manifest still come from a **bee gateway**, in both conditions. Verified in source: `ManifestManagement`
> has no weeb-3 path, only `CustomManifestLoader` does.
>
> That split was my design decision in PR #183 and **nobody authorised it**. The owner's instruction
> of **2026-08-11T07:07Z** was *"Abel optimized the player as much as possible let's measure and
> experiment with his setup as it is"*, and this is not that.
>
> ⛔ **So any residual gateway load reported below is a floor THIS CLIENT imposes, not one weeb-3
> imposes.** Abel's own live page drives it to zero, proved free on 2026-08-16. Every saving figure
> here is a **lower bound** on what an in-tab node can do.
>
> ✅ **The arithmetic and the arm-to-arm contrasts are unaffected.** Both conditions read the
> manifest the same way, so the comparison is clean. What is limited is the **subject**, not the sums.
>
> See [`abel-gateway-less-live-2026-08-16.md`](abel-gateway-less-live-2026-08-16.md).

**Six counted arms on one live broadcast at a 0.5s GOP and a 2.0s target, 1.109 BZZ.** The retrieval
saving replicates for the third time and the CPU price is measured for the first time. Both separate
with **zero overlap between the conditions**.

Three harness defects were found and fixed before this sitting spent anything, and a fourth
instrument gap was closed on the owner's prompting. They are recorded below the result because two of
them change how earlier sittings should be read.

## The result

Arms 1 and 2 are the warm-up round and are discarded, which is the rule this harness has carried
since the 2026-08-11 sittings. Arm order was `AB AB BA BA`, the counterbalance that seams once.

| | gateway arms | weeb3 arms | |
| --- | --- | --- | --- |
| gateway retrieval requests | 40,242 / 40,308 / 39,959 | 1,609 / 1,434 / 1,724 | **25.3x fewer** |
| browser CPU, mean cores | 1.20 / 1.16 / 1.23 | 1.85 / 1.78 / 1.81 | **1.51x more** |
| browser CPU, peak cores | 2.14 / 2.02 / 2.25 | 3.89 / 4.09 / 3.42 | **1.78x more** |
| seconds behind live | 2.03 / 1.57 / 1.91 | 2.03 / 2.06 / 2.04 | 0.20s apart |
| stalls | 0 / 0 / 0 | 0 / 0 / 0 | none anywhere |
| latency target | held at 2s, max 4s | held at 2s, max 4s | held in all 8 |

⭐⭐⭐ **No value from either condition lands inside the other on either axis.** The lowest gateway-arm
retrieval count is 39,959 against the highest weeb3 arm's 1,724, and the highest gateway-arm CPU mean
is 1.23 cores against the lowest weeb3 arm's 1.78.

**The trade, stated once:** putting a Swarm node in the viewer's tab cuts what the gateway is asked
for by 25x and costs the viewer's machine about **0.6 of a core**, with the peak moving from 2.1 to
3.8, at 1280x720 and 2500 kbps.

### 2.0s now has three agreeing observations

| sitting | counted arms | retrieval ratio |
| --- | --- | --- |
| 2026-08-13 three-target | **6** (n=3 per condition) | 20.3x |
| 2026-08-14 morning | **2** (⚠️ **n=1 per condition**) | 20.5x |
| **this one** | **6** (n=3 per condition) | **25.3x** |

⛔ **This column read "4" and "4" and both were wrong, in opposite directions.**
`uncensored-latency-2026-08-13.md` records eight arms of which six are counted, n=3 per condition.
`the-sampler-that-never-ran-2026-08-14.md` records four arms of which **two** are counted, and states
n=1 per condition in its own words. ⚠️ **The middle row is a single arm per condition**, which matters
for reading the spread below.

⚠️ Three observations of the same direction and rough magnitude. They are not four repeats of one
number, and the spread across them (20.3 to 25.3) is wider than the spread within this sitting.

## ⛔ What the weeb3 arms' gateway latency is NOT

A weeb3 arm leaves the gateway answering 218-240ms per request against a gateway arm's 30-38ms, at
14.5-15.6 peers asked against 1.7, failing 24-26% against 5%.

**That is composition and not quality, and it must never be tabled as a latency comparison.** With
segment traffic gone, what remains on the gateway during a weeb3 arm is feed-head lookups, which are
the announcement floor: they are expected to miss roughly half the time and cost about 480ms when
they do. The gateway is not slower during a weeb3 arm. It is being asked a different, harder question
and almost nothing else.

## The sitting, whole

| | |
| --- | --- |
| window | 3,895s, arms took 3,740s of a 4,520s broadcast |
| uploader | 411,307 chunks push-synced, mean 11.0 ms, 4.2% retried |
| gateway | 168,117 retrieval requests, mean 42.4 ms, 2.22 peers, 5.8% failed outright |
| uploader spent | 0.8115 BZZ, **0.75 BZZ per broadcast hour** |
| gateway spent | 0.2975 BZZ, **0.27 BZZ per broadcast hour** |
| postage | batch `7849851f` 287 → 293 of 512 buckets, **6 buckets for 65 minutes** |
| health | 0 segments skipped, 0 never named, 0 max consecutive failures |
| host load | 0.83 → 5.31 of 48 cores |
| byte-source gate | all 8 arms `fetched only from http://127.0.0.1:10077` |

⭐ **Postage is a real per-broadcast-hour cost and has never been counted.** 6 buckets for 1.08
broadcast hours is 5.6 buckets/hour, against the 6.4 the capacity gate assumes, so the gate is
slightly conservative. A fresh depth-25 batch costs 3.96 BZZ per day of TTL and carries about 60
broadcast hours to the 75% stop line, which is roughly **0.66 BZZ per broadcast hour amortised**,
comparable to the 0.75 the uploader's chequebook pays.

## ⛔⛔⛔ The instrument gap the owner caught, and what it immediately found

`node-metrics.sh` piped both nodes' `/metrics` through an allowlist of thirteen families before
storing anything. Measured against the live nodes, that kept **255 of 1032 non-bucket lines on the
uploader and 218 of 988 on the gateway**. Reading the whole surface gives **482 and 444 series**.

Entirely absent from every snapshot this project has ever taken: all `go_*` series, so the node's own
heap, goroutines and GC, and all `libp2p_*` series, so connection and file-descriptor pressure. bee
publishes those rather than the `process_*` and `bee_p2p_*` names one might go looking for.

The comment defending the allowlist argued it was by family rather than by name so that an
unanticipated analysis would not be blocked. It was still an allowlist. Two of the three families
from the 2026-08-12 wrong-cause incident had simply been **added to it** afterwards, which is the
tell: a list that grows one incident at a time is a list that is always one incident behind.

Capturing more is only half the rule, so `node_metrics.py diff-all` now ranks **every** series that
moved, by relative movement, filed beside the curated diff for every arm in every driver.

### What it found in this sitting

**`bee_localstore_cache_size` on the gateway is negative in every arm, and moves systematically.**

```
-1303 -> -5580   gateway arm
-5580 -> -4373   weeb3 arm
-4373 -> -2684   weeb3 arm
-2684 -> -1465   weeb3 arm
-1465 ->  -399   gateway arm
 -399 -> -4648   gateway arm
-4648 -> -3348   weeb3 arm
-3348 -> -1844   weeb3 arm
```

It plunges by roughly 4,200 during a gateway arm and recovers 1,200-1,700 during a weeb3 arm. A cache
size is definitionally non-negative.

⚠️ **This is an observation and not a conclusion.** `bee_localstore_*` was inside the old allowlist,
so it was captured all along and never rendered, which is precisely why capture and ranking are two
separate halves of one rule. **The action is to check whether any cache-sizing result read this
counter before trusting either it or them**, not to withdraw anything yet.

✅ **RESOLVED the same day, free, in `the-gateway-cache-is-a-sawtooth-2026-08-14.md`.** No result of
ours reads that counter, so nothing is withdrawn. The negative is bee's own underflow, and our gateway
sits in the corner that produces it because `--cache-capacity=0` is the one value where every cached
chunk is over capacity and each round is then asked to drop a hard-coded minimum of 10,000. **The
gateway's cache is neither on nor off, it is a sawtooth**, which reconciles the 2026-08-10 two-pass
result (4ms, cache plainly on) with the 2026-08-08 cyclic scan (0.0% removed, cache plainly doing
nothing) without either being wrong.

**A second, smaller one:** `libp2p_rcmgr_*` gauges read 0 on a first scrape and populate on the
second, so the first bracket of any sitting shows them as enormous relative movers. That is
registration, not movement, and it is why the ranking is read rather than quoted.

## The three defects fixed before the sitting spent anything

**1. A deposit silently erased spend history from the ledger.** The spend gate clamps a risen balance
to zero spend, which is right, but that made the gateway's real 0.5406 BZZ vanish from the count when
it was topped up. After the uploader was topped up too it would have printed **`0.000 BZZ already
spent`** against a ceiling 1.98 of which was gone. `availableBalance` has no way up except a deposit,
and a deposit means the baselines predate it, so it now refuses rather than under-counting.

**2. Three of the four drivers that spend had no spend ceiling at all.** PR #179 put the *capacity*
gate in all three; the spend ceiling only ever landed in `byte-source-arms.sh`.
`gateway-funding-arms.sh`, `viewer-arms.sh` and `phase06-light-vs-ultralight.sh` all publish and all
carried only `can_afford`, which asks whether the node **can** pay and so authorises the whole
balance. Writing the tests turned up that phase06 at its defaults is a **142 minute, 3.37 BZZ**
sitting.

**3. A broadcast the harness stops still reported itself failed.** `docker inspect` on a removed
container writes a blank line to stdout *and* exits non-zero, so the `|| echo missing` guard appends a
second line and the value is `"\nmissing"`. The equality against `missing` missed, and a stop the
harness asked for printed `Nothing usable was broadcast, so do not measure against this`. PR #188
removed that alarm from one path; this was the other. This sitting ended with `✓ publish stopped on
request after 3746s`, which is the fix confirmed on a real broadcast.

## The floor check, proven mid-arm for 0.0190 BZZ

The repaired mid-arm floor check had never been shown to fire on a live broadcast. Forced to a 14 BZZ
reserve against a gateway holding 13.52:

| | |
| --- | --- |
| 08:50:35 | sampler writes STOP: `gateway available 13.5181 BZZ is under the 14.00 reserve` |
| 08:50:40 | `a floor was crossed mid-arm, stopping the broadcast now and letting the watch write out` |
| | publisher gone in **5 seconds**, exactly `STOP_POLL_S`, watch survived and wrote out |
| 08:54:56 | `STOPPING before arm 2: an earlier reading crossed a floor` |

Both directions of the control, on a paid broadcast, for less than a fiftieth of a BZZ.

## What this does not answer

⛔ **Saturation.** `docker stats` reads the container's whole cgroup, which is the right total for
what a viewer costs a machine. It cannot say whether weeb-3 is *out* of CPU, because the node is one
JS thread by construction and a 3.8-core peak on a 48-core box says nothing about one thread. That
needs `Performance.getMetrics` over CDP against the page target, which `chrome-cpu.mjs` already does
and this sitting does not use.

⚠️ **A single machine.** Every CPU figure here is from one browser container on a 48-core host with
nothing competing for a core. What a laptop does at 1.8 cores mean and 4.0 peak is a different
question.

⚠️ **One quality.** 1280x720 at 2500 kbps. The CPU price of an in-tab node at 1080p is unmeasured.
