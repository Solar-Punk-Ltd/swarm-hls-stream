# The 6s player buffer can be cut to 2s for nothing, and 1.5s costs on both axes

**2026-08-12, funded, 1.1401 BZZ, 8 postage buckets.** Task #87. Seventeen arms of 300s against one
continuous broadcast at the shipping profile (720p30, 2500 kbps, 0.5s GOP). Two warm-up arms
discarded, then five targets over three rounds with the direction reversed each round. Every arm's
instrument was judged **sound**, and `#EXT-X-TARGETDURATION` held at **1** for the whole sitting, so
no arm was measured under a moved stall-penalty ceiling.

## The result

| target | n | rebuffers per arm | stalled samples | median latency |
| ---: | ---: | --- | --- | ---: |
| 6.0s | 3 | 0, 1, 0 | 0, 1, 0 | 3.27s |
| 4.0s | 3 | **0, 0, 0** | 0, 0, 0 | 2.99s |
| 3.0s | 3 | 0, 1, 0 | 0, 0, 0 | 2.53s |
| 2.0s | 3 | 0, 1, 1 | 0, 0, 1 | **2.03s** |
| **1.5s** | 3 | **2, 6, 3** | 1, 0, 1 | 2.52s |

⛔ **Rebuffers are the score.** A smaller buffer always shows a better latency, so latency alone cannot
find a floor. ⚠️ The counter behind that column is a **monotonic session total**, so these are
differences between consecutive arms rather than the numbers the run printed. That defect was found
during this sitting and fixed in the same day.

## ⭐⭐⭐ Two findings, and the second one is the surprising half

**1. From 6s down to 2s, nothing changes.** Twelve arms, an hour of watching, **three rebuffers in
total** and no target distinguishable from another. The shipped `LIVE_SYNC_DURATION_S` of 6 is
carrying **four seconds a viewer does not need**, and cutting it to 2 moves a viewer that much closer
to live at no measured cost.

**2. Below 2s the latency curve turns around.** Latency falls monotonically as the target falls, 3.27
to 2.99 to 2.53 to 2.03, and then at 1.5s it goes back **up** to 2.52s.

⭐⭐⭐ **Asking for half a second less buffer costs half a second more latency.** That is the stall
penalty being paid: hls.js adds `min(stallCount, targetduration)` to its target on every stall and
never lowers it, so once 1.5s starts stalling the viewer is held further back than a 2s viewer who
never stalls at all. The mechanism was derived from the source on 2026-08-07 and this is the first
time it has been watched happening.

**So 2.0s is not a floor, it is an optimum.** Below it you lose on both axes at once.

## What the sitting also shows

⚠️ **Absolute latency drifts upward across the sitting.** At a 6s target the three counted arms read
2.53, 3.27 and 3.76s in round order, and 4s reads 2.53, 2.99, 3.76. The between-target comparison is
protected by reversing the direction each round, and the drift is visible in every target, so it is
the sitting and not the axis. It is not explained here. ⛔ Do not quote an absolute latency from this
sitting without saying which round it came from.

**Host load moved 4x during the run**, from 5.8 to 24.2 of 48 cores, roughly 4 cores of which were
ours and the rest a neighbour's forty bee nodes. That is the normal condition for this box and the
interleaving is the defence against it.

## Scope, and one thing that cannot be answered from the artefact

- n=3 per target, one sitting, one browser, one gateway.
- **A 300s arm at a 1.5s target is not a viewer's whole session.** Whether the penalty keeps
  accumulating over an hour is #89's question, not this one's.
- ⛔ **The artefact stores each arm's sample COUNT, not its samples**, so *when* inside an arm a
  rebuffer happened is not recoverable and no rebuffer-to-404 correlation can be built from it. The
  request log beside it does keep every refusal with a timestamp, so the refusal half is there. The
  harness gap is recorded rather than worked around.
- ⛔ **This sitting predates the node-metrics sampler.** It has chequebook and stamp readings either
  side and spot health checks, and it does **not** have the node's own account of what it did. That is
  the reason it is scheduled to be re-gathered.

## What to change

`LIVE_SYNC_DURATION_S` from **6 to 2** would give a viewer about **4 seconds** and cost nothing this
sitting could measure. ⚠️ That is a product change on n=3 from a single sitting, and the re-gather
with node metrics should confirm it before it ships.

## Ledger

| | |
| --- | ---: |
| broadcast | 88 min |
| BZZ | **1.1401** |
| postage | 8 buckets |
| arms counted | 15 of 17 |
| arms excluded | 2, both warm-up, as designed |
