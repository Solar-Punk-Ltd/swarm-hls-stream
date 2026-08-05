# engine-restart: what a viewer saw

**2026-08-05T17:20:31.378Z.** Chrome 151.0.7922.75, headed against an X display on the deployment host, watching a 0.25s-GOP broadcast through the shipped client while `latbench-srs-1` was restarted.

`http://127.0.0.1:10074/#/watch/video/8d8a30ff4cbcf8ad0e0773547686295f8157feb0/06b0ad3f-e380-4e02-b697-7ae90a88a19e?qoe=1`

The fault landed 46.7s into the run and was lifted at 77.2s.

## The instrument was sound

All 135 samples came from a page reporting `visibilityState: visible`, with a 100ms timer keeping its schedule and a build that can decode H.264 and AAC. Nothing below is the harness degrading its own subject, which is the failure that blocked this measurement until now.

## What the viewer saw

`latbench-srs-1` was **restarted** for 30.5s, which breaks the ingest engine, which takes the publisher connection with it.

| | media seconds per wall second | over |
| --- | ---: | ---: |
| before the fault | 0.997 | 44.7s |
| while it was down | 0.250 | 31.5s |
| after it came back | 0.000 | 60.9s |

| | |
| --- | ---: |
| longest stretch the picture did not move | 84.3s |
| it stopped, after the fault | 7.1s |
| it moved again, after the service returned | — |
| behind live before | 5.86s |
| behind live after | 5.68s |

## Against what this scenario expected

> The broadcast this viewer is watching ends. They should be told the feed has stopped advancing rather than left on a frozen picture that still claims to be live.

⛔ **The picture stopped for 84.3s.** Expected for this fault, and the length is the finding.

✅ **The client said why.** While the picture was stopped it showed: "Waiting for the broadcast to continue". A viewer who is told the stream is reconnecting waits. One looking at a frozen frame reloads, or leaves.

⛔ **It did not recover.** Playback was still stopped on the last sample, however long after the service returned. A viewer would be looking at a frozen picture with nothing left to wait for.

## What playback did

| | |
| --- | ---: |
| samples | 135 over 137.1s |
| **media seconds per wall second, whole session** | **0.383** |
| media seconds per wall second, typical sample | 0.000 |
| samples where playback did not advance | 83 |
| rebuffers the player counted | 1, totalling 0ms |
| fatal errors | 0 |
| dropped frames | 7 |
| buffered ahead of the playhead, median | 0.05s |
| resolution decoded | 1280×720 |

The advance ratio is `currentTime` against the wall clock, which is the one measurement here that does not go through the overlay: a stalled player still reports a latency and still renders, and this is what says whether the picture was moving.

**Read the whole-session ratio, not the typical sample.** Playback either runs at its rate or is stopped, so the typical sample reads 1.000 in any session that plays at all, including one that spends a sixth of its time frozen. The gap between the two rows is the rebuffering.

## Where the time went

| | |
| --- | ---: |
| segment requests | 199 for 198 distinct segments |
| refused (404, not yet retrievable) | 0 (0.0% of requests) |
| segments refused at least once | 0 |
| segments never served at all | 0 |
| **time spent waiting between attempts** | **0ms** |
| median successful transfer | 92ms |
| segment bytes delivered | 125 kB/s |
| most segment fetches in flight at once | 2 |

The waiting figure accounts for **0%** of the 0ms this session spent rebuffering. It is measured between one attempt ending and the next starting, so it contains no transfer time and cannot be inflated by a slow gateway: it is time the player chose to spend doing nothing, which on a refused fragment is `fragLoadPolicy.errorRetry.retryDelayMs`.

## Every sample

| # | t (s) | currentTime | behind live (s) | buffered ahead (s) | readyState | rebuffers | what the client said |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 0.0 | 5.52 | — | 0.11 | 1 | 0 |  |
| 2 | 1.1 | 6.52 | 5.38 | 2.87 | 4 | 0 |  |
| 3 | 2.1 | 7.53 | 4.12 | 3.74 | 4 | 0 |  |
| 4 | 3.1 | 8.53 | 6.14 | 3.76 | 4 | 0 |  |
| 5 | 4.1 | 9.55 | 5.59 | 4.96 | 4 | 0 |  |
| 6 | 5.2 | 10.54 | 5.94 | 5.33 | 4 | 0 |  |
| 7 | 6.2 | 11.55 | 6.29 | 5.34 | 4 | 0 |  |
| 8 | 7.2 | 12.57 | 5.79 | 5.35 | 4 | 0 |  |
| 9 | 8.2 | 13.57 | 5.90 | 5.37 | 4 | 0 |  |
| 10 | 9.2 | 14.57 | 6.02 | 5.23 | 4 | 0 |  |
| 11 | 10.2 | 15.58 | 6.27 | 5.58 | 4 | 0 |  |
| 12 | 11.2 | 16.59 | 5.87 | 5.42 | 4 | 0 |  |
| 13 | 12.2 | 17.58 | 6.00 | 5.46 | 4 | 0 |  |
| 14 | 13.2 | 18.58 | 6.02 | 5.29 | 4 | 0 |  |
| 15 | 14.2 | 19.58 | 5.93 | 5.33 | 4 | 0 |  |
| 16 | 15.2 | 20.59 | 5.87 | 5.35 | 4 | 0 |  |
| 17 | 16.2 | 21.60 | 5.11 | 4.67 | 4 | 0 |  |
| 18 | 17.3 | 22.63 | 6.30 | 4.85 | 4 | 0 |  |
| 19 | 18.3 | 23.65 | 5.84 | 5.19 | 4 | 0 |  |
| 20 | 19.3 | 24.64 | 5.99 | 5.36 | 4 | 0 |  |
| 21 | 20.3 | 25.65 | 5.36 | 4.89 | 4 | 0 |  |
| 22 | 21.3 | 26.67 | 6.24 | 5.07 | 4 | 0 |  |
| 23 | 22.3 | 27.69 | 5.73 | 5.25 | 4 | 0 |  |
| 24 | 23.3 | 28.70 | 5.93 | 5.26 | 4 | 0 |  |
| 25 | 24.3 | 29.71 | 5.94 | 5.28 | 4 | 0 |  |
| 26 | 25.3 | 30.70 | 5.98 | 5.31 | 4 | 0 |  |
| 27 | 26.3 | 31.71 | 6.02 | 5.49 | 4 | 0 |  |
| 28 | 27.3 | 32.72 | 5.64 | 5.00 | 4 | 0 |  |
| 29 | 28.4 | 33.73 | 5.07 | 4.50 | 4 | 0 |  |
| 30 | 29.4 | 34.76 | 6.27 | 4.31 | 4 | 0 |  |
| 31 | 30.4 | 35.78 | 5.99 | 5.35 | 4 | 0 |  |
| 32 | 31.6 | 36.99 | 5.95 | 4.99 | 4 | 0 |  |
| 33 | 32.6 | 38.00 | 5.45 | 4.50 | 4 | 0 |  |
| 34 | 33.6 | 38.99 | 6.03 | 5.04 | 4 | 0 |  |
| 35 | 34.6 | 40.00 | 6.06 | 5.20 | 4 | 0 |  |
| 36 | 35.6 | 41.01 | 5.26 | 4.38 | 4 | 0 |  |
| 37 | 36.6 | 42.02 | 5.59 | 4.74 | 4 | 0 |  |
| 38 | 37.6 | 43.03 | 5.66 | 4.76 | 4 | 0 |  |
| 39 | 38.6 | 44.05 | 5.99 | 5.10 | 4 | 0 |  |
| 40 | 39.6 | 45.06 | 5.52 | 4.61 | 4 | 0 |  |
| 41 | 40.7 | 46.06 | 5.86 | 4.97 | 4 | 0 |  |
| 42 | 41.7 | 47.07 | 5.92 | 4.98 | 4 | 0 |  |
| 43 | 42.7 | 48.08 | 5.72 | 4.83 | 4 | 0 |  |
| 44 | 43.7 | 49.09 | 5.79 | 4.84 | 4 | 0 |  |
| 45 | 44.7 | 50.10 | 5.86 | 4.85 | 4 | 0 |  |
| 46 | 46.7 | 52.13 | 6.01 | 4.53 | 4 | 0 |  |
| 47 | 47.7 | 53.14 | 5.43 | 4.89 | 4 | 0 |  |
| 48 | 48.7 | 54.14 | 5.43 | 3.88 | 4 | 0 |  |
| 49 | 49.8 | 55.15 | 5.43 | 2.87 | 4 | 0 |  |
| 50 | 50.8 | 56.16 | 5.43 | 1.86 | 4 | 0 |  |
| 51 | 51.8 | 57.17 | 5.43 | 0.85 | 4 | 0 |  |
| 52 | 52.8 | 57.98 | 5.43 | 0.05 | 2 | 1 |  |
| 53 | 53.8 | 57.98 | 5.68 | 0.05 | 2 | 1 |  |
| 54 | 54.8 | 57.98 | 5.68 | 0.05 | 2 | 1 |  |
| 55 | 55.8 | 57.98 | 5.68 | 0.05 | 2 | 1 |  |
| 56 | 56.8 | 57.98 | 5.68 | 0.05 | 2 | 1 |  |
| 57 | 57.8 | 57.98 | 5.68 | 0.05 | 2 | 1 |  |
| 58 | 58.8 | 57.98 | 5.68 | 0.05 | 2 | 1 |  |
| 59 | 59.9 | 57.98 | 5.68 | 0.05 | 2 | 1 |  |
| 60 | 60.9 | 57.98 | 5.68 | 0.05 | 2 | 1 |  |
| 61 | 61.9 | 57.98 | 5.68 | 0.05 | 2 | 1 |  |
| 62 | 63.1 | 57.98 | 5.68 | 0.05 | 2 | 1 |  |
| 63 | 64.1 | 57.98 | 5.68 | 0.05 | 2 | 1 |  |
| 64 | 65.1 | 57.98 | 5.68 | 0.05 | 2 | 1 |  |
| 65 | 66.1 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 66 | 67.1 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 67 | 68.1 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 68 | 69.1 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 69 | 70.1 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 70 | 71.1 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 71 | 72.1 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 72 | 73.2 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 73 | 74.2 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 74 | 75.2 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 75 | 76.2 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 76 | 77.2 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 77 | 78.2 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 78 | 79.2 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 79 | 80.2 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 80 | 81.2 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 81 | 82.2 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 82 | 83.2 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 83 | 84.3 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 84 | 85.3 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 85 | 86.3 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 86 | 87.3 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 87 | 88.3 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 88 | 89.3 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 89 | 90.3 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 90 | 91.3 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 91 | 92.3 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 92 | 93.5 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 93 | 94.5 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 94 | 95.5 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 95 | 96.5 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 96 | 97.5 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 97 | 98.5 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 98 | 99.6 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 99 | 100.6 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 100 | 101.6 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 101 | 102.6 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 102 | 103.6 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 103 | 104.6 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 104 | 105.6 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 105 | 106.6 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 106 | 107.6 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 107 | 108.6 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 108 | 109.7 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 109 | 110.7 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 110 | 111.7 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 111 | 112.7 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 112 | 113.7 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 113 | 114.7 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 114 | 115.7 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 115 | 116.7 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 116 | 117.7 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 117 | 118.7 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 118 | 119.7 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 119 | 120.7 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 120 | 121.8 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 121 | 122.8 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 122 | 124.0 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 123 | 125.0 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 124 | 126.0 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 125 | 127.0 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 126 | 128.0 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 127 | 129.0 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 128 | 130.0 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 129 | 131.0 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 130 | 132.0 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 131 | 133.0 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 132 | 134.0 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 133 | 135.0 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 134 | 136.1 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |
| 135 | 137.1 | 57.98 | 5.68 | 0.05 | 2 | 1 | Waiting for the broadcast to continue |

## Screenshots

- `/repo/docs/bench/browser-screenshots/2026-08-05T17-20-31-378Z/sample-0001.png`
- `/repo/docs/bench/browser-screenshots/2026-08-05T17-20-31-378Z/sample-0031.png`
- `/repo/docs/bench/browser-screenshots/2026-08-05T17-20-31-378Z/sample-0061.png`
- `/repo/docs/bench/browser-screenshots/2026-08-05T17-20-31-378Z/sample-0091.png`
- `/repo/docs/bench/browser-screenshots/2026-08-05T17-20-31-378Z/sample-0121.png`
