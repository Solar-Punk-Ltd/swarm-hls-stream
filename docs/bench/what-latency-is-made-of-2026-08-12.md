# Capture-to-fetchable decomposed: a duration you wait out and bytes you then move

**2026-08-12, free.** Derived from the six arms of `gop-floor-replicate-2026-08-12.md`, which were
already paid for. No new broadcast.

Every latency comparison this project has made between two GOPs has moved **two things at once**:
the segment gets longer and it gets bigger. `#84` exists to separate them. It turns out the reports
already carry the separation, in the per-hop split nobody had read across arms.

## The six arms, by hop

| GOP | segment | total | total − segment | upload | manifestPublish | feedPropagation | **fetch** |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.25 | 266 | 1021 | 755 | 239 | 192 | 42 | **278** |
| 0.25 | 266 | 983 | 716 | 227 | 189 | 38 | **249** |
| 0.25 | 266 | 1007 | 740 | 225 | 192 | 42 | **260** |
| 0.5 | 500 | 1550 | 1050 | 274 | 223 | 44 | **497** |
| 0.5 | 500 | 1553 | 1053 | 280 | 223 | 42 | **504** |
| 0.5 | 499 | 1548 | 1049 | 269 | 220 | 42 | **505** |

Medians in ms, n = 86 to 373 samples per arm.

## What each hop is doing

**`segment` is not a measurement, it is arithmetic.** `capturedAtMs` anchors the segment's **first**
frame, so `totalMs` cannot be smaller than the segment's own duration: the first frame waits for the
last one before anything can be uploaded. It tracks the GOP exactly, 266 and 500.

⭐⭐ **`fetch` is the hop that scales, and it scales with BYTES.** 249-278 ms at ~110 KB against
497-505 ms at ~200 KB. Roughly **2.0x the time for 1.8x the bytes**, and tight within each arm across
three replicates.

**`upload` scales weakly**, 230 to 275 ms for the same 1.8x. **`manifestPublish` (190 to 222) and
`feedPropagation` (40 to 43) are close to constant**, which is what they should be: a feed slot is a
few KB whatever the segment is.

## ⭐⭐⭐ So the GOP penalty is not mysterious

`small-gop-wins` measured a 2.33s gap between a 0.5s and a 2.0s GOP and reported it as a latency
result. It decomposes:

| | |
| --- | ---: |
| segment duration, pure arithmetic | **1.50s** |
| everything else, mostly `fetch` scaling with bytes | **0.83s** |

⭐ **Two thirds of the penalty for a long GOP is the segment you have to wait out**, and no network
improvement can touch it. The remaining third is bytes moving, which is the part a faster gateway or
smaller pictures would help.

That is a better sentence for a broadcaster than "a 2.0s GOP costs you 2.33 seconds", because it says
which part is physics and which part is engineering.

## The model this implies, stated so #84 can break it

```
totalMs  ≈  segmentDurationMs  +  k × segmentKB  +  c
```

with `k ≈ 2.4 ms/KB` in the `fetch` hop plus a weaker byte term in `upload`, and `c ≈ 250 ms` of
manifest publish and feed propagation that does not care about either axis.

⛔ **Bytes and duration are still confounded in every row above**, because bitrate was fixed at 2500
kbps throughout, so a longer segment was also a bigger one. The model is a reading of the hops, not a
test of it.

## What #84 should now do, and what it should predict

The grid separates them by construction. At 720p with segment bytes as `kbps × seconds / 8`:

| GOP | 1250k | 2500k | 5000k |
| ---: | ---: | ---: | ---: |
| **0.5** | 78 KB | 156 KB | **312 KB** |
| **1.0** | 156 KB | **312 KB** | 625 KB |
| **2.0** | **312 KB** | 625 KB | 1250 KB |

⭐⭐⭐ **The anti-diagonal is the experiment.** `0.5s@5000k`, `1.0s@2500k` and `2.0s@1250k` are the
**same 312 KB at three durations spanning 4x**. Two more matched pairs sit at 156 KB and 625 KB.

**Predictions, registered before spending:**

1. **`fetch` is flat across the 312 KB triple**, within the spread each arm shows for itself. If it
   tracks duration instead, the model above is wrong and the bytes reading of `fetch` goes with it.
2. **`totalMs` across the triple separates by almost exactly the duration difference**: about 1750,
   2250 and 3250 ms for 0.5, 1.0 and 2.0. This is the model's arithmetic and it is easy to refute.
3. **Down each column**, at fixed duration, `fetch` rises roughly linearly with bytes at about
   2.4 ms/KB.
4. ⚠️ **The 1250 KB cell may fail its axis check.** 5000 kbps at 720p is twice anything measured here,
   and 1080p rows have already failed by delivering 26.5 fps against a requested 30. A dropped-frame
   failure there is the encoder, not the network, and must not be read as a size effect.

The grid is 9 cells and needs no new instrument: `sweep-interleaved.sh` already takes
`SWEEP_CONFIGS` as `name:size:kbps:gop` and gives it the interleaving, the reversal, the axis guard
and the funding check.
