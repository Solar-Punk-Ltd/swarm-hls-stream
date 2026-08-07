# viewer-gateway-outage: what a viewer saw

**2026-08-05T17:05:49.577Z.** Chrome 151.0.7922.75, headed against an X display on the deployment host, watching a 0.25s-GOP broadcast through the shipped client while `latbench-bee-gateway-1` was stopped.

`http://127.0.0.1:10074/#/watch/video/8d8a30ff4cbcf8ad0e0773547686295f8157feb0/3eec1347-27c1-406f-80cf-d9729d515400?qoe=1`

The fault landed 46.0s into the run and was lifted at 66.5s.

## The instrument was sound

All 125 samples came from a page reporting `visibilityState: visible`, with a 100ms timer keeping its schedule and a build that can decode H.264 and AAC. Nothing below is the harness degrading its own subject, which is the failure that blocked this measurement until now.

## What the viewer saw

`latbench-bee-gateway-1` was **stopped** for 20.5s, which breaks the bee node a viewer reads segments and feed slots through.

| | media seconds per wall second | over |
| --- | ---: | ---: |
| before the fault | 1.018 | 44.7s |
| while it was down | 0.281 | 20.6s |
| after it came back | 1.242 | 61.0s |

| | |
| --- | ---: |
| longest stretch the picture did not move | 30.6s |
| it stopped, after the fault | 6.1s |
| it moved again, after the service returned | 16.2s |
| behind live before | 5.77s |
| behind live after | 6.05s |

## Against what this scenario expected

> The picture plays out whatever is buffered and then stops. The client should say so rather than leave a frozen frame unexplained, and should resume on its own once the gateway answers again, without a reload and without ending the broadcast.

⛔ **The picture stopped for 30.6s.** Expected for this fault, and the length is the finding.

✅ **The client said why.** While the picture was stopped it showed: "Reconnecting to the stream". A viewer who is told the stream is reconnecting waits. One looking at a frozen frame reloads, or leaves.

✅ **It recovered on its own**, 16.2s after the service came back, with no reload and nothing asked of the viewer.

## What playback did

| | |
| --- | ---: |
| samples | 125 over 126.3s |
| **media seconds per wall second, whole session** | **1.006** |
| media seconds per wall second, typical sample | 1.000 |
| samples where playback did not advance | 30 |
| rebuffers the player counted | 7, totalling 33896ms |
| fatal errors | 0 |
| dropped frames | 21 |
| buffered ahead of the playhead, median | 4.35s |
| resolution decoded | 1280×720 |

The advance ratio is `currentTime` against the wall clock, which is the one measurement here that does not go through the overlay: a stalled player still reports a latency and still renders, and this is what says whether the picture was moving.

**Read the whole-session ratio, not the typical sample.** Playback either runs at its rate or is stopped, so the typical sample reads 1.000 in any session that plays at all, including one that spends a sixth of its time frozen. The gap between the two rows is the rebuffering.

## Where the time went

| | |
| --- | ---: |
| segment requests | 519 for 428 distinct segments |
| refused (404, not yet retrievable) | 1 (0.2% of requests) |
| segments refused at least once | 1 |
| segments never served at all | 0 |
| **time spent waiting between attempts** | **22390ms** |
| median successful transfer | 114ms |
| segment bytes delivered | 278 kB/s |
| most segment fetches in flight at once | 2 |

The waiting figure accounts for **66%** of the 33896ms this session spent rebuffering. It is measured between one attempt ending and the next starting, so it contains no transfer time and cannot be inflated by a slow gateway: it is time the player chose to spend doing nothing, which on a refused fragment is `fragLoadPolicy.errorRetry.retryDelayMs`.

## Every sample

| # | t (s) | currentTime | behind live (s) | buffered ahead (s) | readyState | rebuffers | what the client said |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 0.0 | 5.56 | — | 0.17 | 1 | 0 |  |
| 2 | 1.2 | 6.55 | 5.49 | 1.06 | 4 | 0 |  |
| 3 | 2.2 | 7.57 | 7.87 | 1.58 | 4 | 0 |  |
| 4 | 3.2 | 8.68 | 7.41 | 2.34 | 4 | 0 |  |
| 5 | 4.2 | 9.79 | 7.22 | 2.91 | 4 | 0 |  |
| 6 | 5.2 | 10.90 | 6.94 | 3.37 | 4 | 0 |  |
| 7 | 6.2 | 12.01 | 6.86 | 4.30 | 4 | 0 |  |
| 8 | 7.2 | 13.12 | 6.37 | 4.90 | 4 | 0 |  |
| 9 | 8.3 | 14.18 | 5.42 | 4.86 | 4 | 0 |  |
| 10 | 9.3 | 15.21 | 6.67 | 4.35 | 4 | 0 |  |
| 11 | 10.3 | 16.32 | 6.34 | 5.11 | 4 | 0 |  |
| 12 | 11.3 | 17.41 | 6.08 | 5.39 | 4 | 0 |  |
| 13 | 12.3 | 18.42 | 5.49 | 4.89 | 4 | 0 |  |
| 14 | 13.3 | 19.45 | 6.30 | 4.71 | 4 | 0 |  |
| 15 | 14.3 | 20.50 | 6.18 | 5.20 | 4 | 0 |  |
| 16 | 15.3 | 21.53 | 5.98 | 5.02 | 4 | 0 |  |
| 17 | 16.3 | 22.54 | 5.81 | 4.70 | 4 | 0 |  |
| 18 | 17.3 | 23.55 | 4.99 | 4.35 | 4 | 0 |  |
| 19 | 18.3 | 24.58 | 6.46 | 4.02 | 4 | 0 |  |
| 20 | 19.3 | 25.63 | 6.19 | 4.66 | 4 | 0 |  |
| 21 | 20.4 | 26.64 | 5.99 | 4.86 | 4 | 0 |  |
| 22 | 21.4 | 27.66 | 6.07 | 5.04 | 4 | 0 |  |
| 23 | 22.4 | 28.66 | 5.96 | 5.06 | 4 | 0 |  |
| 24 | 23.4 | 29.67 | 5.87 | 5.07 | 4 | 0 |  |
| 25 | 24.4 | 30.67 | 6.02 | 4.93 | 4 | 0 |  |
| 26 | 25.4 | 31.67 | 5.14 | 4.44 | 4 | 0 |  |
| 27 | 26.4 | 32.71 | 6.39 | 4.25 | 4 | 0 |  |
| 28 | 27.4 | 33.74 | 5.82 | 4.76 | 4 | 0 |  |
| 29 | 28.4 | 34.75 | 5.92 | 4.77 | 4 | 0 |  |
| 30 | 29.4 | 35.76 | 5.35 | 4.62 | 4 | 0 |  |
| 31 | 30.4 | 36.78 | 6.22 | 4.62 | 4 | 0 |  |
| 32 | 31.6 | 37.94 | 5.74 | 4.83 | 4 | 0 |  |
| 33 | 32.6 | 38.95 | 5.82 | 4.84 | 4 | 0 |  |
| 34 | 33.6 | 39.96 | 5.60 | 4.68 | 4 | 0 |  |
| 35 | 34.6 | 40.98 | 6.03 | 4.69 | 4 | 0 |  |
| 36 | 35.6 | 41.97 | 6.01 | 5.06 | 4 | 0 |  |
| 37 | 36.6 | 42.98 | 5.81 | 4.91 | 4 | 0 |  |
| 38 | 37.7 | 43.98 | 5.89 | 4.93 | 4 | 0 |  |
| 39 | 38.7 | 44.99 | 5.69 | 4.78 | 4 | 0 |  |
| 40 | 39.7 | 46.00 | 5.75 | 4.79 | 4 | 0 |  |
| 41 | 40.7 | 47.01 | 5.82 | 4.81 | 4 | 0 |  |
| 42 | 41.7 | 48.00 | 5.90 | 4.83 | 4 | 0 |  |
| 43 | 42.7 | 49.01 | 5.17 | 4.16 | 4 | 0 |  |
| 44 | 43.7 | 50.08 | 6.23 | 4.46 | 4 | 0 |  |
| 45 | 44.7 | 51.10 | 5.77 | 4.80 | 4 | 0 |  |
| 46 | 46.0 | 52.38 | 5.83 | 4.55 | 4 | 0 | Reconnecting to the stream |
| 47 | 47.0 | 53.39 | 5.52 | 3.54 | 4 | 0 | Reconnecting to the stream |
| 48 | 48.0 | 54.40 | 5.52 | 2.53 | 4 | 0 | Reconnecting to the stream |
| 49 | 49.0 | 55.41 | 5.52 | 1.52 | 4 | 0 | Reconnecting to the stream |
| 50 | 50.0 | 56.42 | 5.52 | 0.51 | 4 | 0 | Reconnecting to the stream |
| 51 | 51.0 | 56.89 | 5.52 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 52 | 52.0 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 53 | 53.1 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 54 | 54.1 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 55 | 55.1 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 56 | 56.1 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 57 | 57.1 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 58 | 58.1 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 59 | 59.1 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 60 | 60.1 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 61 | 61.1 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 62 | 62.3 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 63 | 63.3 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 64 | 64.3 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 65 | 65.3 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 66 | 66.5 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 67 | 67.5 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 68 | 68.5 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 69 | 69.5 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 70 | 70.5 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 71 | 71.6 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 72 | 72.6 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 73 | 73.6 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 74 | 74.6 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 75 | 75.6 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 76 | 76.6 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 77 | 77.6 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 78 | 78.6 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 79 | 79.6 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 80 | 80.6 | 56.89 | 5.77 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 81 | 81.6 | 56.89 | 5.77 | 0.04 | 2 | 1 |  |
| 82 | 82.7 | 57.77 | 4.84 | 2.06 | 4 | 1 |  |
| 83 | 83.7 | 58.79 | 8.43 | 3.77 | 4 | 1 |  |
| 84 | 84.7 | 64.69 | 7.04 | 0.78 | 4 | 2 |  |
| 85 | 85.7 | 65.70 | 10.94 | 0.28 | 4 | 2 |  |
| 86 | 86.7 | 74.22 | 14.92 | -1.07 | 1 | 3 |  |
| 87 | 87.7 | 74.74 | 10.18 | 1.13 | 4 | 3 |  |
| 88 | 88.7 | 82.51 | 14.14 | 0.53 | 4 | 4 |  |
| 89 | 89.7 | 83.47 | 10.14 | 0.94 | 4 | 4 |  |
| 90 | 90.7 | 91.02 | 6.09 | 0.87 | 4 | 5 |  |
| 91 | 91.7 | 92.04 | 9.89 | 1.72 | 4 | 5 |  |
| 92 | 92.9 | 99.58 | 13.61 | 0.52 | 4 | 6 |  |
| 93 | 93.9 | 100.19 | 6.74 | 0.78 | 4 | 7 |  |
| 94 | 94.9 | 101.19 | 6.05 | 2.16 | 4 | 7 |  |
| 95 | 95.9 | 102.20 | 5.97 | 1.84 | 4 | 7 |  |
| 96 | 96.9 | 103.21 | 5.97 | 4.07 | 4 | 7 |  |
| 97 | 97.9 | 104.22 | 6.07 | 4.43 | 4 | 7 |  |
| 98 | 98.9 | 105.23 | 5.93 | 4.95 | 4 | 7 |  |
| 99 | 99.9 | 106.24 | 5.20 | 4.28 | 4 | 7 |  |
| 100 | 100.9 | 107.24 | 5.80 | 4.81 | 4 | 7 |  |
| 101 | 101.9 | 108.25 | 5.87 | 4.98 | 4 | 7 |  |
| 102 | 102.9 | 109.26 | 5.93 | 5.01 | 4 | 7 |  |
| 103 | 104.0 | 110.27 | 5.47 | 4.52 | 4 | 7 |  |
| 104 | 105.0 | 111.28 | 5.80 | 4.87 | 4 | 7 |  |
| 105 | 106.0 | 112.29 | 5.87 | 4.89 | 4 | 7 |  |
| 106 | 107.0 | 113.29 | 5.93 | 5.25 | 4 | 7 |  |
| 107 | 108.0 | 114.31 | 5.73 | 5.06 | 4 | 7 |  |
| 108 | 109.0 | 115.31 | 5.81 | 5.11 | 4 | 7 |  |
| 109 | 110.0 | 116.32 | 5.87 | 5.12 | 4 | 7 |  |
| 110 | 111.0 | 117.33 | 5.93 | 5.14 | 4 | 7 |  |
| 111 | 112.0 | 118.34 | 6.00 | 5.29 | 4 | 7 |  |
| 112 | 113.0 | 119.34 | 5.80 | 4.82 | 4 | 7 |  |
| 113 | 114.0 | 120.35 | 5.07 | 4.33 | 4 | 7 |  |
| 114 | 115.1 | 121.36 | 5.95 | 4.86 | 4 | 7 |  |
| 115 | 116.1 | 122.37 | 5.20 | 4.36 | 4 | 7 |  |
| 116 | 117.1 | 123.38 | 5.83 | 5.23 | 4 | 7 |  |
| 117 | 118.1 | 124.39 | 5.87 | 5.25 | 4 | 7 |  |
| 118 | 119.1 | 125.39 | 5.93 | 5.09 | 4 | 7 |  |
| 119 | 120.1 | 126.40 | 5.47 | 4.94 | 4 | 7 |  |
| 120 | 121.1 | 127.41 | 6.10 | 5.47 | 4 | 7 |  |
| 121 | 122.1 | 128.42 | 5.87 | 5.31 | 4 | 7 |  |
| 122 | 123.3 | 129.59 | 5.73 | 5.16 | 4 | 7 |  |
| 123 | 124.3 | 130.60 | 5.92 | 5.18 | 4 | 7 |  |
| 124 | 125.3 | 131.61 | 5.60 | 5.03 | 4 | 7 |  |
| 125 | 126.3 | 132.61 | 6.05 | 4.87 | 4 | 7 |  |

## Screenshots

- `/repo/docs/bench/browser-screenshots/2026-08-05T17-05-49-577Z/sample-0001.png`
- `/repo/docs/bench/browser-screenshots/2026-08-05T17-05-49-577Z/sample-0031.png`
- `/repo/docs/bench/browser-screenshots/2026-08-05T17-05-49-577Z/sample-0061.png`
- `/repo/docs/bench/browser-screenshots/2026-08-05T17-05-49-577Z/sample-0091.png`
- `/repo/docs/bench/browser-screenshots/2026-08-05T17-05-49-577Z/sample-0121.png`
