# uploader-crash: what a viewer saw

**2026-08-05T17:11:11.039Z.** Chrome 151.0.7922.75, headed against an X display on the deployment host, watching a 0.25s-GOP broadcast through the shipped client while `latbench-stream-uploader-1` was killped.

`http://127.0.0.1:10074/#/watch/video/8d8a30ff4cbcf8ad0e0773547686295f8157feb0/63281045-29bf-4e2a-abda-8defa626bded?qoe=1`

The fault landed 45.8s into the run and was lifted at 61.2s.

## The instrument was sound

All 134 samples came from a page reporting `visibilityState: visible`, with a 100ms timer keeping its schedule and a build that can decode H.264 and AAC. Nothing below is the harness degrading its own subject, which is the failure that blocked this measurement until now.

## What the viewer saw

`latbench-stream-uploader-1` was **killped** for 15.3s, which breaks the process that writes segments and manifests into Swarm.

| | media seconds per wall second | over |
| --- | ---: | ---: |
| before the fault | 1.003 | 44.6s |
| while it was down | 0.453 | 15.3s |
| after it came back | 1.095 | 75.2s |

| | |
| --- | ---: |
| longest stretch the picture did not move | 54.9s |
| it stopped, after the fault | 7.1s |
| it moved again, after the service returned | 46.7s |
| behind live before | 5.90s |
| behind live after | 7.01s |

## Against what this scenario expected

> Nothing new reaches the feed while it is down, so the viewer spends their buffer and then waits. Once it is back the feed advances again and playback resumes, either at the live edge or by catching up to it.

⛔ **The picture stopped for 54.9s.** Expected for this fault, and the length is the finding.

✅ **The client said why.** While the picture was stopped it showed: "Waiting for the broadcast to continue". A viewer who is told the stream is reconnecting waits. One looking at a frozen frame reloads, or leaves.

✅ **It recovered on its own**, 46.7s after the service came back, with no reload and nothing asked of the viewer.

## What playback did

| | |
| --- | ---: |
| samples | 134 over 135.2s |
| **media seconds per wall second, whole session** | **0.992** |
| media seconds per wall second, typical sample | 0.993 |
| samples where playback did not advance | 54 |
| rebuffers the player counted | 7, totalling 57815ms |
| fatal errors | 0 |
| dropped frames | 57 |
| buffered ahead of the playhead, median | 2.98s |
| resolution decoded | 1280×720 |

The advance ratio is `currentTime` against the wall clock, which is the one measurement here that does not go through the overlay: a stalled player still reports a latency and still renders, and this is what says whether the picture was moving.

**Read the whole-session ratio, not the typical sample.** Playback either runs at its rate or is stopped, so the typical sample reads 1.000 in any session that plays at all, including one that spends a sixth of its time frozen. The gap between the two rows is the rebuffering.

## Where the time went

| | |
| --- | ---: |
| segment requests | 419 for 417 distinct segments |
| refused (404, not yet retrievable) | 0 (0.0% of requests) |
| segments refused at least once | 0 |
| segments never served at all | 0 |
| **time spent waiting between attempts** | **0ms** |
| median successful transfer | 92ms |
| segment bytes delivered | 262 kB/s |
| most segment fetches in flight at once | 2 |

The waiting figure accounts for **0%** of the 57815ms this session spent rebuffering. It is measured between one attempt ending and the next starting, so it contains no transfer time and cannot be inflated by a slow gateway: it is time the player chose to spend doing nothing, which on a refused fragment is `fragLoadPolicy.errorRetry.retryDelayMs`.

## Every sample

| # | t (s) | currentTime | behind live (s) | buffered ahead (s) | readyState | rebuffers | what the client said |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 0.0 | 5.54 | — | 0.21 | 1 | 0 |  |
| 2 | 1.1 | 6.54 | 5.84 | 2.46 | 4 | 0 |  |
| 3 | 2.1 | 7.55 | 4.62 | 4.01 | 4 | 0 |  |
| 4 | 3.1 | 8.65 | 6.36 | 5.64 | 4 | 0 |  |
| 5 | 4.1 | 9.66 | 5.98 | 5.14 | 4 | 0 |  |
| 6 | 5.1 | 10.67 | 5.52 | 4.98 | 4 | 0 |  |
| 7 | 6.2 | 11.75 | 6.11 | 5.43 | 4 | 0 |  |
| 8 | 7.2 | 12.80 | 6.09 | 5.41 | 4 | 0 |  |
| 9 | 8.2 | 13.81 | 5.87 | 5.25 | 4 | 0 |  |
| 10 | 9.2 | 14.82 | 5.66 | 5.10 | 4 | 0 |  |
| 11 | 10.2 | 15.83 | 5.98 | 5.44 | 4 | 0 |  |
| 12 | 11.2 | 16.84 | 5.96 | 5.47 | 4 | 0 |  |
| 13 | 12.2 | 17.84 | 5.95 | 5.49 | 4 | 0 |  |
| 14 | 13.2 | 18.84 | 6.03 | 5.51 | 4 | 0 |  |
| 15 | 14.2 | 19.85 | 5.80 | 5.35 | 4 | 0 |  |
| 16 | 15.2 | 20.86 | 5.97 | 5.37 | 4 | 0 |  |
| 17 | 16.2 | 21.86 | 6.01 | 5.54 | 4 | 0 |  |
| 18 | 17.2 | 22.87 | 5.21 | 4.73 | 4 | 0 |  |
| 19 | 18.3 | 23.87 | 6.00 | 4.24 | 4 | 0 |  |
| 20 | 19.3 | 24.86 | 6.00 | 5.13 | 4 | 0 |  |
| 21 | 20.3 | 25.87 | 6.15 | 5.48 | 4 | 0 |  |
| 22 | 21.3 | 26.88 | 5.50 | 4.98 | 4 | 0 |  |
| 23 | 22.3 | 27.91 | 6.29 | 4.98 | 4 | 0 |  |
| 24 | 23.3 | 28.95 | 5.86 | 5.30 | 4 | 0 |  |
| 25 | 24.3 | 29.95 | 6.08 | 5.33 | 4 | 0 |  |
| 26 | 25.3 | 30.96 | 5.73 | 5.17 | 4 | 0 |  |
| 27 | 26.3 | 31.98 | 6.18 | 5.00 | 4 | 0 |  |
| 28 | 27.3 | 33.00 | 6.11 | 5.52 | 4 | 0 |  |
| 29 | 28.3 | 34.04 | 5.97 | 5.33 | 4 | 0 |  |
| 30 | 29.3 | 35.04 | 5.95 | 5.36 | 4 | 0 |  |
| 31 | 30.4 | 36.05 | 6.03 | 5.37 | 4 | 0 |  |
| 32 | 31.5 | 37.20 | 6.01 | 4.56 | 4 | 0 |  |
| 33 | 32.5 | 38.20 | 5.85 | 4.93 | 4 | 0 |  |
| 34 | 33.5 | 39.21 | 5.92 | 4.94 | 4 | 0 |  |
| 35 | 34.5 | 40.23 | 5.98 | 4.77 | 4 | 0 |  |
| 36 | 35.6 | 41.24 | 5.28 | 4.44 | 4 | 0 |  |
| 37 | 36.6 | 42.23 | 6.05 | 5.16 | 4 | 0 |  |
| 38 | 37.6 | 43.25 | 6.13 | 5.17 | 4 | 0 |  |
| 39 | 38.6 | 44.26 | 5.76 | 5.01 | 4 | 0 |  |
| 40 | 39.6 | 45.27 | 5.56 | 4.68 | 4 | 0 |  |
| 41 | 40.6 | 46.26 | 5.92 | 5.06 | 4 | 0 |  |
| 42 | 41.6 | 47.27 | 5.92 | 4.90 | 4 | 0 |  |
| 43 | 42.6 | 48.30 | 6.02 | 5.41 | 4 | 0 |  |
| 44 | 43.6 | 49.29 | 5.79 | 5.27 | 4 | 0 |  |
| 45 | 44.6 | 50.30 | 5.90 | 4.77 | 4 | 0 |  |
| 46 | 45.8 | 51.50 | 5.88 | 5.11 | 4 | 0 |  |
| 47 | 46.9 | 52.51 | 5.74 | 4.10 | 4 | 0 |  |
| 48 | 47.9 | 53.52 | 4.79 | 3.75 | 4 | 0 |  |
| 49 | 48.9 | 54.53 | 4.79 | 2.74 | 4 | 0 |  |
| 50 | 49.9 | 55.54 | 4.79 | 1.73 | 4 | 0 |  |
| 51 | 50.9 | 56.55 | 4.79 | 0.72 | 4 | 0 |  |
| 52 | 51.9 | 57.25 | 4.79 | 0.02 | 2 | 1 |  |
| 53 | 52.9 | 57.25 | 5.07 | 0.02 | 2 | 1 |  |
| 54 | 53.9 | 57.25 | 5.07 | 0.02 | 2 | 1 |  |
| 55 | 54.9 | 57.25 | 5.07 | 0.02 | 2 | 1 |  |
| 56 | 55.9 | 57.25 | 5.07 | 0.02 | 2 | 1 |  |
| 57 | 56.9 | 57.25 | 5.07 | 0.02 | 2 | 1 |  |
| 58 | 58.0 | 57.25 | 5.07 | 0.02 | 2 | 1 |  |
| 59 | 59.0 | 57.25 | 5.07 | 0.02 | 2 | 1 |  |
| 60 | 60.0 | 57.25 | 5.07 | 0.02 | 2 | 1 |  |
| 61 | 61.2 | 57.25 | 5.07 | 0.02 | 2 | 1 |  |
| 62 | 62.3 | 57.25 | 5.07 | 0.02 | 2 | 1 |  |
| 63 | 63.3 | 57.25 | 5.07 | 0.02 | 2 | 1 |  |
| 64 | 64.3 | 57.25 | 5.07 | 0.02 | 2 | 1 |  |
| 65 | 65.3 | 57.25 | 5.07 | 0.02 | 2 | 1 |  |
| 66 | 66.3 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 67 | 67.3 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 68 | 68.3 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 69 | 69.4 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 70 | 70.4 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 71 | 71.4 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 72 | 72.4 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 73 | 73.4 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 74 | 74.4 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 75 | 75.4 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 76 | 76.4 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 77 | 77.4 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 78 | 78.4 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 79 | 79.4 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 80 | 80.4 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 81 | 81.4 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 82 | 82.5 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 83 | 83.5 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 84 | 84.5 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 85 | 85.5 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 86 | 86.5 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 87 | 87.5 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 88 | 88.5 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 89 | 89.5 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 90 | 90.5 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 91 | 91.5 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 92 | 92.7 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 93 | 93.7 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 94 | 94.7 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 95 | 95.7 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 96 | 96.7 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 97 | 97.7 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 98 | 98.7 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 99 | 99.8 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 100 | 100.8 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 101 | 101.8 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 102 | 102.8 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 103 | 103.8 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 104 | 104.8 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 105 | 105.8 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 106 | 106.8 | 57.25 | 5.07 | 0.02 | 2 | 1 | Waiting for the broadcast to continue |
| 107 | 107.8 | 57.57 | 5.26 | 1.09 | 4 | 1 |  |
| 108 | 108.8 | 79.19 | 27.54 | 5.24 | 1 | 2 |  |
| 109 | 109.8 | 80.39 | 9.70 | 4.04 | 4 | 2 |  |
| 110 | 110.8 | 87.85 | 6.58 | 0.84 | 4 | 3 |  |
| 111 | 111.9 | 88.88 | 10.09 | 3.05 | 4 | 3 |  |
| 112 | 112.9 | 96.36 | 6.61 | 0.53 | 4 | 4 |  |
| 113 | 113.9 | 97.39 | 10.12 | 3.08 | 4 | 4 |  |
| 114 | 114.9 | 104.97 | 6.54 | 0.79 | 4 | 5 |  |
| 115 | 115.9 | 106.01 | 10.05 | 3.00 | 4 | 5 |  |
| 116 | 116.9 | 113.54 | 6.53 | 1.06 | 4 | 6 |  |
| 117 | 117.9 | 114.58 | 10.04 | 2.96 | 4 | 6 |  |
| 118 | 118.9 | 122.09 | 6.51 | 1.05 | 4 | 7 |  |
| 119 | 119.9 | 123.12 | 9.37 | 3.12 | 4 | 7 |  |
| 120 | 120.9 | 124.23 | 8.31 | 4.91 | 4 | 7 |  |
| 121 | 121.9 | 125.34 | 7.57 | 6.86 | 4 | 7 |  |
| 122 | 123.1 | 126.62 | 8.58 | 7.45 | 4 | 7 |  |
| 123 | 124.1 | 127.73 | 7.96 | 7.05 | 4 | 7 |  |
| 124 | 125.1 | 128.84 | 7.65 | 6.79 | 4 | 7 |  |
| 125 | 126.1 | 129.96 | 8.06 | 7.04 | 4 | 7 |  |
| 126 | 127.1 | 131.07 | 7.99 | 6.95 | 4 | 7 |  |
| 127 | 128.1 | 132.18 | 7.56 | 6.69 | 4 | 7 |  |
| 128 | 129.2 | 133.29 | 7.52 | 6.61 | 4 | 7 |  |
| 129 | 130.2 | 134.39 | 7.58 | 6.53 | 4 | 7 |  |
| 130 | 131.2 | 135.47 | 7.20 | 6.30 | 4 | 7 |  |
| 131 | 132.2 | 136.56 | 7.20 | 6.24 | 4 | 7 |  |
| 132 | 133.2 | 137.63 | 7.19 | 6.19 | 4 | 7 |  |
| 133 | 134.2 | 138.65 | 6.41 | 5.51 | 4 | 7 |  |
| 134 | 135.2 | 139.67 | 7.01 | 6.03 | 4 | 7 |  |

## Screenshots

- `/repo/docs/bench/browser-screenshots/2026-08-05T17-11-11-039Z/sample-0001.png`
- `/repo/docs/bench/browser-screenshots/2026-08-05T17-11-11-039Z/sample-0031.png`
- `/repo/docs/bench/browser-screenshots/2026-08-05T17-11-11-039Z/sample-0061.png`
- `/repo/docs/bench/browser-screenshots/2026-08-05T17-11-11-039Z/sample-0091.png`
- `/repo/docs/bench/browser-screenshots/2026-08-05T17-11-11-039Z/sample-0121.png`
