# writer-bee-pause: what a viewer saw

**2026-08-06T05:33:36.816Z.** Chrome 151.0.7922.75, headed against an X display on the deployment host, watching a 0.25s-GOP broadcast through the shipped client while `latbench-bee-uploader-1` was paused.

`http://127.0.0.1:10074/#/watch/video/8d8a30ff4cbcf8ad0e0773547686295f8157feb0/20f7df2b-001a-488a-af04-cb355d801e73?qoe=1`

The fault landed 45.7s into the run and was lifted at 53.9s.

## The instrument was sound

All 113 samples came from a page reporting `visibilityState: visible`, with a 100ms timer keeping its schedule and a build that can decode H.264 and AAC. Nothing below is the harness degrading its own subject, which is the failure that blocked this measurement until now.

## What the viewer saw

`latbench-bee-uploader-1` was **paused** for 8.1s, which breaks the bee node the uploader writes segments and manifests through, briefly.

| | media seconds per wall second | over |
| --- | ---: | ---: |
| before the fault | 1.006 | 44.7s |
| while it was down | 0.770 | 9.2s |
| after it came back | 1.019 | 59.7s |

| | |
| --- | ---: |
| longest stretch the picture did not move | 3.1s |
| it stopped, after the fault | 7.1s |
| the service took, to answer after docker returned | 0.0s |
| it moved again, after the service **answered** | 2.0s |
| behind live before | 6.16s |
| behind live after | 7.17s |

## Against what this scenario expected

> Nothing. The outage is shorter than the uploader retry window, so segments buffer and flush rather than being lost, and a viewer with six seconds of buffer should never see the picture stop or be told anything is wrong.

⛔ **The picture stopped for 3.1s.**

⛔ **The client said nothing.** The picture was stopped and `FeedStateOverlay` rendered no message, so a viewer had a frozen frame and no reason for it. That overlay exists for exactly this moment.

✅ **It recovered on its own**, 2.0s after the service came back, with no reload and nothing asked of the viewer.

## What playback did

| | |
| --- | ---: |
| samples | 113 over 113.6s |
| **media seconds per wall second, whole session** | **0.994** |
| media seconds per wall second, typical sample | 1.001 |
| samples where playback did not advance | 3 |
| rebuffers the player counted | 2, totalling 3613ms |
| fatal errors | 0 |
| dropped frames | 1 |
| buffered ahead of the playhead, median | 5.41s |
| resolution decoded | 1280×720 |

The advance ratio is `currentTime` against the wall clock, which is the one measurement here that does not go through the overlay: a stalled player still reports a latency and still renders, and this is what says whether the picture was moving.

**Read the whole-session ratio, not the typical sample.** Playback either runs at its rate or is stopped, so the typical sample reads 1.000 in any session that plays at all, including one that spends a sixth of its time frozen. The gap between the two rows is the rebuffering.

## Where the time went

| | |
| --- | ---: |
| segment requests | 454 for 452 distinct segments |
| refused (404, not yet retrievable) | 1 (0.2% of requests) |
| segments refused at least once | 1 |
| segments never served at all | 0 |
| **time spent waiting between attempts** | **0ms** |
| median successful transfer | 89ms |
| segment bytes delivered | 340 kB/s |
| most segment fetches in flight at once | 2 |

The waiting figure accounts for **0%** of the 3613ms this session spent rebuffering. It is measured between one attempt ending and the next starting, so it contains no transfer time and cannot be inflated by a slow gateway: it is time the player chose to spend doing nothing, which on a refused fragment is `fragLoadPolicy.errorRetry.retryDelayMs`.

## Every sample

| # | t (s) | currentTime | behind live (s) | buffered ahead (s) | readyState | rebuffers | what the client said |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 0.0 | 5.60 | 11.61 | 0.05 | 1 | 0 |  |
| 2 | 1.2 | 6.63 | 7.31 | 2.60 | 4 | 0 |  |
| 3 | 2.2 | 7.74 | 6.76 | 5.42 | 4 | 0 |  |
| 4 | 3.2 | 8.84 | 6.72 | 6.00 | 4 | 0 |  |
| 5 | 4.2 | 9.95 | 6.32 | 4.89 | 4 | 0 |  |
| 6 | 5.2 | 11.02 | 6.04 | 5.04 | 4 | 0 |  |
| 7 | 6.2 | 12.06 | 6.17 | 5.19 | 4 | 0 |  |
| 8 | 7.2 | 13.15 | 6.21 | 4.79 | 4 | 0 |  |
| 9 | 8.2 | 14.16 | 5.85 | 4.95 | 4 | 0 |  |
| 10 | 9.2 | 15.16 | 5.93 | 5.00 | 4 | 0 |  |
| 11 | 10.2 | 16.16 | 6.00 | 5.03 | 4 | 0 |  |
| 12 | 11.2 | 17.17 | 5.80 | 4.87 | 4 | 0 |  |
| 13 | 12.2 | 18.18 | 6.23 | 4.88 | 4 | 0 |  |
| 14 | 13.2 | 19.19 | 5.86 | 5.23 | 4 | 0 |  |
| 15 | 14.2 | 20.21 | 6.29 | 5.57 | 4 | 0 |  |
| 16 | 15.3 | 21.22 | 5.65 | 5.09 | 4 | 0 |  |
| 17 | 16.3 | 22.23 | 6.22 | 5.42 | 4 | 0 |  |
| 18 | 17.3 | 23.24 | 5.90 | 4.41 | 4 | 0 |  |
| 19 | 18.3 | 24.26 | 5.96 | 4.94 | 4 | 0 |  |
| 20 | 19.3 | 25.27 | 6.04 | 4.96 | 4 | 0 |  |
| 21 | 20.3 | 26.28 | 6.23 | 4.80 | 4 | 0 |  |
| 22 | 21.3 | 27.29 | 6.06 | 5.33 | 4 | 0 |  |
| 23 | 22.3 | 28.30 | 6.27 | 5.17 | 4 | 0 |  |
| 24 | 23.3 | 29.31 | 5.89 | 5.18 | 4 | 0 |  |
| 25 | 24.3 | 30.30 | 6.09 | 5.21 | 4 | 0 |  |
| 26 | 25.3 | 31.30 | 6.19 | 5.41 | 4 | 0 |  |
| 27 | 26.3 | 32.31 | 6.25 | 5.43 | 4 | 0 |  |
| 28 | 27.4 | 33.32 | 6.01 | 4.42 | 4 | 0 |  |
| 29 | 28.4 | 34.32 | 5.84 | 4.78 | 4 | 0 |  |
| 30 | 29.4 | 35.33 | 5.92 | 5.12 | 4 | 0 |  |
| 31 | 30.4 | 36.34 | 5.99 | 5.16 | 4 | 0 |  |
| 32 | 31.6 | 37.52 | 5.97 | 5.33 | 4 | 0 |  |
| 33 | 32.6 | 38.51 | 6.16 | 5.37 | 4 | 0 |  |
| 34 | 33.6 | 39.52 | 6.27 | 5.39 | 4 | 0 |  |
| 35 | 34.6 | 40.54 | 5.27 | 4.88 | 4 | 0 |  |
| 36 | 35.6 | 41.54 | 6.21 | 4.73 | 4 | 0 |  |
| 37 | 36.6 | 42.54 | 6.15 | 5.27 | 4 | 0 |  |
| 38 | 37.6 | 43.54 | 6.23 | 5.63 | 4 | 0 |  |
| 39 | 38.6 | 44.55 | 5.63 | 5.13 | 4 | 0 |  |
| 40 | 39.6 | 45.55 | 6.19 | 5.30 | 4 | 0 |  |
| 41 | 40.6 | 46.55 | 6.13 | 5.36 | 4 | 0 |  |
| 42 | 41.6 | 47.56 | 6.04 | 5.37 | 4 | 0 |  |
| 43 | 42.7 | 48.56 | 5.97 | 5.39 | 4 | 0 |  |
| 44 | 43.7 | 49.56 | 6.17 | 5.55 | 4 | 0 |  |
| 45 | 44.7 | 50.56 | 6.16 | 5.61 | 4 | 0 |  |
| 46 | 45.7 | 51.63 | 5.93 | 5.22 | 4 | 0 |  |
| 47 | 46.7 | 52.64 | 5.77 | 5.06 | 4 | 0 |  |
| 48 | 47.8 | 53.65 | 5.58 | 4.05 | 4 | 0 |  |
| 49 | 48.8 | 54.66 | 5.58 | 3.04 | 4 | 0 |  |
| 50 | 49.8 | 55.67 | 5.58 | 2.03 | 4 | 0 |  |
| 51 | 50.8 | 56.68 | 5.58 | 1.02 | 4 | 0 |  |
| 52 | 51.8 | 57.67 | 5.58 | 0.04 | 2 | 1 |  |
| 53 | 52.8 | 57.67 | 5.84 | 0.04 | 2 | 1 |  |
| 54 | 53.9 | 57.67 | 5.84 | 0.04 | 2 | 1 |  |
| 55 | 54.9 | 57.67 | 0.73 | 0.38 | 2 | 1 |  |
| 56 | 55.9 | 58.23 | 2.10 | 0.84 | 4 | 2 |  |
| 57 | 56.9 | 59.21 | 2.72 | 1.23 | 4 | 2 |  |
| 58 | 57.9 | 60.21 | 2.95 | 1.76 | 4 | 2 |  |
| 59 | 58.9 | 61.22 | 3.52 | 0.75 | 4 | 2 |  |
| 60 | 59.9 | 62.23 | 3.80 | 2.65 | 4 | 2 |  |
| 61 | 60.9 | 63.23 | 4.05 | 2.49 | 4 | 2 |  |
| 62 | 62.1 | 64.40 | 4.57 | 2.86 | 4 | 2 |  |
| 63 | 63.1 | 65.41 | 5.12 | 4.24 | 4 | 2 |  |
| 64 | 64.1 | 66.42 | 5.46 | 4.60 | 4 | 2 |  |
| 65 | 65.1 | 67.42 | 5.25 | 4.45 | 4 | 2 |  |
| 66 | 66.1 | 68.43 | 6.53 | 5.49 | 4 | 2 |  |
| 67 | 67.1 | 69.48 | 7.36 | 5.80 | 4 | 2 |  |
| 68 | 68.1 | 70.52 | 6.75 | 5.93 | 4 | 2 |  |
| 69 | 69.2 | 71.57 | 8.12 | 6.96 | 4 | 2 |  |
| 70 | 70.2 | 72.68 | 8.07 | 7.21 | 4 | 2 |  |
| 71 | 71.2 | 73.79 | 8.03 | 7.13 | 4 | 2 |  |
| 72 | 72.2 | 74.89 | 9.42 | 7.90 | 4 | 2 |  |
| 73 | 73.2 | 76.00 | 9.05 | 8.16 | 4 | 2 |  |
| 74 | 74.2 | 77.11 | 9.00 | 8.07 | 4 | 2 |  |
| 75 | 75.2 | 78.22 | 8.43 | 7.47 | 4 | 2 |  |
| 76 | 76.2 | 79.33 | 8.95 | 7.73 | 4 | 2 |  |
| 77 | 77.2 | 80.44 | 9.01 | 7.48 | 4 | 2 |  |
| 78 | 78.2 | 81.55 | 8.34 | 7.39 | 4 | 2 |  |
| 79 | 79.2 | 82.66 | 8.30 | 7.30 | 4 | 2 |  |
| 80 | 80.2 | 83.76 | 8.26 | 7.22 | 4 | 2 |  |
| 81 | 81.2 | 84.87 | 8.32 | 7.31 | 4 | 2 |  |
| 82 | 82.3 | 85.98 | 8.21 | 7.22 | 4 | 2 |  |
| 83 | 83.3 | 87.09 | 7.64 | 6.63 | 4 | 2 |  |
| 84 | 84.3 | 88.20 | 7.86 | 6.88 | 4 | 2 |  |
| 85 | 85.3 | 89.30 | 7.60 | 6.61 | 4 | 2 |  |
| 86 | 86.3 | 90.41 | 7.81 | 6.72 | 4 | 2 |  |
| 87 | 87.3 | 91.52 | 7.50 | 6.47 | 4 | 2 |  |
| 88 | 88.3 | 92.62 | 7.46 | 6.38 | 4 | 2 |  |
| 89 | 89.3 | 93.73 | 7.45 | 6.45 | 4 | 2 |  |
| 90 | 90.3 | 94.84 | 7.41 | 6.39 | 4 | 2 |  |
| 91 | 91.3 | 95.94 | 7.37 | 6.30 | 4 | 2 |  |
| 92 | 92.4 | 97.19 | 7.35 | 6.08 | 4 | 2 |  |
| 93 | 93.4 | 98.22 | 6.37 | 6.23 | 4 | 2 |  |
| 94 | 94.5 | 99.21 | 7.56 | 5.43 | 4 | 2 |  |
| 95 | 95.5 | 100.30 | 7.38 | 6.22 | 4 | 2 |  |
| 96 | 96.5 | 101.37 | 7.07 | 6.17 | 4 | 2 |  |
| 97 | 97.5 | 102.39 | 6.63 | 6.00 | 4 | 2 |  |
| 98 | 98.5 | 103.38 | 7.37 | 5.86 | 4 | 2 |  |
| 99 | 99.5 | 104.42 | 6.94 | 6.16 | 4 | 2 |  |
| 100 | 100.5 | 105.41 | 7.11 | 5.89 | 4 | 2 |  |
| 101 | 101.5 | 106.42 | 6.92 | 5.90 | 4 | 2 |  |
| 102 | 102.5 | 107.41 | 7.26 | 5.76 | 4 | 2 |  |
| 103 | 103.5 | 108.43 | 7.32 | 6.42 | 4 | 2 |  |
| 104 | 104.5 | 109.48 | 6.98 | 6.42 | 4 | 2 |  |
| 105 | 105.5 | 110.48 | 7.26 | 6.11 | 4 | 2 |  |
| 106 | 106.6 | 111.50 | 6.84 | 6.28 | 4 | 2 |  |
| 107 | 107.6 | 112.49 | 7.34 | 6.31 | 4 | 2 |  |
| 108 | 108.6 | 113.53 | 7.01 | 6.30 | 4 | 2 |  |
| 109 | 109.6 | 114.52 | 7.21 | 6.16 | 4 | 2 |  |
| 110 | 110.6 | 115.54 | 6.24 | 5.97 | 4 | 2 |  |
| 111 | 111.6 | 116.55 | 6.74 | 5.49 | 4 | 2 |  |
| 112 | 112.6 | 117.54 | 7.08 | 5.84 | 4 | 2 |  |
| 113 | 113.6 | 118.53 | 7.17 | 6.41 | 4 | 2 |  |

## Screenshots

- `/repo/docs/bench/browser-screenshots/2026-08-06T05-33-36-816Z/sample-0001.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-33-36-816Z/sample-0031.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-33-36-816Z/sample-0061.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-33-36-816Z/sample-0091.png`
