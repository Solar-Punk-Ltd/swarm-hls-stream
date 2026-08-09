# What a gateway burns at each quality profile, and 1080p finally has a number

**2026-08-09, 07:08 to 07:13 UTC.** Eight arms on a **funded** gateway, four quality profiles alternating,
two rounds, 30 MB apiece. **Cost: 0.1633 BZZ**, and **zero broadcast minutes**.

Task #24 has been open since the cost model was written, and its first bullet is per-MB cost at each
profile's real segment sizes. **1080p at 6000 kbps ships and its gateway burn had never been measured.**

## ⭐ It needed no broadcast at all

The archive holds thousands of distinct segment references at four profile sizes, left behind by runs
already paid for. Every one of them still resolves. So this is a retrieval measurement against a funded
gateway with **no encoder, no publisher, no upload and no postage**: only the gateway's own chequebook
moves.

The live-broadcast route would have cost roughly 0.4 BZZ **and about 20 of the 64 remaining
broadcast-minutes**, which are the binding constraint on everything else left.

## ⭐⭐ The rate is flat across an 8.5x range of segment size

| profile           | segment | fetches |    BZZ per MB, r1 / r2 |
| ----------------- | ------: | ------: | ---------------------: |
| 2500k @ 0.25s     |   94 kB |     322 | 0.000708 / 0.000644    |
| **6000k @ 0.25s** | **213 kB** | **141** | **0.000687 / 0.000668** |
| 2500k @ 1.0s      |  346 kB |      87 | 0.000676 / 0.000656    |
| **6000k @ 1.0s**  | **792 kB** |  **38** | **0.000685 / 0.000697** |

⭐⭐ **All eight arms land between 0.000644 and 0.000708, a spread of 9.4%, with no ordering by segment
size.** **Mean 0.000678 BZZ per MB.**

⭐ That reproduces the best single earlier measurement, 0.00068 from the funding-cliff arm, across four
profiles and eight arms. **Use 0.00068. The 0.00085 that was quoted for weeks is 25% too high.**

## ⭐⭐ So the burn follows the bitrate, and here are the numbers

| profile           | MB/s  | MB/min | **BZZ/min** | **BZZ/hour** |
| ----------------- | ----: | -----: | ----------: | -----------: |
| 2500k @ 0.25s     | 0.351 |   21.1 |  **0.0143** |    **0.857** |
| **6000k @ 0.25s, ships** | **0.799** | **47.9** | **0.0325** | **1.948** |
| 2500k @ 1.0s      | 0.346 |   20.8 |  **0.0141** |    **0.844** |
| 6000k @ 1.0s      | 0.792 |   47.5 |  **0.0322** |    **1.931** |

⭐⭐ **1080p at 6000 kbps costs a viewer's gateway 0.0325 BZZ a minute, or 1.95 BZZ an hour.** The figure
derived before any of this was measured was 0.0315, so **the derivation was right to within 3%** and is
now measured.

⛔⛔ **There is no GOP premium.** At the same bitrate, 0.25s and 1.0s cost the same: 0.0143 against
0.0141, and 0.0325 against 0.0322. The encoder delivers the same byte rate at both, 348 kB/s and 346
kB/s, so **the resilient profile is free.** That question is closed.

⭐ **And feed reads add nothing to the bill.** A not-found slot read costs about 480ms and **zero BZZ**,
measured separately, so **a viewer's gateway burn is segment bytes and nothing else.**

## ⭐⭐ Price is per byte and does not care about service time

Round 2 was much slower in the tail. p90 went from 67, 86, 83 and 249ms to **654, 621, 1021 and 228ms**,
and arm durations roughly doubled. Medians barely moved, 50 to 54, 52 to 56, 63 to 72, 135 to 142ms, so
it was the tail rather than the typical fetch.

⭐ **The BZZ per MB did not move**: 0.000644 to 0.000697 in the slow round against 0.000676 to 0.000708 in
the fast one. **A gateway pays for bytes, not for how long they took.**

## ⭐ The attribution reconciles exactly, and that says when lumpiness matters

The eight per-arm figures sum to **1,633,018,000,000,000 PLUR**, and the balance fell by
**1,633,018,000,000,000 PLUR**. Exactly. Every idle control between arms spent **zero**.

⚠️ That looks like it contradicts the earlier finding that spending is lumpy and quantised, and it does
not. **The cheque denomination is around 615,000,000,000 PLUR.** A run that spends 0.8 MB sits below it
and reads as pure noise, which is what happened when a whole-run delta was divided across 400 slot reads.
A run that spends 240 MB is 2,650 cheques deep and the quantisation averages out. ⭐ **Lumpiness matters
when the spend is comparable to one cheque, and not otherwise.**

## ⚠️ What this does not show

⚠️ **Archived segments, not the live edge.** The rate is per byte and should not care, but a live viewer
also pays whatever the live edge costs above an archived read, and that is not measured here. ⬅ **This is
the one thing a live run would still add**, and it is now a validation rather than a discovery.

⚠️ **No throwaway arm.** It was dropped to hold the cost to what was quoted, so round 1's first arm
carries any first-arm effect. Its rate, 0.000708, is the highest of the eight but only 4% above the mean,
and its median and p90 are the lowest of round 1, so nothing suggests it is distorted.

⚠️ **One viewer, flat out, cache off**, so every fetch is a real network retrieval. That is deliberate: it
is what costs money.

⭐ ⬅ **An aside worth someone's time.** Throughput rose steadily with segment size, 1.11, 2.32, 3.34 and
4.31 MB/s, because per-request overhead amortises over more bytes. **The 43 to 44 MB/s ceiling was
measured at 94 kB segments.** Whether it moves at 792 kB is unmeasured and would change capacity
planning.

## Artifacts

`/home/solarpunk/retrieval-probe/BURN1/`. Probe:
[`deploy/scripts/retrieval-debt-probe.sh`](../../deploy/scripts/retrieval-debt-probe.sh), with per-arm
spend attribution and the CPU idle window doubling as its control. Reference lists built from
`docs/bench/*.requests.json` by segment size.

Gateway left at `--swap-enable=true` and `--cache-capacity=0`, which is how it was found.
