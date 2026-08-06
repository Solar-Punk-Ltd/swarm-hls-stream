# writer-bee-outage: what a viewer saw

**2026-08-06T05:38:54.740Z.** Chrome 151.0.7922.75, headed against an X display on the deployment host, watching a 0.25s-GOP broadcast through the shipped client while `latbench-bee-uploader-1` was stopped.

`http://127.0.0.1:10074/#/watch/video/8d8a30ff4cbcf8ad0e0773547686295f8157feb0/1ba056a4-51dc-4cf0-b0d1-9ac521b1432b?qoe=1`

The fault landed 46.0s into the run and was lifted at 66.4s.

## The instrument was sound

All 164 samples came from a page reporting `visibilityState: visible`, with a 100ms timer keeping its schedule and a build that can decode H.264 and AAC. Nothing below is the harness degrading its own subject, which is the failure that blocked this measurement until now.

## What the viewer saw

`latbench-bee-uploader-1` was **stopped** for 20.4s, which breaks the bee node the uploader writes through, for longer than it can retry.

| | media seconds per wall second | over |
| --- | ---: | ---: |
| before the fault | 1.002 | 44.6s |
| while it was down | 0.275 | 24.8s |
| after it came back | 1.176 | 96.1s |

| | |
| --- | ---: |
| longest stretch the picture did not move | 54.9s |
| it stopped, after the fault | 7.1s |
| the service took, to answer after docker returned | 3.6s |
| it moved again, after the service **answered** | 37.9s |
| behind live before | 6.28s |
| behind live after | 6.86s |

## Against what this scenario expected

> The segment in flight is dropped and a discontinuity is armed, so the viewer meets a break in the timeline rather than a gap in the numbering. The picture should stop while nothing is being written and then resume across the discontinuity without a reload and without ending the broadcast.

⛔ **The picture stopped for 54.9s.** Expected for this fault, and the length is the finding.

✅ **The client said why.** While the picture was stopped it showed: "Waiting for the broadcast to continue". A viewer who is told the stream is reconnecting waits. One looking at a frozen frame reloads, or leaves.

✅ **It recovered on its own**, 37.9s after the service came back, with no reload and nothing asked of the viewer.

## What playback did

| | |
| --- | ---: |
| samples | 164 over 165.6s |
| **media seconds per wall second, whole session** | **0.994** |
| media seconds per wall second, typical sample | 0.995 |
| samples where playback did not advance | 54 |
| rebuffers the player counted | 7, totalling 57559ms |
| fatal errors | 0 |
| dropped frames | 49 |
| buffered ahead of the playhead, median | 4.53s |
| resolution decoded | 1280×720 |

The advance ratio is `currentTime` against the wall clock, which is the one measurement here that does not go through the overlay: a stalled player still reports a latency and still renders, and this is what says whether the picture was moving.

**Read the whole-session ratio, not the typical sample.** Playback either runs at its rate or is stopped, so the typical sample reads 1.000 in any session that plays at all, including one that spends a sixth of its time frozen. The gap between the two rows is the rebuffering.

## Where the time went

| | |
| --- | ---: |
| segment requests | 536 for 534 distinct segments |
| refused (404, not yet retrievable) | 1 (0.2% of requests) |
| segments refused at least once | 1 |
| segments never served at all | 0 |
| **time spent waiting between attempts** | **0ms** |
| median successful transfer | 87ms |
| segment bytes delivered | 278 kB/s |
| most segment fetches in flight at once | 2 |

The waiting figure accounts for **0%** of the 57559ms this session spent rebuffering. It is measured between one attempt ending and the next starting, so it contains no transfer time and cannot be inflated by a slow gateway: it is time the player chose to spend doing nothing, which on a refused fragment is `fragLoadPolicy.errorRetry.retryDelayMs`.

## Every sample

| # | t (s) | currentTime | behind live (s) | buffered ahead (s) | readyState | rebuffers | what the client said |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 0.0 | 5.49 | — | 0.23 | 1 | 0 |  |
| 2 | 1.1 | 6.57 | 5.32 | 3.08 | 4 | 0 |  |
| 3 | 2.2 | 7.57 | 4.72 | 4.29 | 4 | 0 |  |
| 4 | 3.2 | 8.59 | 6.39 | 3.96 | 4 | 0 |  |
| 5 | 4.2 | 9.66 | 5.53 | 5.11 | 4 | 0 |  |
| 6 | 5.2 | 10.68 | 6.43 | 5.11 | 4 | 0 |  |
| 7 | 6.2 | 11.76 | 6.42 | 5.71 | 4 | 0 |  |
| 8 | 7.2 | 12.80 | 5.88 | 5.38 | 4 | 0 |  |
| 9 | 8.2 | 13.81 | 5.88 | 4.37 | 4 | 0 |  |
| 10 | 9.2 | 14.84 | 5.96 | 5.03 | 4 | 0 |  |
| 11 | 10.2 | 15.85 | 5.76 | 4.72 | 4 | 0 |  |
| 12 | 11.3 | 16.85 | 5.87 | 4.88 | 4 | 0 |  |
| 13 | 12.3 | 17.86 | 5.63 | 4.59 | 4 | 0 |  |
| 14 | 13.3 | 18.87 | 5.96 | 4.94 | 4 | 0 |  |
| 15 | 14.3 | 19.87 | 6.04 | 4.97 | 4 | 0 |  |
| 16 | 15.3 | 20.86 | 5.85 | 4.83 | 4 | 0 |  |
| 17 | 16.3 | 21.87 | 5.92 | 4.84 | 4 | 0 |  |
| 18 | 17.3 | 22.89 | 5.98 | 4.85 | 4 | 0 |  |
| 19 | 18.3 | 23.89 | 6.05 | 5.04 | 4 | 0 |  |
| 20 | 19.3 | 24.90 | 5.85 | 4.71 | 4 | 0 |  |
| 21 | 20.3 | 25.89 | 5.95 | 4.90 | 4 | 0 |  |
| 22 | 21.3 | 26.90 | 5.20 | 4.08 | 4 | 0 |  |
| 23 | 22.3 | 27.91 | 5.54 | 4.44 | 4 | 0 |  |
| 24 | 23.3 | 28.92 | 6.26 | 4.96 | 4 | 0 |  |
| 25 | 24.4 | 29.93 | 6.02 | 5.31 | 4 | 0 |  |
| 26 | 25.4 | 30.95 | 6.17 | 5.32 | 4 | 0 |  |
| 27 | 26.4 | 31.95 | 5.28 | 4.66 | 4 | 0 |  |
| 28 | 27.4 | 32.95 | 6.13 | 5.20 | 4 | 0 |  |
| 29 | 28.4 | 33.96 | 5.70 | 5.04 | 4 | 0 |  |
| 30 | 29.4 | 34.97 | 5.86 | 5.06 | 4 | 0 |  |
| 31 | 30.4 | 35.95 | 5.76 | 4.41 | 4 | 0 |  |
| 32 | 31.6 | 37.11 | 6.16 | 5.13 | 4 | 0 |  |
| 33 | 32.6 | 38.11 | 6.09 | 5.49 | 4 | 0 |  |
| 34 | 33.6 | 39.13 | 5.54 | 5.17 | 4 | 0 |  |
| 35 | 34.6 | 40.13 | 5.95 | 5.02 | 4 | 0 |  |
| 36 | 35.6 | 41.14 | 5.89 | 4.52 | 4 | 0 |  |
| 37 | 36.6 | 42.13 | 6.13 | 4.38 | 4 | 0 |  |
| 38 | 37.6 | 43.14 | 5.84 | 5.42 | 4 | 0 |  |
| 39 | 38.6 | 44.14 | 5.95 | 5.27 | 4 | 0 |  |
| 40 | 39.6 | 45.14 | 6.16 | 5.64 | 4 | 0 |  |
| 41 | 40.6 | 46.15 | 6.24 | 5.45 | 4 | 0 |  |
| 42 | 41.6 | 47.16 | 6.21 | 5.49 | 4 | 0 |  |
| 43 | 42.6 | 48.19 | 5.88 | 5.48 | 4 | 0 |  |
| 44 | 43.6 | 49.20 | 5.80 | 5.33 | 4 | 0 |  |
| 45 | 44.6 | 50.21 | 6.28 | 5.34 | 4 | 0 |  |
| 46 | 46.0 | 51.54 | 6.17 | 5.39 | 4 | 0 |  |
| 47 | 47.0 | 52.55 | 5.32 | 4.54 | 4 | 0 |  |
| 48 | 48.0 | 53.56 | 5.32 | 3.53 | 4 | 0 |  |
| 49 | 49.0 | 54.57 | 5.32 | 2.53 | 4 | 0 |  |
| 50 | 50.0 | 55.58 | 5.32 | 1.52 | 4 | 0 |  |
| 51 | 51.0 | 56.59 | 5.32 | 0.51 | 4 | 0 |  |
| 52 | 52.0 | 57.03 | 5.32 | 0.06 | 2 | 1 |  |
| 53 | 53.0 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 54 | 54.0 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 55 | 55.0 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 56 | 56.0 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 57 | 57.1 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 58 | 58.1 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 59 | 59.1 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 60 | 60.1 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 61 | 61.1 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 62 | 62.2 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 63 | 63.2 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 64 | 64.2 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 65 | 65.2 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 66 | 66.4 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 67 | 67.4 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 68 | 68.4 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 69 | 69.4 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 70 | 70.4 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 71 | 71.5 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 72 | 72.5 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 73 | 73.5 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 74 | 74.5 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 75 | 75.5 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 76 | 76.5 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 77 | 77.5 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 78 | 78.5 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 79 | 79.5 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 80 | 80.5 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 81 | 81.5 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 82 | 82.5 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 83 | 83.6 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 84 | 84.6 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 85 | 85.6 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 86 | 86.6 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 87 | 87.6 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 88 | 88.6 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 89 | 89.6 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 90 | 90.6 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 91 | 91.6 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 92 | 92.8 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 93 | 93.8 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 94 | 94.8 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 95 | 95.8 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 96 | 96.8 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 97 | 97.8 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 98 | 98.8 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 99 | 99.8 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 100 | 100.9 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 101 | 101.9 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 102 | 102.9 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 103 | 103.9 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 104 | 104.9 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 105 | 105.9 | 57.03 | 5.57 | 0.06 | 2 | 1 | Waiting for the broadcast to continue |
| 106 | 106.9 | 57.03 | 5.57 | 0.06 | 2 | 1 |  |
| 107 | 107.9 | 57.51 | 0.94 | 0.30 | 4 | 1 |  |
| 108 | 108.9 | 57.81 | 1.21 | 0.85 | 4 | 2 |  |
| 109 | 109.9 | 85.93 | 11.15 | 0.19 | 4 | 3 |  |
| 110 | 110.9 | 86.92 | 6.43 | 2.29 | 4 | 3 |  |
| 111 | 111.9 | 87.93 | 4.50 | 3.67 | 4 | 3 |  |
| 112 | 112.9 | 88.94 | 4.03 | 2.66 | 4 | 3 |  |
| 113 | 113.9 | 89.99 | 7.87 | 4.14 | 4 | 3 |  |
| 114 | 115.0 | 91.09 | 11.08 | 7.30 | 4 | 3 |  |
| 115 | 116.0 | 99.66 | 6.73 | 2.18 | 4 | 4 |  |
| 116 | 117.0 | 100.71 | 10.39 | 4.54 | 4 | 4 |  |
| 117 | 118.0 | 108.36 | 6.77 | 1.67 | 4 | 5 |  |
| 118 | 119.0 | 109.42 | 10.22 | 4.18 | 4 | 5 |  |
| 119 | 120.0 | 116.84 | 6.75 | 1.72 | 4 | 6 |  |
| 120 | 121.0 | 117.90 | 10.27 | 3.39 | 4 | 6 |  |
| 121 | 122.0 | 125.45 | 6.66 | 1.65 | 4 | 7 |  |
| 122 | 123.2 | 126.67 | 8.42 | 4.69 | 4 | 7 |  |
| 123 | 124.2 | 127.78 | 8.14 | 6.49 | 4 | 7 |  |
| 124 | 125.2 | 128.89 | 7.82 | 6.74 | 4 | 7 |  |
| 125 | 126.2 | 130.00 | 7.55 | 6.49 | 4 | 7 |  |
| 126 | 127.2 | 131.10 | 7.25 | 6.22 | 4 | 7 |  |
| 127 | 128.2 | 132.21 | 7.21 | 6.15 | 4 | 7 |  |
| 128 | 129.2 | 133.22 | 6.70 | 5.65 | 4 | 7 |  |
| 129 | 130.2 | 134.30 | 7.25 | 6.11 | 4 | 7 |  |
| 130 | 131.2 | 135.41 | 7.25 | 6.19 | 4 | 7 |  |
| 131 | 132.2 | 136.50 | 7.20 | 6.13 | 4 | 7 |  |
| 132 | 133.2 | 137.51 | 6.71 | 5.63 | 4 | 7 |  |
| 133 | 134.2 | 138.53 | 7.03 | 5.97 | 4 | 7 |  |
| 134 | 135.2 | 139.57 | 7.09 | 5.96 | 4 | 7 |  |
| 135 | 136.2 | 140.64 | 7.08 | 5.91 | 4 | 7 |  |
| 136 | 137.3 | 141.67 | 6.85 | 5.74 | 4 | 7 |  |
| 137 | 138.3 | 142.68 | 6.92 | 6.10 | 4 | 7 |  |
| 138 | 139.3 | 143.66 | 6.72 | 5.93 | 4 | 7 |  |
| 139 | 140.3 | 144.69 | 7.04 | 5.96 | 4 | 7 |  |
| 140 | 141.3 | 145.76 | 7.07 | 6.23 | 4 | 7 |  |
| 141 | 142.3 | 146.74 | 6.86 | 5.95 | 4 | 7 |  |
| 142 | 143.3 | 147.76 | 6.94 | 6.09 | 4 | 7 |  |
| 143 | 144.3 | 148.75 | 6.75 | 5.82 | 4 | 7 |  |
| 144 | 145.3 | 149.80 | 7.05 | 6.14 | 4 | 7 |  |
| 145 | 146.3 | 150.78 | 6.31 | 5.67 | 4 | 7 |  |
| 146 | 147.3 | 151.78 | 6.93 | 6.03 | 4 | 7 |  |
| 147 | 148.3 | 152.81 | 7.00 | 6.37 | 4 | 7 |  |
| 148 | 149.4 | 153.82 | 6.79 | 5.88 | 4 | 7 |  |
| 149 | 150.4 | 154.80 | 6.59 | 5.72 | 4 | 7 |  |
| 150 | 151.4 | 155.80 | 6.94 | 5.77 | 4 | 7 |  |
| 151 | 152.4 | 156.83 | 7.00 | 6.10 | 4 | 7 |  |
| 152 | 153.5 | 157.93 | 6.80 | 5.69 | 4 | 7 |  |
| 153 | 154.5 | 158.93 | 6.87 | 5.87 | 4 | 7 |  |
| 154 | 155.5 | 159.92 | 6.96 | 6.43 | 4 | 7 |  |
| 155 | 156.5 | 160.94 | 7.03 | 5.42 | 4 | 7 |  |
| 156 | 157.5 | 161.94 | 6.95 | 5.26 | 4 | 7 |  |
| 157 | 158.5 | 162.96 | 6.89 | 5.78 | 4 | 7 |  |
| 158 | 159.5 | 163.97 | 6.16 | 5.80 | 4 | 7 |  |
| 159 | 160.5 | 164.99 | 7.01 | 6.14 | 4 | 7 |  |
| 160 | 161.5 | 165.98 | 7.00 | 6.18 | 4 | 7 |  |
| 161 | 162.5 | 166.98 | 6.71 | 6.34 | 4 | 7 |  |
| 162 | 163.6 | 168.00 | 7.02 | 6.55 | 4 | 7 |  |
| 163 | 164.6 | 169.00 | 7.17 | 6.73 | 4 | 7 |  |
| 164 | 165.6 | 170.04 | 6.86 | 6.38 | 4 | 7 |  |

## Screenshots

- `/repo/docs/bench/browser-screenshots/2026-08-06T05-38-54-740Z/sample-0001.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-38-54-740Z/sample-0031.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-38-54-740Z/sample-0061.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-38-54-740Z/sample-0091.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-38-54-740Z/sample-0121.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-38-54-740Z/sample-0151.png`
