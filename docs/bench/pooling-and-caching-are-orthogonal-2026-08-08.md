# Pooling and caching are orthogonal, and they compose

**2026-08-08, 11:29 to 11:32 UTC.** Four arms on an unfunded gateway, **16 concurrent viewers** in
every arm, cache off and on alternated across two rounds, each arm walking the same 100 references
**twice**. **Cost: nothing.**

Two findings from earlier the same day looked like they might overlap.
[Sixteen viewers share a gateway's fetches](sixteen-viewers-cost-what-one-costs-2026-08-08.md) almost
completely, and [a cache halves network retrievals](what-a-viewer-node-costs-in-cpu-2026-08-08.md). If
concurrency already collapses the fetches, a cache might add nothing on top. **It adds a lot, because
the two collapse different things.**

## ⭐⭐ The answer

| arm | cache | pass 1 median | **pass 2 median** | retrieval ops | **network contacts** | **CPU per MB** | arm seconds |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| round 1 | off | 116ms | 122ms | 80,015 | **7,301** | 0.309 | 28 |
| round 1 | **on** | 102ms | **5ms** | **40,552** | **2,664** | **0.176** | **17** |
| round 2 | off | 106ms | 113ms | 78,434 | **6,744** | 0.281 | 35 |
| round 2 | **on** | 110ms | **4ms** | **39,772** | **3,340** | **0.192** | **16** |

⭐ **Pass 1 is unaffected in every arm** (116, 102, 106, 110ms). That is the honesty check: the first
fetch of a reference is a real network retrieval either way, and it also proves the cache is genuinely
purged between arms rather than surviving into the next one.

⭐ **Pass 2 goes from 113-122ms to 4-5ms**, about **25x**.

⭐ **Retrieval operations halve exactly** and **network contacts halve** (mean 7,023 to 3,002).

⭐ **CPU falls 1.6x** and **the arm finishes in half the wall-clock time**, 16-17s against 28-35s.

## Why they do not overlap

⭐⭐ **Pooling collapses requests across viewers. Caching collapses requests across time.**

- **Pooling** merges the sixteen viewers who ask for chunk X **at the same instant** into one network
  fetch. It is why 16 viewers cost the network what one costs.
- **Caching** merges the request for chunk X **now** with the request for chunk X **later**. Pass 2 is
  exactly that, and no amount of concurrency helps it.

A live event has both. Many viewers watching together is the pooling case. A viewer who joins late, or
re-fetches after a stall, or scrubs back through the DVR window, is the caching case. **They are
independent axes and a deployment should take both.**

## The combined effect

| | CPU per MB | against a lone unfunded viewer |
| --- | ---: | ---: |
| 1 viewer, no cache | ~3.5 | 1x |
| 16 viewers pooled, no cache | 0.295 | **11.9x cheaper** |
| **16 viewers pooled and cached** | **0.184** | **19x cheaper** |

⭐ **19x, and every step of it is free to adopt.** Pooling is a topology choice and caching is one
compose flag that is currently set to zero.

## ⚠️ What this does not show

⚠️ **It does not show the cache reducing the late share.** The cache-off arms came in at 1.0% and
10.7%, the cache-on arms at 1.2% and 0.0%. With two arms each and an unfunded node whose spread on
identical work reaches tenfold, that comparison carries no weight. **What carries weight is retrievals,
contacts, CPU and wall clock, all of which moved consistently in both rounds.**

⚠️ **The working set here is 100 references fetched twice inside a minute.** A real broadcast's working
set is the whole live window across the whole event, and nothing has measured what happens when it
exceeds `--cache-capacity`. That is the next question this opens.

⚠️ Unfunded gateway, 0.25s profile, one host.

## Artifacts

`/home/solarpunk/retrieval-probe/pool1/`. Probe: `deploy/scripts/retrieval-debt-probe.sh`. Gateway
restored to `--swap-enable=true` and `--cache-capacity=0` and confirmed on the node.
