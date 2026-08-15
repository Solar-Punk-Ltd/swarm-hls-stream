# The container total was flattering the in-tab node, by almost exactly 2x

**2026-08-14, one live broadcast, six counted arms, 1.095 BZZ.** Task #103.

## The question, and why the previous answer could not settle it

The 2026-08-14 sitting priced an in-tab Swarm node at **25.3x fewer gateway retrievals for 0.6 extra
cores**, peak 2.1 → 3.8. Both figures came from `docker stats`, which is the right instrument for
"what does a viewer cost a machine": the cgroup is the whole process tree.

It cannot answer the next question. **weeb-3 is one JS thread by construction**, nineteen runtime
loops cooperatively interleaved in a single `join!` with no workers, and in our shipped path
`Weeb3FetchBackend` calls `retrieveBytes` directly on the page rather than through the package's
service worker. A 3.8-core peak on a 48-core box says nothing about whether that one thread is full.
A viewer at 0.35 of its thread and a viewer at 0.98 are indistinguishable from outside and are
completely different products.

`Performance.getMetrics` reports `TaskDuration`, cumulative seconds the page's main thread spent in
tasks. Its slope against wall time **is** that thread's utilisation, with no scaling and no model.

## Design

Identical to the sitting it extends, so the two are directly comparable: **one live broadcast**, 0.5s
GOP, 720p at 2500 kbps, 2.0s target latency, one client build with the byte source switched at
runtime, counterbalanced `AB AB BA BA`, first round discarded. Only segment bytes move between arms.
The catalog, feed and manifest come from the gateway in both.

## Result

| arm | cond | retrievals | cores | corePeak | **thread** | **thrPeak** | stalls | behind live |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | gateway | 40,324 | 1.13 | 2.04 | 0.070 | 0.143 | 0 | 2.26s |
| 6 | gateway | 40,360 | 1.23 | 2.04 | 0.072 | 0.148 | 0 | 2.03s |
| 8 | gateway | 40,043 | 1.21 | 2.29 | 0.074 | 0.146 | 0 | 2.03s |
| 4 | weeb3 | 1,597 | 1.89 | 4.78 | 0.235 | 0.615 | 0 | 2.03s |
| 5 | weeb3 | 1,724 | 1.80 | 4.16 | 0.221 | 0.641 | 0 | 2.03s |
| 7 | weeb3 | 1,849 | 1.79 | 2.74 | 0.218 | 0.545 | 0 | 2.02s |

**Zero overlap on both thread axes. Zero stalls in all six arms.** Every arm reported
`complete: true`, meaning no unsampled target in the browser could run script, so the sampled thread
is the only one our code could have been running on.

### ⭐⭐⭐ The headline

| | gateway | weeb3 | ratio |
| --- | ---: | ---: | ---: |
| **main thread, mean** | 0.072 | 0.225 | **3.12x** |
| **main thread, peak** | 0.146 | 0.600 | **4.12x** |
| container cores, mean | 1.190 | 1.827 | 1.54x |
| container cores, peak | 2.123 | 3.893 | 1.83x |
| gateway retrievals | 40,242 | 1,723 | **23.4x fewer** |

**The main-thread ratio is 2.03x the container ratio.** A gateway viewer spreads its work over
threads and processes a 48-core box absorbs without noticing. weeb-3 concentrates its share on the one
thread that cannot scale, so **the container total understates the in-tab cost exactly where it
binds**. Every CPU figure published for this path before today was measured on the axis with slack.

### Where the extra CPU actually lands

Per arm, over ~423s of wall clock, from the same readings:

| | gateway | weeb3 | weeb-3 adds |
| --- | ---: | ---: | ---: |
| renderer CPU (`ProcessTime`) | 152.9s | 271.4s | **118.5s** |
| main thread (`TaskDuration`) | 30.6s | 94.8s | **64.2s** |
| whole container | 1.190 cores | 1.827 cores | **0.637 cores** |

- **54% of the extra RENDERER CPU lands on the main thread** (64.2 of 118.5s).
- **24% of the extra CONTAINER CPU lands on the main thread** (0.153 of 0.637 cores).
- ⚠️ So **roughly half the extra container cost is outside the renderer altogether** (0.637 cores
  against 0.280 in the renderer). The likely home is the browser's network service, which carries
  weeb-3's peer connections. **That is a hypothesis, not an attribution**: CDP measures the renderer
  and `docker stats` measures the tree, and nothing here measured the processes in between.

### A regularity worth recording

The gateway arms put **0.800188, 0.800319 and 0.799652** of renderer CPU off the main thread. Three
arms agreeing to four decimal places is not something this project usually sees, and it is what makes
the contrast trustworthy rather than a story about noise. weeb-3 moves that share from 20% to
**33-36%**.

## ⛔ What this does NOT say

- **It is not a saturation result.** Peak 0.60 of one thread at 720p is comfortable. Nothing here was
  measured near a ceiling, and no arm stalled.
- **The latency column still cannot rank the conditions.** Every arm landed 2.02-2.26s behind live
  against a 2.0s target. That reproduces the 2026-08-13 finding for a third time and is not new.
- ⚠️ **720p 2500 kbps only, n=3 per condition, one broadcast, one machine.**

## ⭐ The decision it changes: 1080p in the tab is now a question, not an assumption

1080p costs roughly **2.3x** the bytes of this profile. **If** main-thread work scales with bytes,
which is plausible because weeb-3's retrieval work is per chunk, the mean goes 0.225 → **0.52** and
the peak 0.600 → **1.38**, which is more than one thread can supply.

⛔⛔ **That is an extrapolation and it is written here so it is measured rather than assumed.** The
container figures would have predicted 3.9 → 9.0 cores on a 48-core box and raised no concern at all.
An arm at 1080p with this instrument attached is the cheap way to settle it, and it is the first
thing to book if the in-tab path is proposed above 720p.

## The instrument found a defect in itself, on arm 1

The sampler declined arm 1 entirely, and would have declined every arm of both sittings. `awaitTarget`
waited **ten seconds** for a page whose URL contains `/watch/`, and the client is a **hash router**:
the target list answers with the bare origin until the app has booted. Fixed in **#196**, window now
240s.

⭐⭐⭐ **The proof before merge used a Chrome already navigated to the watch route**, which is the one
arrangement where a too-short wait is invisible. Recorded as gate lesson AIC: *ask of every proof which
step you did by hand that the real caller has to wait for.*

⭐ **Recovery cost nothing.** Each arm starts a fresh sampler container mounting the checkout, so the
fix was picked up mid-sitting with no restart, and the only arm that lost its column was a discarded
warmup arm. The refusal is why this is recoverable at all: it says
`the thread's use is UNKNOWN and not zero` rather than reporting an idle thread.

## Cost, and a cross-check that came free

**1.095 BZZ** over 65 minutes: uploader 0.788 (0.73 BZZ/hr), gateway 0.307 (0.28 BZZ/hr). One postage
bucket per arm, batch `7849851f` at 297/512 and 9.4 days.

⭐ **The gateway spent 0.28 BZZ/hr against the 0.64 the funding gate models**, a gap that appears
because half the arms never ask it for a segment. The byte-source saving therefore shows up
**independently in the chequebook**, on an instrument nobody designed to detect it.

## Provenance

`~/overnight/2026-08-14-night/cdp-saturation/` on the deployment host: per-arm `*-mainthread.jsonl`,
`*-cpu.txt`, node-metrics snapshots either side of every arm and of the sitting, and whole-surface
diffs. Both chequebook floors and the 75% postage line were armed and sampled every 30s throughout,
and neither was approached.
