# viewer-gateway-outage: what a viewer saw

**2026-08-06T05:13:27.811Z.** Chrome 151.0.7922.75, headed against an X display on the deployment host, watching a 0.25s-GOP broadcast through the shipped client while `latbench-bee-gateway-1` was stopped.

`http://127.0.0.1:10074/#/watch/video/8d8a30ff4cbcf8ad0e0773547686295f8157feb0/7bdfd76d-4cad-4f17-ada8-d30b6c44a58a?qoe=1`

The fault landed 46.2s into the run and was lifted at 66.7s.

## The instrument was sound

All 125 samples came from a page reporting `visibilityState: visible`, with a 100ms timer keeping its schedule and a build that can decode H.264 and AAC. Nothing below is the harness degrading its own subject, which is the failure that blocked this measurement until now.

## What the viewer saw

`latbench-bee-gateway-1` was **stopped** for 20.5s, which breaks the bee node a viewer reads segments and feed slots through.

| | media seconds per wall second | over |
| --- | ---: | ---: |
| before the fault | 0.998 | 44.7s |
| while it was down | 0.203 | 25.1s |
| after it came back | 1.356 | 56.7s |

| | |
| --- | ---: |
| longest stretch the picture did not move | 29.6s |
| it stopped, after the fault | 5.0s |
| the service took, to answer after docker returned | 3.5s |
| it moved again, after the service **answered** | 10.7s |
| behind live before | 5.80s |
| behind live after | 5.71s |

## Against what this scenario expected

> The picture plays out whatever is buffered and then stops. The client should say so rather than leave a frozen frame unexplained, and should resume on its own once the gateway answers again, without a reload and without ending the broadcast.

⛔ **The picture stopped for 29.6s.** Expected for this fault, and the length is the finding.

✅ **The client said why.** While the picture was stopped it showed: "Reconnecting to the stream". A viewer who is told the stream is reconnecting waits. One looking at a frozen frame reloads, or leaves.

✅ **It recovered on its own**, 10.7s after the service came back, with no reload and nothing asked of the viewer.

## What playback did

| | |
| --- | ---: |
| samples | 125 over 126.5s |
| **media seconds per wall second, whole session** | **1.001** |
| media seconds per wall second, typical sample | 1.000 |
| samples where playback did not advance | 29 |
| rebuffers the player counted | 6, totalling 31806ms |
| fatal errors | 0 |
| dropped frames | 45 |
| buffered ahead of the playhead, median | 4.62s |
| resolution decoded | 1280×720 |

The advance ratio is `currentTime` against the wall clock, which is the one measurement here that does not go through the overlay: a stalled player still reports a latency and still renders, and this is what says whether the picture was moving.

**Read the whole-session ratio, not the typical sample.** Playback either runs at its rate or is stopped, so the typical sample reads 1.000 in any session that plays at all, including one that spends a sixth of its time frozen. The gap between the two rows is the rebuffering.

## Where the time went

| | |
| --- | ---: |
| segment requests | 775 for 464 distinct segments |
| refused (404, not yet retrievable) | 1 (0.1% of requests) |
| segments refused at least once | 1 |
| segments never served at all | 0 |
| **time spent waiting between attempts** | **22417ms** |
| median successful transfer | 91ms |
| segment bytes delivered | 315 kB/s |
| most segment fetches in flight at once | 5 |

The waiting figure accounts for **70%** of the 31806ms this session spent rebuffering. It is measured between one attempt ending and the next starting, so it contains no transfer time and cannot be inflated by a slow gateway: it is time the player chose to spend doing nothing, which on a refused fragment is `fragLoadPolicy.errorRetry.retryDelayMs`.

## Every sample

| # | t (s) | currentTime | behind live (s) | buffered ahead (s) | readyState | rebuffers | what the client said |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 0.0 | 5.49 | — | 0.23 | 1 | 0 |  |
| 2 | 1.1 | 6.50 | 5.87 | 3.48 | 4 | 0 |  |
| 3 | 2.2 | 7.51 | 4.85 | 4.01 | 4 | 0 |  |
| 4 | 3.2 | 8.52 | 4.39 | 4.37 | 4 | 0 |  |
| 5 | 4.2 | 9.56 | 6.03 | 5.21 | 4 | 0 |  |
| 6 | 5.2 | 10.55 | 5.56 | 5.58 | 4 | 0 |  |
| 7 | 6.2 | 11.56 | 5.91 | 5.08 | 4 | 0 |  |
| 8 | 7.2 | 12.56 | 5.44 | 5.62 | 4 | 0 |  |
| 9 | 8.2 | 13.57 | 6.04 | 5.63 | 4 | 0 |  |
| 10 | 9.2 | 14.63 | 6.09 | 5.43 | 4 | 0 |  |
| 11 | 10.2 | 15.64 | 5.87 | 5.27 | 4 | 0 |  |
| 12 | 11.2 | 16.64 | 5.47 | 4.78 | 4 | 0 |  |
| 13 | 12.2 | 17.65 | 5.27 | 4.79 | 4 | 0 |  |
| 14 | 13.2 | 18.66 | 6.05 | 5.48 | 4 | 0 |  |
| 15 | 14.3 | 19.66 | 5.95 | 5.52 | 4 | 0 |  |
| 16 | 15.3 | 20.65 | 6.03 | 5.56 | 4 | 0 |  |
| 17 | 16.3 | 21.66 | 5.56 | 5.06 | 4 | 0 |  |
| 18 | 17.3 | 22.66 | 5.91 | 5.42 | 4 | 0 |  |
| 19 | 18.3 | 23.66 | 5.99 | 5.45 | 4 | 0 |  |
| 20 | 19.3 | 24.68 | 6.08 | 5.59 | 4 | 0 |  |
| 21 | 20.3 | 25.69 | 5.83 | 5.29 | 4 | 0 |  |
| 22 | 21.3 | 26.69 | 5.94 | 5.32 | 4 | 0 |  |
| 23 | 22.3 | 27.70 | 6.06 | 4.97 | 4 | 0 |  |
| 24 | 23.3 | 28.70 | 6.05 | 5.52 | 4 | 0 |  |
| 25 | 24.3 | 29.71 | 5.85 | 5.36 | 4 | 0 |  |
| 26 | 25.4 | 30.72 | 5.12 | 4.53 | 4 | 0 |  |
| 27 | 26.4 | 31.72 | 6.04 | 5.40 | 4 | 0 |  |
| 28 | 27.4 | 32.73 | 5.52 | 4.90 | 4 | 0 |  |
| 29 | 28.4 | 33.72 | 5.87 | 5.28 | 4 | 0 |  |
| 30 | 29.4 | 34.72 | 6.12 | 5.30 | 4 | 0 |  |
| 31 | 30.4 | 35.73 | 6.04 | 5.47 | 4 | 0 |  |
| 32 | 31.5 | 36.87 | 5.81 | 5.03 | 4 | 0 |  |
| 33 | 32.5 | 37.88 | 5.61 | 4.88 | 4 | 0 |  |
| 34 | 33.6 | 38.87 | 6.05 | 5.25 | 4 | 0 |  |
| 35 | 34.6 | 39.88 | 6.17 | 5.26 | 4 | 0 |  |
| 36 | 35.6 | 40.89 | 5.56 | 4.77 | 4 | 0 |  |
| 37 | 36.6 | 41.89 | 5.89 | 5.13 | 4 | 0 |  |
| 38 | 37.6 | 42.88 | 5.99 | 5.16 | 4 | 0 |  |
| 39 | 38.6 | 43.90 | 6.09 | 5.17 | 4 | 0 |  |
| 40 | 39.6 | 44.93 | 6.11 | 5.34 | 4 | 0 |  |
| 41 | 40.6 | 46.01 | 6.11 | 5.28 | 4 | 0 |  |
| 42 | 41.6 | 47.03 | 5.94 | 5.10 | 4 | 0 |  |
| 43 | 42.6 | 48.04 | 5.14 | 4.28 | 4 | 0 |  |
| 44 | 43.6 | 49.06 | 6.08 | 5.13 | 4 | 0 |  |
| 45 | 44.7 | 50.07 | 5.80 | 4.98 | 4 | 0 |  |
| 46 | 46.2 | 51.67 | 6.27 | 3.55 | 4 | 0 | Reconnecting to the stream |
| 47 | 47.3 | 52.76 | 6.17 | 2.46 | 4 | 0 | Reconnecting to the stream |
| 48 | 48.3 | 53.81 | 6.12 | 1.40 | 4 | 0 | Reconnecting to the stream |
| 49 | 49.3 | 54.85 | 6.09 | 0.37 | 4 | 0 | Reconnecting to the stream |
| 50 | 50.3 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 51 | 51.3 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 52 | 52.3 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 53 | 53.3 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 54 | 54.3 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 55 | 55.3 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 56 | 56.3 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 57 | 57.3 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 58 | 58.3 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 59 | 59.4 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 60 | 60.4 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 61 | 61.4 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 62 | 62.5 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 63 | 63.5 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 64 | 64.5 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 65 | 65.6 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 66 | 66.8 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 67 | 67.8 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 68 | 68.8 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 69 | 69.8 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 70 | 70.8 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 71 | 71.8 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 72 | 72.8 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 73 | 73.8 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 74 | 74.8 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 75 | 75.8 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 76 | 76.8 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 77 | 77.9 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 78 | 78.9 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 79 | 79.9 | 55.17 | 6.34 | 0.04 | 2 | 1 | Reconnecting to the stream |
| 80 | 80.9 | 55.86 | 6.25 | 1.75 | 4 | 1 |  |
| 81 | 81.9 | 56.86 | 5.31 | 3.47 | 4 | 1 |  |
| 82 | 82.9 | 57.89 | 9.12 | 5.17 | 4 | 1 |  |
| 83 | 83.9 | 64.49 | 6.92 | 1.48 | 4 | 2 |  |
| 84 | 84.9 | 65.52 | 10.33 | 3.35 | 4 | 2 |  |
| 85 | 85.9 | 73.48 | 6.49 | 1.02 | 4 | 3 |  |
| 86 | 86.9 | 74.52 | 10.05 | 2.68 | 4 | 3 |  |
| 87 | 88.0 | 82.07 | 6.47 | 0.96 | 4 | 4 |  |
| 88 | 89.0 | 83.11 | 9.90 | 3.16 | 4 | 4 |  |
| 89 | 90.0 | 90.39 | 6.70 | 0.66 | 4 | 5 |  |
| 90 | 91.0 | 91.43 | 10.38 | 2.53 | 4 | 5 |  |
| 91 | 92.0 | 97.58 | 12.55 | 0.95 | 4 | 6 |  |
| 92 | 93.1 | 98.74 | 6.27 | 2.73 | 4 | 6 |  |
| 93 | 94.1 | 99.74 | 5.34 | 4.28 | 4 | 6 |  |
| 94 | 95.1 | 100.75 | 5.85 | 4.98 | 4 | 6 |  |
| 95 | 96.2 | 101.76 | 5.57 | 4.65 | 4 | 6 |  |
| 96 | 97.2 | 102.77 | 5.71 | 4.83 | 4 | 6 |  |
| 97 | 98.2 | 103.78 | 5.45 | 4.51 | 4 | 6 |  |
| 98 | 99.2 | 104.79 | 5.78 | 4.87 | 4 | 6 |  |
| 99 | 100.2 | 105.79 | 5.84 | 4.89 | 4 | 6 |  |
| 100 | 101.2 | 106.80 | 5.64 | 4.73 | 4 | 6 |  |
| 101 | 102.2 | 107.81 | 5.72 | 4.75 | 4 | 6 |  |
| 102 | 103.2 | 108.82 | 5.82 | 4.92 | 4 | 6 |  |
| 103 | 104.2 | 109.82 | 5.94 | 4.95 | 4 | 6 |  |
| 104 | 105.2 | 110.83 | 5.68 | 4.77 | 4 | 6 |  |
| 105 | 106.2 | 111.83 | 5.71 | 4.82 | 4 | 6 |  |
| 106 | 107.2 | 112.84 | 4.97 | 3.98 | 4 | 6 |  |
| 107 | 108.2 | 113.85 | 5.58 | 4.68 | 4 | 6 |  |
| 108 | 109.3 | 114.85 | 5.64 | 4.70 | 4 | 6 |  |
| 109 | 110.3 | 115.86 | 5.71 | 4.72 | 4 | 6 |  |
| 110 | 111.3 | 116.87 | 5.24 | 4.22 | 4 | 6 |  |
| 111 | 112.3 | 117.88 | 5.84 | 4.92 | 4 | 6 |  |
| 112 | 113.3 | 118.89 | 5.64 | 4.59 | 4 | 6 |  |
| 113 | 114.3 | 119.89 | 5.72 | 4.77 | 4 | 6 |  |
| 114 | 115.3 | 120.90 | 5.51 | 4.46 | 4 | 6 |  |
| 115 | 116.3 | 121.91 | 5.59 | 4.62 | 4 | 6 |  |
| 116 | 117.3 | 122.92 | 5.64 | 4.66 | 4 | 6 |  |
| 117 | 118.3 | 123.93 | 5.71 | 4.68 | 4 | 6 |  |
| 118 | 119.3 | 124.93 | 5.51 | 4.52 | 4 | 6 |  |
| 119 | 120.3 | 125.94 | 4.77 | 3.68 | 4 | 6 |  |
| 120 | 121.3 | 126.95 | 5.64 | 4.55 | 4 | 6 |  |
| 121 | 122.4 | 127.96 | 5.74 | 4.71 | 4 | 6 |  |
| 122 | 123.5 | 129.11 | 5.77 | 4.78 | 4 | 6 |  |
| 123 | 124.5 | 130.12 | 5.04 | 4.12 | 4 | 6 |  |
| 124 | 125.5 | 131.12 | 5.64 | 4.65 | 4 | 6 |  |
| 125 | 126.5 | 132.13 | 5.71 | 4.80 | 4 | 6 |  |

## Screenshots

- `/repo/docs/bench/browser-screenshots/2026-08-06T05-13-27-811Z/sample-0001.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-13-27-811Z/sample-0031.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-13-27-811Z/sample-0061.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-13-27-811Z/sample-0091.png`
- `/repo/docs/bench/browser-screenshots/2026-08-06T05-13-27-811Z/sample-0121.png`
