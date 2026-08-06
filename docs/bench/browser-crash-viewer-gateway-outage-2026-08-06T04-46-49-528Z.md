# viewer-gateway-outage: what a viewer saw

**2026-08-06T04:46:49.528Z.** Chrome 151.0.7922.75, headed against an X display on the deployment host, watching a 0.25s-GOP broadcast through the shipped client while `latbench-bee-gateway-1` was stopped.

`http://127.0.0.1:10074/#/watch/video/8d8a30ff4cbcf8ad0e0773547686295f8157feb0/e76a5fdb-8f4e-4776-8700-26d0e34200cd?qoe=1`

The fault landed 49.7s into the run and was lifted at 70.2s.

## The instrument was sound

All 125 samples came from a page reporting `visibilityState: visible`, with a 100ms timer keeping its schedule and a build that can decode H.264 and AAC. Nothing below is the harness degrading its own subject, which is the failure that blocked this measurement until now.

## What the viewer saw

`latbench-bee-gateway-1` was **stopped** for 20.5s, which breaks the bee node a viewer reads segments and feed slots through.

| | media seconds per wall second | over |
| --- | ---: | ---: |
| before the fault | 1.002 | 44.7s |
| while it was down | 0.234 | 24.3s |
| after it came back | 1.288 | 60.9s |

| | |
| --- | ---: |
| longest stretch the picture did not move | 32.6s |
| it stopped, after the fault | 2.0s |
| it moved again, after the service returned | 14.1s |
| behind live before | 5.79s |
| behind live after | 7.04s |

## Against what this scenario expected

> The picture plays out whatever is buffered and then stops. The client should say so rather than leave a frozen frame unexplained, and should resume on its own once the gateway answers again, without a reload and without ending the broadcast.

⛔ **The picture stopped for 32.6s.** Expected for this fault, and the length is the finding.

✅ **The client said why.** While the picture was stopped it showed: "Reconnecting to the stream". A viewer who is told the stream is reconnecting waits. One looking at a frozen frame reloads, or leaves.

✅ **It recovered on its own**, 14.1s after the service came back, with no reload and nothing asked of the viewer.

## What playback did

| | |
| --- | ---: |
| samples | 125 over 129.9s |
| **media seconds per wall second, whole session** | **0.992** |
| media seconds per wall second, typical sample | 1.000 |
| samples where playback did not advance | 32 |
| rebuffers the player counted | 6, totalling 33665ms |
| fatal errors | 0 |
| dropped frames | 39 |
| buffered ahead of the playhead, median | 4.92s |
| resolution decoded | 1280×720 |

The advance ratio is `currentTime` against the wall clock, which is the one measurement here that does not go through the overlay: a stalled player still reports a latency and still renders, and this is what says whether the picture was moving.

**Read the whole-session ratio, not the typical sample.** Playback either runs at its rate or is stopped, so the typical sample reads 1.000 in any session that plays at all, including one that spends a sixth of its time frozen. The gap between the two rows is the rebuffering.

## Where the time went

| | |
| --- | ---: |
| segment requests | 722 for 511 distinct segments |
| refused (404, not yet retrievable) | 2 (0.3% of requests) |
| segments refused at least once | 1 |
| segments never served at all | 0 |
| **time spent waiting between attempts** | **26372ms** |
| median successful transfer | 67ms |
| segment bytes delivered | 341 kB/s |
| most segment fetches in flight at once | 2 |

The waiting figure accounts for **78%** of the 33665ms this session spent rebuffering. It is measured between one attempt ending and the next starting, so it contains no transfer time and cannot be inflated by a slow gateway: it is time the player chose to spend doing nothing, which on a refused fragment is `fragLoadPolicy.errorRetry.retryDelayMs`.

## Every sample

| # | t (s) | currentTime | behind live (s) | buffered ahead (s) | readyState | rebuffers | what the client said |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 0.0 | 5.56 | — | 0.17 | 1 | 0 |  |
| 2 | 1.1 | 6.53 | 5.90 | 2.43 | 4 | 0 |  |
| 3 | 2.1 | 7.54 | 4.89 | 4.33 | 4 | 0 |  |
| 4 | 3.1 | 8.63 | 6.18 | 5.63 | 4 | 0 |  |
| 5 | 4.2 | 9.65 | 5.95 | 5.13 | 4 | 0 |  |
| 6 | 5.2 | 10.65 | 5.48 | 5.15 | 4 | 0 |  |
| 7 | 6.2 | 11.69 | 6.05 | 5.48 | 4 | 0 |  |
| 8 | 7.2 | 12.74 | 6.10 | 5.45 | 4 | 0 |  |
| 9 | 8.2 | 13.74 | 5.88 | 5.30 | 4 | 0 |  |
| 10 | 9.2 | 14.75 | 5.68 | 5.14 | 4 | 0 |  |
| 11 | 10.2 | 15.77 | 6.00 | 4.64 | 4 | 0 |  |
| 12 | 11.2 | 16.81 | 6.17 | 5.13 | 4 | 0 |  |
| 13 | 12.2 | 17.84 | 5.86 | 4.96 | 4 | 0 |  |
| 14 | 13.2 | 18.83 | 5.95 | 4.99 | 4 | 0 |  |
| 15 | 14.2 | 19.84 | 5.74 | 4.84 | 4 | 0 |  |
| 16 | 15.3 | 20.88 | 6.14 | 5.15 | 4 | 0 |  |
| 17 | 16.3 | 21.89 | 5.84 | 4.83 | 4 | 0 |  |
| 18 | 17.3 | 22.90 | 6.11 | 4.99 | 4 | 0 |  |
| 19 | 18.3 | 23.90 | 5.98 | 5.04 | 4 | 0 |  |
| 20 | 19.3 | 24.91 | 5.78 | 4.86 | 4 | 0 |  |
| 21 | 20.3 | 25.92 | 5.93 | 4.90 | 4 | 0 |  |
| 22 | 21.3 | 26.93 | 5.92 | 4.92 | 4 | 0 |  |
| 23 | 22.3 | 27.94 | 5.21 | 4.23 | 4 | 0 |  |
| 24 | 23.3 | 28.98 | 6.05 | 5.05 | 4 | 0 |  |
| 25 | 24.3 | 29.99 | 5.82 | 4.75 | 4 | 0 |  |
| 26 | 25.3 | 30.98 | 5.90 | 4.79 | 4 | 0 |  |
| 27 | 26.4 | 31.99 | 5.46 | 4.44 | 4 | 0 |  |
| 28 | 27.4 | 33.00 | 5.50 | 4.48 | 4 | 0 |  |
| 29 | 28.4 | 34.04 | 6.07 | 4.97 | 4 | 0 |  |
| 30 | 29.4 | 35.05 | 5.60 | 4.47 | 4 | 0 |  |
| 31 | 30.4 | 36.05 | 5.93 | 4.84 | 4 | 0 |  |
| 32 | 31.5 | 37.21 | 5.73 | 4.70 | 4 | 0 |  |
| 33 | 32.5 | 38.22 | 5.80 | 4.88 | 4 | 0 |  |
| 34 | 33.6 | 39.22 | 5.87 | 5.09 | 4 | 0 |  |
| 35 | 34.6 | 40.23 | 5.96 | 4.92 | 4 | 0 |  |
| 36 | 35.6 | 41.24 | 5.21 | 4.43 | 4 | 0 |  |
| 37 | 36.6 | 42.25 | 5.01 | 4.27 | 4 | 0 |  |
| 38 | 37.6 | 43.26 | 5.61 | 4.80 | 4 | 0 |  |
| 39 | 38.6 | 44.26 | 5.67 | 4.97 | 4 | 0 |  |
| 40 | 39.6 | 45.29 | 6.00 | 5.16 | 4 | 0 |  |
| 41 | 40.6 | 46.30 | 5.80 | 4.80 | 4 | 0 |  |
| 42 | 41.6 | 47.30 | 5.86 | 5.02 | 4 | 0 |  |
| 43 | 42.6 | 48.31 | 5.66 | 4.52 | 4 | 0 |  |
| 44 | 43.6 | 49.33 | 5.99 | 5.21 | 4 | 0 |  |
| 45 | 44.7 | 50.33 | 5.79 | 5.24 | 4 | 0 |  |
| 46 | 49.7 | 55.36 | 5.43 | 0.72 | 4 | 0 | Reconnecting to the stream |
| 47 | 50.7 | 56.03 | 5.43 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 48 | 51.7 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 49 | 52.7 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 50 | 53.7 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 51 | 54.7 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 52 | 55.7 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 53 | 56.7 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 54 | 57.8 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 55 | 58.8 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 56 | 59.8 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 57 | 60.8 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 58 | 61.8 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 59 | 62.8 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 60 | 63.8 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 61 | 64.8 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 62 | 66.0 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 63 | 67.0 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 64 | 68.0 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 65 | 69.0 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 66 | 70.2 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 67 | 71.2 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 68 | 72.2 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 69 | 73.2 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 70 | 74.2 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 71 | 75.2 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 72 | 76.2 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 73 | 77.2 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 74 | 78.3 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 75 | 79.3 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 76 | 80.3 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 77 | 81.3 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 78 | 82.3 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 79 | 83.3 | 56.03 | 5.69 | 0.05 | 2 | 1 | Reconnecting to the stream |
| 80 | 84.3 | 56.45 | 5.69 | 2.02 | 4 | 1 |  |
| 81 | 85.3 | 57.47 | 9.34 | 5.78 | 4 | 1 |  |
| 82 | 86.3 | 64.24 | 6.72 | 3.27 | 4 | 2 |  |
| 83 | 87.3 | 65.26 | 9.99 | 6.52 | 4 | 2 |  |
| 84 | 88.3 | 72.78 | 6.83 | 3.27 | 4 | 3 |  |
| 85 | 89.3 | 73.80 | 9.99 | 6.51 | 4 | 3 |  |
| 86 | 90.3 | 81.31 | 6.84 | 3.26 | 4 | 4 |  |
| 87 | 91.3 | 82.34 | 9.99 | 7.15 | 4 | 4 |  |
| 88 | 92.4 | 89.88 | 6.72 | 3.88 | 4 | 5 |  |
| 89 | 93.4 | 90.92 | 9.99 | 6.80 | 4 | 5 |  |
| 90 | 94.4 | 98.43 | 6.83 | 3.56 | 4 | 6 |  |
| 91 | 95.4 | 99.46 | 7.50 | 6.80 | 4 | 6 |  |
| 92 | 96.5 | 100.68 | 7.34 | 6.60 | 4 | 6 |  |
| 93 | 97.5 | 101.79 | 7.33 | 6.51 | 4 | 6 |  |
| 94 | 98.5 | 102.90 | 7.29 | 6.60 | 4 | 6 |  |
| 95 | 99.5 | 104.01 | 7.25 | 6.51 | 4 | 6 |  |
| 96 | 100.5 | 105.05 | 6.99 | 6.31 | 4 | 6 |  |
| 97 | 101.5 | 106.05 | 7.05 | 6.34 | 4 | 6 |  |
| 98 | 102.5 | 107.06 | 6.32 | 5.51 | 4 | 6 |  |
| 99 | 103.5 | 108.08 | 6.91 | 6.20 | 4 | 6 |  |
| 100 | 104.6 | 109.08 | 6.18 | 5.36 | 4 | 6 |  |
| 101 | 105.6 | 110.11 | 7.03 | 6.21 | 4 | 6 |  |
| 102 | 106.6 | 111.14 | 7.12 | 6.36 | 4 | 6 |  |
| 103 | 107.6 | 112.21 | 7.10 | 6.34 | 4 | 6 |  |
| 104 | 108.6 | 113.23 | 6.33 | 5.48 | 4 | 6 |  |
| 105 | 109.6 | 114.23 | 6.94 | 6.19 | 4 | 6 |  |
| 106 | 110.6 | 115.23 | 7.01 | 6.21 | 4 | 6 |  |
| 107 | 111.6 | 116.25 | 7.07 | 6.21 | 4 | 6 |  |
| 108 | 112.6 | 117.26 | 6.59 | 5.72 | 4 | 6 |  |
| 109 | 113.6 | 118.27 | 6.66 | 5.89 | 4 | 6 |  |
| 110 | 114.6 | 119.28 | 6.19 | 5.41 | 4 | 6 |  |
| 111 | 115.6 | 120.27 | 6.80 | 5.95 | 4 | 6 |  |
| 112 | 116.6 | 121.28 | 6.06 | 5.28 | 4 | 6 |  |
| 113 | 117.6 | 122.29 | 6.67 | 5.81 | 4 | 6 |  |
| 114 | 118.7 | 123.30 | 7.12 | 6.16 | 4 | 6 |  |
| 115 | 119.7 | 124.31 | 6.26 | 5.33 | 4 | 6 |  |
| 116 | 120.7 | 125.30 | 6.88 | 6.05 | 4 | 6 |  |
| 117 | 121.7 | 126.28 | 6.96 | 6.08 | 4 | 6 |  |
| 118 | 122.7 | 127.27 | 7.05 | 6.12 | 4 | 6 |  |
| 119 | 123.7 | 128.28 | 6.58 | 5.62 | 4 | 6 |  |
| 120 | 124.7 | 129.28 | 6.92 | 5.99 | 4 | 6 |  |
| 121 | 125.7 | 130.29 | 6.45 | 5.49 | 4 | 6 |  |
| 122 | 126.9 | 131.48 | 7.04 | 6.01 | 4 | 6 |  |
| 123 | 127.9 | 132.47 | 6.89 | 6.36 | 4 | 6 |  |
| 124 | 128.9 | 133.47 | 6.96 | 6.40 | 4 | 6 |  |
| 125 | 129.9 | 134.47 | 7.04 | 6.43 | 4 | 6 |  |

## Screenshots

- `/repo/docs/bench/browser-screenshots/2026-08-06T04-46-49-528Z/sample-0001.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T04-46-49-528Z/sample-0031.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T04-46-49-528Z/sample-0061.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T04-46-49-528Z/sample-0091.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T04-46-49-528Z/sample-0121.png`
