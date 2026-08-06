# viewer-gateway-outage: what a viewer saw

**2026-08-06T05:06:23.585Z.** Chrome 151.0.7922.75, headed against an X display on the deployment host, watching a 0.25s-GOP broadcast through the shipped client while `latbench-bee-gateway-1` was stopped.

`http://127.0.0.1:10074/#/watch/video/8d8a30ff4cbcf8ad0e0773547686295f8157feb0/ac77ea6d-f7f5-4475-b701-43ca49d363a5?qoe=1`

The fault landed 46.1s into the run and was lifted at 66.6s.

## The instrument was sound

All 125 samples came from a page reporting `visibilityState: visible`, with a 100ms timer keeping its schedule and a build that can decode H.264 and AAC. Nothing below is the harness degrading its own subject, which is the failure that blocked this measurement until now.

## What the viewer saw

`latbench-bee-gateway-1` was **stopped** for 20.5s, which breaks the bee node a viewer reads segments and feed slots through.

| | media seconds per wall second | over |
| --- | ---: | ---: |
| before the fault | 0.995 | 44.7s |
| while it was down | 0.291 | 22.0s |
| after it came back | 1.241 | 59.7s |

| | |
| --- | ---: |
| longest stretch the picture did not move | 27.6s |
| it stopped, after the fault | 6.1s |
| the service took, to answer after docker returned | 0.9s |
| it moved again, after the service **answered** | 12.2s |
| behind live before | 5.90s |
| behind live after | 6.93s |

## Against what this scenario expected

> The picture plays out whatever is buffered and then stops. The client should say so rather than leave a frozen frame unexplained, and should resume on its own once the gateway answers again, without a reload and without ending the broadcast.

⛔ **The picture stopped for 27.6s.** Expected for this fault, and the length is the finding.

✅ **The client said why.** While the picture was stopped it showed: "Reconnecting to the stream". A viewer who is told the stream is reconnecting waits. One looking at a frozen frame reloads, or leaves.

✅ **It recovered on its own**, 12.2s after the service came back, with no reload and nothing asked of the viewer.

## What playback did

| | |
| --- | ---: |
| samples | 125 over 126.4s |
| **media seconds per wall second, whole session** | **0.989** |
| media seconds per wall second, typical sample | 1.000 |
| samples where playback did not advance | 27 |
| rebuffers the player counted | 5, totalling 28780ms |
| fatal errors | 0 |
| dropped frames | 34 |
| buffered ahead of the playhead, median | 5.07s |
| resolution decoded | 1280×720 |

The advance ratio is `currentTime` against the wall clock, which is the one measurement here that does not go through the overlay: a stalled player still reports a latency and still renders, and this is what says whether the picture was moving.

**Read the whole-session ratio, not the typical sample.** Playback either runs at its rate or is stopped, so the typical sample reads 1.000 in any session that plays at all, including one that spends a sixth of its time frozen. The gap between the two rows is the rebuffering.

## Where the time went

| | |
| --- | ---: |
| segment requests | 580 for 489 distinct segments |
| refused (404, not yet retrievable) | 2 (0.3% of requests) |
| segments refused at least once | 1 |
| segments never served at all | 0 |
| **time spent waiting between attempts** | **22410ms** |
| median successful transfer | 64ms |
| segment bytes delivered | 334 kB/s |
| most segment fetches in flight at once | 2 |

The waiting figure accounts for **78%** of the 28780ms this session spent rebuffering. It is measured between one attempt ending and the next starting, so it contains no transfer time and cannot be inflated by a slow gateway: it is time the player chose to spend doing nothing, which on a refused fragment is `fragLoadPolicy.errorRetry.retryDelayMs`.

## Every sample

| # | t (s) | currentTime | behind live (s) | buffered ahead (s) | readyState | rebuffers | what the client said |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 0.0 | 5.49 | — | 0.23 | 1 | 0 |  |
| 2 | 1.1 | 6.51 | 5.60 | 4.82 | 4 | 0 |  |
| 3 | 2.2 | 7.52 | 5.15 | 5.37 | 4 | 0 |  |
| 4 | 3.2 | 8.53 | 5.73 | 5.20 | 4 | 0 |  |
| 5 | 4.2 | 9.54 | 5.54 | 5.22 | 4 | 0 |  |
| 6 | 5.2 | 10.55 | 5.59 | 5.24 | 4 | 0 |  |
| 7 | 6.2 | 11.56 | 5.66 | 5.26 | 4 | 0 |  |
| 8 | 7.2 | 12.56 | 5.86 | 5.44 | 4 | 0 |  |
| 9 | 8.2 | 13.57 | 5.59 | 5.12 | 4 | 0 |  |
| 10 | 9.2 | 14.58 | 5.72 | 5.28 | 4 | 0 |  |
| 11 | 10.2 | 15.59 | 4.93 | 4.47 | 4 | 0 |  |
| 12 | 11.2 | 16.58 | 6.00 | 5.35 | 4 | 0 |  |
| 13 | 12.2 | 17.59 | 5.61 | 5.20 | 4 | 0 |  |
| 14 | 13.3 | 18.60 | 5.68 | 5.21 | 4 | 0 |  |
| 15 | 14.3 | 19.61 | 5.21 | 4.71 | 4 | 0 |  |
| 16 | 15.3 | 20.62 | 5.78 | 5.07 | 4 | 0 |  |
| 17 | 16.3 | 21.62 | 5.62 | 5.09 | 4 | 0 |  |
| 18 | 17.3 | 22.63 | 5.68 | 5.10 | 4 | 0 |  |
| 19 | 18.3 | 23.64 | 5.48 | 4.95 | 4 | 0 |  |
| 20 | 19.3 | 24.63 | 5.83 | 5.33 | 4 | 0 |  |
| 21 | 20.3 | 25.64 | 5.64 | 5.16 | 4 | 0 |  |
| 22 | 21.3 | 26.65 | 5.70 | 5.18 | 4 | 0 |  |
| 23 | 22.3 | 27.66 | 5.77 | 5.20 | 4 | 0 |  |
| 24 | 23.3 | 28.66 | 5.83 | 5.22 | 4 | 0 |  |
| 25 | 24.3 | 29.67 | 5.64 | 5.07 | 4 | 0 |  |
| 26 | 25.4 | 30.68 | 5.70 | 5.08 | 4 | 0 |  |
| 27 | 26.4 | 31.67 | 5.80 | 5.26 | 4 | 0 |  |
| 28 | 27.4 | 32.68 | 5.04 | 4.44 | 4 | 0 |  |
| 29 | 28.4 | 33.69 | 5.82 | 5.11 | 4 | 0 |  |
| 30 | 29.4 | 34.70 | 5.19 | 4.64 | 4 | 0 |  |
| 31 | 30.4 | 35.69 | 5.80 | 5.19 | 4 | 0 |  |
| 32 | 31.6 | 36.87 | 5.32 | 4.52 | 4 | 0 |  |
| 33 | 32.6 | 37.88 | 5.89 | 4.88 | 4 | 0 |  |
| 34 | 33.6 | 38.88 | 4.96 | 4.18 | 4 | 0 |  |
| 35 | 34.6 | 39.89 | 5.63 | 4.74 | 4 | 0 |  |
| 36 | 35.6 | 40.90 | 5.59 | 4.76 | 4 | 0 |  |
| 37 | 36.6 | 41.90 | 5.93 | 5.12 | 4 | 0 |  |
| 38 | 37.6 | 42.91 | 5.73 | 4.95 | 4 | 0 |  |
| 39 | 38.6 | 43.92 | 5.79 | 4.98 | 4 | 0 |  |
| 40 | 39.6 | 44.91 | 5.87 | 5.01 | 4 | 0 |  |
| 41 | 40.6 | 45.92 | 5.67 | 4.86 | 4 | 0 |  |
| 42 | 41.6 | 46.93 | 5.20 | 4.36 | 4 | 0 |  |
| 43 | 42.7 | 47.94 | 5.91 | 4.89 | 4 | 0 |  |
| 44 | 43.7 | 48.95 | 5.81 | 5.24 | 4 | 0 |  |
| 45 | 44.7 | 49.95 | 5.90 | 5.26 | 4 | 0 |  |
| 46 | 46.2 | 51.43 | 5.84 | 4.96 | 4 | 0 | Reconnecting to the stream |
| 47 | 47.2 | 52.44 | 5.40 | 3.95 | 4 | 0 | Reconnecting to the stream |
| 48 | 48.2 | 53.45 | 5.40 | 2.94 | 4 | 0 | Reconnecting to the stream |
| 49 | 49.2 | 54.46 | 5.40 | 1.94 | 4 | 0 | Reconnecting to the stream |
| 50 | 50.2 | 55.47 | 5.40 | 0.93 | 4 | 0 | Reconnecting to the stream |
| 51 | 51.2 | 56.36 | 5.40 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 52 | 52.2 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 53 | 53.2 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 54 | 54.2 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 55 | 55.2 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 56 | 56.2 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 57 | 57.2 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 58 | 58.3 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 59 | 59.3 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 60 | 60.3 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 61 | 61.3 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 62 | 62.4 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 63 | 63.4 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 64 | 64.5 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 65 | 65.5 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 66 | 66.7 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 67 | 67.7 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 68 | 68.7 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 69 | 69.7 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 70 | 70.7 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 71 | 71.7 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 72 | 72.7 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 73 | 73.7 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 74 | 74.7 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 75 | 75.7 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 76 | 76.7 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 77 | 77.7 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 78 | 78.8 | 56.36 | 5.66 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 79 | 79.8 | 56.73 | 5.61 | 1.54 | 4 | 1 |  |
| 80 | 80.8 | 57.75 | 8.99 | 4.12 | 4 | 1 |  |
| 81 | 81.8 | 64.11 | 6.89 | 1.51 | 4 | 2 |  |
| 82 | 82.8 | 65.13 | 10.24 | 4.25 | 4 | 2 |  |
| 83 | 83.8 | 72.81 | 6.84 | 1.35 | 4 | 3 |  |
| 84 | 84.8 | 73.83 | 10.18 | 4.09 | 4 | 3 |  |
| 85 | 85.8 | 81.33 | 6.87 | 1.20 | 4 | 4 |  |
| 86 | 86.8 | 82.35 | 10.24 | 3.58 | 4 | 4 |  |
| 87 | 87.8 | 89.94 | 6.80 | 1.11 | 4 | 5 |  |
| 88 | 88.8 | 90.96 | 9.94 | 3.30 | 4 | 5 |  |
| 89 | 89.8 | 92.07 | 8.36 | 6.15 | 4 | 5 |  |
| 90 | 90.8 | 93.18 | 9.10 | 8.29 | 4 | 5 |  |
| 91 | 91.8 | 94.29 | 8.91 | 8.20 | 4 | 5 |  |
| 92 | 93.0 | 95.58 | 8.48 | 7.76 | 4 | 5 |  |
| 93 | 94.0 | 96.69 | 7.90 | 7.17 | 4 | 5 |  |
| 94 | 95.0 | 97.79 | 8.40 | 7.60 | 4 | 5 |  |
| 95 | 96.0 | 98.90 | 8.50 | 7.51 | 4 | 5 |  |
| 96 | 97.1 | 100.01 | 8.08 | 7.26 | 4 | 5 |  |
| 97 | 98.1 | 101.12 | 7.77 | 7.00 | 4 | 5 |  |
| 98 | 99.1 | 102.23 | 7.73 | 6.91 | 4 | 5 |  |
| 99 | 100.1 | 103.34 | 8.08 | 7.17 | 4 | 5 |  |
| 100 | 101.1 | 104.45 | 7.41 | 6.57 | 4 | 5 |  |
| 101 | 102.1 | 105.56 | 7.73 | 6.83 | 4 | 5 |  |
| 102 | 103.1 | 106.67 | 7.59 | 6.74 | 4 | 5 |  |
| 103 | 104.1 | 107.78 | 7.59 | 6.66 | 4 | 5 |  |
| 104 | 105.1 | 108.89 | 7.48 | 6.40 | 4 | 5 |  |
| 105 | 106.1 | 109.98 | 7.21 | 6.67 | 4 | 5 |  |
| 106 | 107.1 | 110.99 | 6.96 | 6.69 | 4 | 5 |  |
| 107 | 108.1 | 112.11 | 7.29 | 6.94 | 4 | 5 |  |
| 108 | 109.2 | 113.19 | 7.23 | 6.67 | 4 | 5 |  |
| 109 | 110.2 | 114.20 | 7.02 | 6.72 | 4 | 5 |  |
| 110 | 111.2 | 115.21 | 7.05 | 6.74 | 4 | 5 |  |
| 111 | 112.2 | 116.25 | 7.09 | 6.55 | 4 | 5 |  |
| 112 | 113.2 | 117.24 | 6.88 | 6.58 | 4 | 5 |  |
| 113 | 114.2 | 118.25 | 6.95 | 6.59 | 4 | 5 |  |
| 114 | 115.2 | 119.27 | 6.29 | 5.92 | 4 | 5 |  |
| 115 | 116.2 | 120.29 | 7.46 | 6.25 | 4 | 5 |  |
| 116 | 117.2 | 121.34 | 6.91 | 6.41 | 4 | 5 |  |
| 117 | 118.2 | 122.33 | 7.06 | 6.27 | 4 | 5 |  |
| 118 | 119.2 | 123.34 | 7.00 | 5.59 | 4 | 5 |  |
| 119 | 120.3 | 124.38 | 7.05 | 6.10 | 4 | 5 |  |
| 120 | 121.3 | 125.39 | 6.85 | 5.94 | 4 | 5 |  |
| 121 | 122.3 | 126.40 | 7.03 | 5.95 | 4 | 5 |  |
| 122 | 123.4 | 127.51 | 6.72 | 5.68 | 4 | 5 |  |
| 123 | 124.4 | 128.52 | 5.98 | 4.86 | 4 | 5 |  |
| 124 | 125.4 | 129.52 | 6.85 | 5.73 | 4 | 5 |  |
| 125 | 126.4 | 130.51 | 6.93 | 5.77 | 4 | 5 |  |

## Screenshots

- `/repo/docs/bench/browser-screenshots/2026-08-06T05-06-23-585Z/sample-0001.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-06-23-585Z/sample-0031.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-06-23-585Z/sample-0061.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-06-23-585Z/sample-0091.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-06-23-585Z/sample-0121.png`
