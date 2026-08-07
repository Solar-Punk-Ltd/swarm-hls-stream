# uploader-crash: what a viewer saw

**2026-08-06T04:41:37.300Z.** Chrome 151.0.7922.75, headed against an X display on the deployment host, watching a 0.25s-GOP broadcast through the shipped client while `latbench-stream-uploader-1` was killed.

`http://127.0.0.1:10074/#/watch/video/8d8a30ff4cbcf8ad0e0773547686295f8157feb0/4e8216e8-2f5c-4143-8f3a-fc4a6fec9f2b?qoe=1`

The fault landed 45.8s into the run and was lifted at 61.1s.

## The instrument was sound

All 120 samples came from a page reporting `visibilityState: visible`, with a 100ms timer keeping its schedule and a build that can decode H.264 and AAC. Nothing below is the harness degrading its own subject, which is the failure that blocked this measurement until now.

## What the viewer saw

`latbench-stream-uploader-1` was **killed** for 15.3s, which breaks the process that writes segments and manifests into Swarm.

| | media seconds per wall second | over |
| --- | ---: | ---: |
| before the fault | 0.997 | 44.6s |
| while it was down | 0.441 | 15.3s |
| after it came back | 1.149 | 60.9s |

| | |
| --- | ---: |
| longest stretch the picture did not move | 12.4s |
| it stopped, after the fault | 7.1s |
| it moved again, after the service returned | 4.1s |
| behind live before | 6.14s |
| behind live after | 5.19s |

## Against what this scenario expected

> Nothing new reaches the feed while it is down, so the viewer spends their buffer and then waits. Once it is back the feed advances again and playback resumes, either at the live edge or by catching up to it.

⛔ **The picture stopped for 12.4s.** Expected for this fault, and the length is the finding.

⛔ **The client said nothing.** The picture was stopped and `FeedStateOverlay` rendered no message, so a viewer had a frozen frame and no reason for it. That overlay exists for exactly this moment.

✅ **It recovered on its own**, 4.1s after the service came back, with no reload and nothing asked of the viewer.

## What playback did

| | |
| --- | ---: |
| samples | 120 over 120.8s |
| **media seconds per wall second, whole session** | **1.003** |
| media seconds per wall second, typical sample | 1.000 |
| samples where playback did not advance | 16 |
| rebuffers the player counted | 5, totalling 19479ms |
| fatal errors | 0 |
| dropped frames | 67 |
| buffered ahead of the playhead, median | 3.90s |
| resolution decoded | 1280×720 |

The advance ratio is `currentTime` against the wall clock, which is the one measurement here that does not go through the overlay: a stalled player still reports a latency and still renders, and this is what says whether the picture was moving.

**Read the whole-session ratio, not the typical sample.** Playback either runs at its rate or is stopped, so the typical sample reads 1.000 in any session that plays at all, including one that spends a sixth of its time frozen. The gap between the two rows is the rebuffering.

## Where the time went

| | |
| --- | ---: |
| segment requests | 419 for 401 distinct segments |
| refused (404, not yet retrievable) | 17 (4.1% of requests) |
| segments refused at least once | 17 |
| segments never served at all | 0 |
| **time spent waiting between attempts** | **0ms** |
| median successful transfer | 97ms |
| segment bytes delivered | 286 kB/s |
| most segment fetches in flight at once | 2 |

The waiting figure accounts for **0%** of the 19479ms this session spent rebuffering. It is measured between one attempt ending and the next starting, so it contains no transfer time and cannot be inflated by a slow gateway: it is time the player chose to spend doing nothing, which on a refused fragment is `fragLoadPolicy.errorRetry.retryDelayMs`.

## Every sample

| # | t (s) | currentTime | behind live (s) | buffered ahead (s) | readyState | rebuffers | what the client said |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 0.0 | 5.55 | 11.56 | 0.09 | 1 | 0 |  |
| 2 | 1.1 | 6.52 | 6.31 | 2.17 | 4 | 0 |  |
| 3 | 2.1 | 7.53 | 6.15 | 4.09 | 4 | 0 |  |
| 4 | 3.1 | 8.54 | 5.94 | 4.41 | 4 | 0 |  |
| 5 | 4.1 | 9.55 | 5.72 | 4.62 | 4 | 0 |  |
| 6 | 5.1 | 10.56 | 5.30 | 3.61 | 4 | 0 |  |
| 7 | 6.2 | 11.57 | 6.06 | 4.31 | 4 | 0 |  |
| 8 | 7.2 | 12.58 | 5.88 | 4.64 | 4 | 0 |  |
| 9 | 8.2 | 13.59 | 5.39 | 4.85 | 4 | 0 |  |
| 10 | 9.2 | 14.60 | 4.66 | 4.18 | 4 | 0 |  |
| 11 | 10.2 | 15.60 | 6.02 | 4.02 | 4 | 0 |  |
| 12 | 11.2 | 16.61 | 6.00 | 4.56 | 4 | 0 |  |
| 13 | 12.2 | 17.62 | 5.66 | 5.09 | 4 | 0 |  |
| 14 | 13.2 | 18.63 | 5.83 | 4.73 | 4 | 0 |  |
| 15 | 14.2 | 19.64 | 5.89 | 4.44 | 4 | 0 |  |
| 16 | 15.2 | 20.64 | 5.70 | 4.79 | 4 | 0 |  |
| 17 | 16.2 | 21.65 | 5.48 | 4.11 | 4 | 0 |  |
| 18 | 17.2 | 22.67 | 6.12 | 4.13 | 4 | 0 |  |
| 19 | 18.2 | 23.68 | 5.63 | 4.66 | 4 | 0 |  |
| 20 | 19.3 | 24.69 | 5.93 | 4.67 | 4 | 0 |  |
| 21 | 20.3 | 25.70 | 5.23 | 4.33 | 4 | 0 |  |
| 22 | 21.3 | 26.70 | 5.95 | 4.37 | 4 | 0 |  |
| 23 | 22.3 | 27.71 | 5.88 | 3.36 | 4 | 0 |  |
| 24 | 23.3 | 28.71 | 5.91 | 4.75 | 4 | 0 |  |
| 25 | 24.3 | 29.72 | 5.51 | 4.26 | 4 | 0 |  |
| 26 | 25.3 | 30.72 | 5.80 | 4.10 | 4 | 0 |  |
| 27 | 26.3 | 31.73 | 5.65 | 4.63 | 4 | 0 |  |
| 28 | 27.3 | 32.74 | 5.81 | 3.95 | 4 | 0 |  |
| 29 | 28.3 | 33.80 | 6.21 | 4.10 | 4 | 0 |  |
| 30 | 29.3 | 34.79 | 5.91 | 4.82 | 4 | 0 |  |
| 31 | 30.4 | 35.80 | 5.79 | 4.63 | 4 | 0 |  |
| 32 | 31.5 | 36.93 | 6.13 | 4.03 | 4 | 0 |  |
| 33 | 32.5 | 37.98 | 5.41 | 3.67 | 4 | 0 |  |
| 34 | 33.5 | 38.99 | 4.28 | 4.03 | 4 | 0 |  |
| 35 | 34.5 | 40.00 | 5.21 | 3.36 | 4 | 0 |  |
| 36 | 35.5 | 41.01 | 5.76 | 4.22 | 4 | 0 |  |
| 37 | 36.5 | 42.02 | 5.47 | 4.41 | 4 | 0 |  |
| 38 | 37.6 | 43.03 | 5.81 | 4.60 | 4 | 0 |  |
| 39 | 38.6 | 44.04 | 6.00 | 3.76 | 4 | 0 |  |
| 40 | 39.6 | 45.04 | 5.66 | 3.91 | 4 | 0 |  |
| 41 | 40.6 | 46.05 | 5.85 | 4.65 | 4 | 0 |  |
| 42 | 41.6 | 47.05 | 6.07 | 4.85 | 4 | 0 |  |
| 43 | 42.6 | 48.05 | 5.95 | 4.01 | 4 | 0 |  |
| 44 | 43.6 | 49.04 | 6.09 | 4.18 | 4 | 0 |  |
| 45 | 44.6 | 50.04 | 6.14 | 4.75 | 4 | 0 |  |
| 46 | 45.8 | 51.24 | 5.93 | 3.56 | 4 | 0 |  |
| 47 | 46.8 | 52.24 | 5.41 | 4.43 | 4 | 0 |  |
| 48 | 47.8 | 53.25 | 5.16 | 3.59 | 4 | 0 |  |
| 49 | 48.8 | 54.26 | 5.16 | 2.58 | 4 | 0 |  |
| 50 | 49.8 | 55.27 | 5.16 | 1.57 | 4 | 0 |  |
| 51 | 50.9 | 56.28 | 5.16 | 0.56 | 4 | 0 |  |
| 52 | 51.9 | 56.79 | 5.16 | 0.05 | 2 | 1 |  |
| 53 | 52.9 | 56.79 | 5.42 | 0.05 | 2 | 1 |  |
| 54 | 53.9 | 56.79 | 5.42 | 0.05 | 2 | 1 |  |
| 55 | 54.9 | 56.79 | 5.42 | 0.05 | 2 | 1 |  |
| 56 | 55.9 | 56.79 | 5.42 | 0.05 | 2 | 1 |  |
| 57 | 56.9 | 56.79 | 5.42 | 0.05 | 2 | 1 |  |
| 58 | 57.9 | 56.79 | 5.42 | 0.05 | 2 | 1 |  |
| 59 | 58.9 | 56.79 | 5.42 | 0.05 | 2 | 1 |  |
| 60 | 59.9 | 56.79 | 5.42 | 0.05 | 2 | 1 |  |
| 61 | 61.1 | 56.79 | 5.42 | 0.05 | 2 | 1 |  |
| 62 | 62.2 | 56.79 | 5.42 | 0.05 | 2 | 1 |  |
| 63 | 63.2 | 56.79 | 5.42 | 0.05 | 2 | 1 |  |
| 64 | 64.2 | 56.79 | 5.42 | 0.05 | 2 | 1 |  |
| 65 | 65.2 | 68.42 | 18.48 | -11.07 | 1 | 2 |  |
| 66 | 66.3 | 68.42 | 7.29 | -10.56 | 1 | 2 |  |
| 67 | 67.3 | 68.42 | 9.75 | 9.24 | 1 | 2 |  |
| 68 | 68.3 | 68.42 | 10.37 | 9.75 | 1 | 2 |  |
| 69 | 69.3 | 68.42 | 11.05 | 10.94 | 1 | 2 |  |
| 70 | 70.3 | 76.07 | 12.92 | 4.32 | 2 | 3 |  |
| 71 | 71.3 | 77.99 | 4.57 | 2.57 | 4 | 4 |  |
| 72 | 72.3 | 79.00 | 4.91 | 1.56 | 4 | 4 |  |
| 73 | 73.3 | 80.01 | 4.82 | 0.56 | 4 | 4 |  |
| 74 | 74.3 | 80.52 | 5.09 | 0.04 | 2 | 5 |  |
| 75 | 75.3 | 81.25 | 5.88 | 1.84 | 4 | 5 |  |
| 76 | 76.3 | 82.27 | 5.71 | 3.22 | 4 | 5 |  |
| 77 | 77.3 | 83.28 | 5.67 | 3.25 | 4 | 5 |  |
| 78 | 78.3 | 84.29 | 5.25 | 3.78 | 4 | 5 |  |
| 79 | 79.4 | 85.30 | 5.44 | 3.79 | 4 | 5 |  |
| 80 | 80.4 | 86.31 | 5.28 | 3.98 | 4 | 5 |  |
| 81 | 81.4 | 87.32 | 5.53 | 2.97 | 4 | 5 |  |
| 82 | 82.4 | 88.33 | 5.66 | 3.83 | 4 | 5 |  |
| 83 | 83.4 | 89.34 | 5.25 | 3.86 | 4 | 5 |  |
| 84 | 84.4 | 90.35 | 5.48 | 2.85 | 4 | 5 |  |
| 85 | 85.4 | 91.35 | 5.60 | 3.89 | 4 | 5 |  |
| 86 | 86.4 | 92.37 | 5.50 | 4.06 | 4 | 5 |  |
| 87 | 87.4 | 93.38 | 4.58 | 3.74 | 4 | 5 |  |
| 88 | 88.4 | 94.39 | 5.18 | 4.44 | 4 | 5 |  |
| 89 | 89.4 | 95.39 | 5.36 | 4.46 | 4 | 5 |  |
| 90 | 90.5 | 96.40 | 5.39 | 3.76 | 4 | 5 |  |
| 91 | 91.5 | 97.41 | 5.05 | 2.74 | 4 | 5 |  |
| 92 | 92.6 | 98.58 | 5.19 | 4.17 | 4 | 5 |  |
| 93 | 93.6 | 99.58 | 5.37 | 4.19 | 4 | 5 |  |
| 94 | 94.7 | 100.60 | 5.05 | 3.83 | 4 | 5 |  |
| 95 | 95.7 | 101.61 | 5.31 | 2.81 | 4 | 5 |  |
| 96 | 96.7 | 102.61 | 5.37 | 4.21 | 4 | 5 |  |
| 97 | 97.7 | 103.62 | 5.35 | 3.73 | 4 | 5 |  |
| 98 | 98.7 | 104.63 | 5.33 | 2.73 | 4 | 5 |  |
| 99 | 99.7 | 105.63 | 5.27 | 4.11 | 4 | 5 |  |
| 100 | 100.7 | 106.64 | 4.38 | 3.28 | 4 | 5 |  |
| 101 | 101.7 | 107.65 | 5.33 | 3.64 | 4 | 5 |  |
| 102 | 102.7 | 108.65 | 5.48 | 3.99 | 4 | 5 |  |
| 103 | 103.7 | 109.66 | 5.23 | 2.98 | 4 | 5 |  |
| 104 | 104.7 | 110.67 | 4.75 | 3.51 | 4 | 5 |  |
| 105 | 105.7 | 111.68 | 5.25 | 3.87 | 4 | 5 |  |
| 106 | 106.7 | 112.69 | 5.24 | 2.86 | 4 | 5 |  |
| 107 | 107.8 | 113.70 | 5.45 | 4.06 | 4 | 5 |  |
| 108 | 108.8 | 114.71 | 4.91 | 3.74 | 4 | 5 |  |
| 109 | 109.8 | 115.71 | 5.25 | 4.10 | 4 | 5 |  |
| 110 | 110.8 | 116.72 | 5.15 | 3.95 | 4 | 5 |  |
| 111 | 111.8 | 117.73 | 5.12 | 3.45 | 4 | 5 |  |
| 112 | 112.8 | 118.74 | 5.39 | 2.76 | 4 | 5 |  |
| 113 | 113.8 | 119.74 | 5.30 | 4.34 | 4 | 5 |  |
| 114 | 114.8 | 120.75 | 5.05 | 3.85 | 4 | 5 |  |
| 115 | 115.8 | 121.75 | 5.16 | 3.70 | 4 | 5 |  |
| 116 | 116.8 | 122.76 | 5.18 | 4.06 | 4 | 5 |  |
| 117 | 117.8 | 123.76 | 4.45 | 3.56 | 4 | 5 |  |
| 118 | 118.8 | 124.78 | 5.40 | 4.09 | 4 | 5 |  |
| 119 | 119.8 | 125.79 | 5.12 | 3.93 | 4 | 5 |  |
| 120 | 120.8 | 126.79 | 5.19 | 4.29 | 4 | 5 |  |

## Screenshots

- `/repo/docs/bench/browser-screenshots/2026-08-06T04-41-37-300Z/sample-0001.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T04-41-37-300Z/sample-0031.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T04-41-37-300Z/sample-0061.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T04-41-37-300Z/sample-0091.png`
