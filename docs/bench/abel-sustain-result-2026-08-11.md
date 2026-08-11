# RESULT: a gateway-less browser node sustained 8.1 Mbps, and our ceiling was our segment size

**2026-08-11, run by the owner at a focused Chrome tab, mainnet, unfunded in-browser node, no gateway
in the path.** Prediction pre-registered in `abel-sustain-prediction-2026-08-11.md` before the run.

## The numbers

| | |
| --- | --- |
| stream | `abel-1`, owner `47535bf0…703d`, topic `d1e6072f…1a7a` |
| shape | 4.167s segments, 4.14 MB each, **8.34 Mbps** |
| peers at start | ✅ **200 connected / 0 connecting**, gate reported `full table` |
| samples | 698 over **719.4s** |
| playhead gained | **716.7s** |
| **realtimeRatio** | **0.9962** |
| stalls | **1**, lasting **1 second** |
| startup | 2.1s |
| **implied delivered** | **~1,014 KB/s** |

Both HLS events the console recorded (`bufferSeekOverHole` at `currentTime` 0.1,
`bufferStalledError` at 0.869) landed in the **first second**. There is no steady-state starvation in
this run at all.

## ⛔ The printed verdict says DOES NOT SUSTAIN. That is my threshold, not the stream.

The bar is 0.999 and the run returned 0.9962, so the harness printed a failure. The 2.7s deficit is
**2.1s of startup plus one 1s stall**. Startup is not starvation, and the probe already reports it
separately for exactly that reason.

Measured from the first frame: **716.7 / 717.3 = 0.99916**, which passes.

⚠️ **That reinterpretation was made after seeing the result and should be discounted accordingly.**
It is recorded here rather than quietly applied. The headline below does not depend on it: **1,014
KB/s sustained for twelve minutes is a byte rate, not a score**, and no threshold changes it.

## ⭐⭐⭐ WHAT IT OVERTURNS

**The in-browser throughput ceiling was never the node's. It was our segment size.**

| | KB/s | segment |
| --- | ---: | --- |
| c4, the concurrency a player uses | 235 | 90 KB |
| c16, the best aggregate ever measured | 410-467 | 90 KB |
| **abel-1 playback** | **~1,014** | **4,241 KB** |

**2.2x the best figure we had, and 4.3x the one that applies to a player.** weeb-3 caps segment loads
at 4 (`stream_hls.rs:3720`) but chunk retrievals at 2,048 (`lib.rs:321`). A 90 KB segment is ~23
chunks, so four in flight is ~92 chunks, **4.5%** of the semaphore that matters. Four of abel-1's
segments is ~4,240 chunks, which saturates it.

Every in-browser number this project holds was taken at 4.5% occupancy of the real limit.

## ⛔ Claims now withdrawn

1. **"A gateway-less browser node does not sustain 2.7 Mbps."** False as stated. The same node,
   unfunded and gateway-less, just sustained **8.34 Mbps**. What is true is that it does not sustain
   2.7 Mbps **delivered as 90 KB segments**.
2. **"A browser viewer can hold roughly 1.8 Mbps and below."** Withdrawn. That figure came from
   dividing a starved throughput by a bitrate, and it understates by at least 4x.
3. **"Bigger fragments are worse."** Already re-scoped to delivery-inside-a-deadline earlier today;
   this run settles the throughput direction. 173 consecutive 4.14 MB segments arrived on time.
4. **The prediction's own addendum**, which argued from `3.5 MB delivered 0/5` that abel-1 would land
   near 0.34. It was the worst call of the day, and it repeated the error the same document had just
   named: letting a delivery-inside-a-budget statistic answer a throughput question.

## ⛔⛔ What this does NOT establish

- **Content replication is not controlled and is now the leading open question.** abel-1 is a stream
  people watch; our 3.5 MB references were bench fixtures uploaded once and fetched 0/5. Size and
  replication are perfectly confounded here. **Timing one of Abel's segments against one of ours on
  the same node in the same minute would separate them, and costs nothing.**
- **n=1.** `abel-2` is in the harness for a replicate, though its segment shape is assumed.
- **The byte figure is derived**, not observed: `demanded x ratio`, where `demanded` comes from the
  4.14 MB segment size read from the manifest earlier. The playhead advance is directly measured; the
  byte rate inherits that one input.
- **Nothing about our shipping profile.** 1.0s segments at ~340 KB sit between the two points
  measured. That is now the most valuable next run and it has never been done.

## The instrument defects this exposed

1. **`realtimeRatio` charges startup against the stream.** With a 2.1s startup, a 12-minute run cannot
   reach 0.999 even with zero stalls (ceiling 0.9971). The ratio should be measured from first
   playhead advance, with startup reported beside it.
2. **`impliedDeliveredKBps` is config-derived and should say so in its own name**, since it is the
   figure most likely to be quoted.
