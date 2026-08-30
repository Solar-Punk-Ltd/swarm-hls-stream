# A viewer whose rung went quiet

**2026-08-30T02:47:03.957Z.** Chrome 151.0.7922.75, headed against an X display on the deployment host, watching a broadcast at an unrecorded GOP through the shipped client while the 1080p transcode in `latbench-srs-1` was stopped from 45.4s to 135.7s.

Watching `http://127.0.0.1:10074/#/watch/video/8d8a30ff4cbcf8ad0e0773547686295f8157feb0/25b1822f-b82b-4f24-8a6c-ea34f5365382?qoe=1`.

## What was silenced

The viewer settled on **1080p**, and that is the rung this run stopped, for 90.3s. 3 healthy rungs sat beside it throughout: 720p, 480p, 360p.

⛔ Stopped rather than killed. SRS respawns a transcode that exits, so a kill would give a rung that
is quiet for however long a respawn takes rather than for the window this run chose.

| pid | the process that was stopped |
| ---: | --- |
| 3748 | `./objs/ffmpeg/bin/ffmpeg -f flv -i rtmp://127.0.0.1:1935/live/stream?vhost=__defaultVhost__ -vcodec libx264 -b:v 5000000 -r 30.00 -s 1920x1080 -aspect 1920:1080 -profile:v main -preset veryfast -g 60 -keyint_min 60 -sc_threshold 0 -force_key_frames expr:gte(t,n_forced*2) -maxrate 5000k -bufsize 5000k -acodec copy -f flv -y rtmp://127.0.0.1:10072/live/stream_1080p?vhost=abr` |

## What the viewer got

| | rung it ended on | lowest | tallest | media seconds per wall second |
| --- | :---: | :---: | :---: | ---: |
| before the rung went quiet | 1080p | 1080p | 1080p | 1.000 |
| while it was quiet | 1080p | 1080p | 1080p | 0.088 |
| after it spoke again | 1080p | 1080p | 1080p | 0.000 |

| | |
| --- | ---: |
| it moved off the silenced rung, after the outage | it never did |
| it climbed back, after the rung returned | it never did |
| level changes hls.js counted | 0 |
| longest stretch the picture did not move | 87.2s |
| it stopped, after the rung went quiet | 6.1s |
| behind live before | 5.06s |
| behind live after | 1.50s |

⛔ Every duration above is measured and filed rather than held against a ceiling. Owner ruling of
2026-08-29: an e2e suite checks that the feature works and is stable, never how fast it is.

## What this run establishes

✅ **The player was choosing its own rung throughout.**

⛔ **It stayed on 1080p, the rung that had stopped producing.** hls.js changes level on a fragment load ERROR, and a feed that stops advancing does not error, it simply stops offering fragments. A player waiting for one it was never offered has nothing to react to.

✅ **The picture kept moving while the rung was quiet**, at 0.088x.

⛔ **The client said nothing** while the picture was stopped.

✅ **The viewer was never told the broadcast had ended**, which it had not.

## What playback did

| | |
| --- | ---: |
| samples | 193 over 195.4s |
| **media seconds per wall second, whole session** | **0.267** |
| media seconds per wall second, typical sample | 0.000 |
| samples where playback did not advance | 141 |
| forward seeks, and media they skipped | none |
| rebuffers the player counted | 1, totalling 55389ms |
| fatal errors | 0 |
| dropped frames | 9 |
| **frames per second of media** | **29.9** |
| buffered ahead of the playhead, median | 0.05s |
| resolution decoded | 1920×1080 |

The advance ratio is `currentTime` against the wall clock, which is the one measurement here that does not go through the overlay: a stalled player still reports a latency and still renders, and this is what says whether the picture was moving.

**Read the whole-session ratio, not the typical sample.** Playback either runs at its rate or is stopped, so the typical sample reads 1.000 in any session that plays at all, including one that spends a sixth of its time frozen. The gap between the two rows is the rebuffering.

**A seek is not playback, and the whole-session ratio no longer counts it as such.** When latency passes `LIVE_MAX_LATENCY_DURATION_S` hls.js jumps the playhead to the live edge, which is its designed recovery and the normal end of any freeze. Reading `currentTime` at the ends of a run could not tell that from playing throughout, so a freeze and the seek that ended it used to net to 1.000. Media above what the clock allows at the catch-up rate is now counted as skipped and reported on its own row. Replaying the recorded runs through both definitions moved every faulted run and left all 27 clean ones identical to three decimals.

## Where the time went

| | |
| --- | ---: |
| segment requests | 3 for 3 distinct segments |
| refused (404, not yet retrievable) | 0 (0.0% of requests) |
| segments refused at least once | 0 |
| segments never served at all | 0 |
| **time spent waiting between attempts** | **0ms** |
| median successful transfer | 290ms |
| segment bytes delivered | 14 kB/s |
| most segment fetches in flight at once | 2 |

The waiting figure accounts for **0%** of the 55389ms this session spent rebuffering. It is measured between one attempt ending and the next starting, so it contains no transfer time and cannot be inflated by a slow gateway: it is time the player chose to spend doing nothing, which on a refused fragment is `fragLoadPolicy.errorRetry.retryDelayMs`.

## The instrument was sound

All 193 samples came from a page reporting `visibilityState: visible`, with a 100ms timer keeping its schedule and a build that can decode H.264 and AAC. Nothing below is the harness degrading its own subject, which is the failure that blocked this measurement until now.

## Every sample

| # | at | media | rung | delivered | buffer ahead | what the client said |
| ---: | ---: | ---: | :---: | :---: | ---: | --- |
| 1 | 0.0 | 73.36 | 1080p | 1920×1080 | 2.64 |  |
| 2 | 1.1 | 74.50 | 1080p | 1920×1080 | 3.50 |  |
| 3 | 2.2 | 75.51 | 1080p | 1920×1080 | 2.49 |  |
| 4 | 3.2 | 76.60 | 1080p | 1920×1080 | 3.41 |  |
| 5 | 4.2 | 77.60 | 1080p | 1920×1080 | 4.41 |  |
| 6 | 5.3 | 78.61 | 1080p | 1920×1080 | 3.41 |  |
| 7 | 6.3 | 79.62 | 1080p | 1920×1080 | 4.38 |  |
| 8 | 7.3 | 80.63 | 1080p | 1920×1080 | 3.37 |  |
| 9 | 8.3 | 81.64 | 1080p | 1920×1080 | 4.37 |  |
| 10 | 9.3 | 82.64 | 1080p | 1920×1080 | 3.36 |  |
| 11 | 10.3 | 83.65 | 1080p | 1920×1080 | 2.35 |  |
| 12 | 11.4 | 84.76 | 1080p | 1920×1080 | 3.25 |  |
| 13 | 12.4 | 85.77 | 1080p | 1920×1080 | 4.25 |  |
| 14 | 13.4 | 86.78 | 1080p | 1920×1080 | 3.24 |  |
| 15 | 14.4 | 87.79 | 1080p | 1920×1080 | 4.23 |  |
| 16 | 15.4 | 88.80 | 1080p | 1920×1080 | 3.23 |  |
| 17 | 16.4 | 89.81 | 1080p | 1920×1080 | 2.21 |  |
| 18 | 17.5 | 90.90 | 1080p | 1920×1080 | 3.10 |  |
| 19 | 18.6 | 91.91 | 1080p | 1920×1080 | 4.10 |  |
| 20 | 19.6 | 92.92 | 1080p | 1920×1080 | 3.09 |  |
| 21 | 20.6 | 93.93 | 1080p | 1920×1080 | 4.09 |  |
| 22 | 21.6 | 94.94 | 1080p | 1920×1080 | 3.08 |  |
| 23 | 22.6 | 95.94 | 1080p | 1920×1080 | 4.08 |  |
| 24 | 23.6 | 96.95 | 1080p | 1920×1080 | 3.07 |  |
| 25 | 24.6 | 97.96 | 1080p | 1920×1080 | 2.06 |  |
| 26 | 25.6 | 98.98 | 1080p | 1920×1080 | 3.05 |  |
| 27 | 26.6 | 99.99 | 1080p | 1920×1080 | 2.04 |  |
| 28 | 27.6 | 100.99 | 1080p | 1920×1080 | 3.02 |  |
| 29 | 28.6 | 102.00 | 1080p | 1920×1080 | 2.01 |  |
| 30 | 29.6 | 103.01 | 1080p | 1920×1080 | 3.01 |  |
| 31 | 30.7 | 104.02 | 1080p | 1920×1080 | 2.00 |  |
| 32 | 32.0 | 105.35 | 1080p | 1920×1080 | 4.68 |  |
| 33 | 33.0 | 106.36 | 1080p | 1920×1080 | 3.67 |  |
| 34 | 34.0 | 107.38 | 1080p | 1920×1080 | 2.65 |  |
| 35 | 35.0 | 108.38 | 1080p | 1920×1080 | 3.63 |  |
| 36 | 36.0 | 109.39 | 1080p | 1920×1080 | 2.62 |  |
| 37 | 37.0 | 110.41 | 1080p | 1920×1080 | 3.61 |  |
| 38 | 38.1 | 111.43 | 1080p | 1920×1080 | 4.57 |  |
| 39 | 39.1 | 112.44 | 1080p | 1920×1080 | 3.58 |  |
| 40 | 40.1 | 113.46 | 1080p | 1920×1080 | 2.56 |  |
| 41 | 41.1 | 114.47 | 1080p | 1920×1080 | 3.54 |  |
| 42 | 42.1 | 115.47 | 1080p | 1920×1080 | 4.54 |  |
| 43 | 43.1 | 116.48 | 1080p | 1920×1080 | 3.53 |  |
| 44 | 44.1 | 117.50 | 1080p | 1920×1080 | 2.51 |  |
| 45 | 45.4 | 118.75 | 1080p | 1920×1080 | 3.27 |  |
| 46 | 46.4 | 119.80 | 1080p | 1920×1080 | 2.73 |  |
| 47 | 47.4 | 120.80 | 1080p | 1920×1080 | 3.22 |  |
| 48 | 48.5 | 121.81 | 1080p | 1920×1080 | 2.21 |  |
| 49 | 49.5 | 122.82 | 1080p | 1920×1080 | 1.20 |  |
| 50 | 50.5 | 123.82 | 1080p | 1920×1080 | 0.20 |  |
| 51 | 51.5 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 52 | 52.5 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 53 | 53.5 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 54 | 54.5 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 55 | 55.5 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 56 | 56.5 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 57 | 57.5 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 58 | 58.5 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 59 | 59.5 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 60 | 60.5 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 61 | 61.6 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 62 | 62.7 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 63 | 63.7 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 64 | 64.7 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 65 | 65.7 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 66 | 66.7 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 67 | 67.7 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 68 | 68.7 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 69 | 69.7 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 70 | 70.8 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 71 | 71.8 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 72 | 72.8 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 73 | 73.8 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 74 | 74.8 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 75 | 75.8 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 76 | 76.8 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 77 | 77.8 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 78 | 78.8 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 79 | 79.8 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 80 | 80.8 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 81 | 81.8 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 82 | 82.9 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 83 | 83.9 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 84 | 84.9 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 85 | 85.9 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 86 | 86.9 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 87 | 87.9 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 88 | 88.9 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 89 | 89.9 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 90 | 90.9 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 91 | 91.9 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 92 | 93.1 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 93 | 94.1 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 94 | 95.1 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 95 | 96.1 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 96 | 97.1 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 97 | 98.1 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 98 | 99.1 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 99 | 100.1 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 100 | 101.2 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 101 | 102.2 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 102 | 103.2 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 103 | 104.2 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 104 | 105.2 | 123.97 | 1080p | 1920×1080 | 0.05 |  |
| 105 | 106.2 | 124.18 | 1080p | 1920×1080 | 1.29 |  |
| 106 | 107.2 | 125.19 | 1080p | 1920×1080 | 0.28 |  |
| 107 | 108.2 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 108 | 109.2 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 109 | 110.2 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 110 | 111.2 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 111 | 112.2 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 112 | 113.2 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 113 | 114.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 114 | 115.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 115 | 116.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 116 | 117.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 117 | 118.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 118 | 119.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 119 | 120.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 120 | 121.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 121 | 122.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 122 | 123.5 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 123 | 124.5 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 124 | 125.5 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 125 | 126.5 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 126 | 127.5 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 127 | 128.5 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 128 | 129.5 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 129 | 130.5 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 130 | 131.5 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 131 | 132.5 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 132 | 133.6 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 133 | 134.6 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 134 | 135.7 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 135 | 136.7 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 136 | 137.7 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 137 | 138.7 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 138 | 139.7 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 139 | 140.7 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 140 | 141.7 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 141 | 142.7 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 142 | 143.7 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 143 | 144.7 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 144 | 145.7 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 145 | 146.8 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 146 | 147.8 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 147 | 148.8 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 148 | 149.8 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 149 | 150.8 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 150 | 151.8 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 151 | 152.8 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 152 | 153.9 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 153 | 155.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 154 | 156.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 155 | 157.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 156 | 158.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 157 | 159.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 158 | 160.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 159 | 161.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 160 | 162.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 161 | 163.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 162 | 164.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 163 | 165.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 164 | 166.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 165 | 167.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 166 | 168.0 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 167 | 169.1 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 168 | 170.1 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 169 | 171.1 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 170 | 172.1 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 171 | 173.1 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 172 | 174.1 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 173 | 175.1 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 174 | 176.1 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 175 | 177.1 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 176 | 178.1 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 177 | 179.1 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 178 | 180.1 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 179 | 181.1 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 180 | 182.2 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 181 | 183.2 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 182 | 184.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 183 | 185.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 184 | 186.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 185 | 187.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 186 | 188.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 187 | 189.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 188 | 190.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 189 | 191.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 190 | 192.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 191 | 193.3 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 192 | 194.4 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
| 193 | 195.4 | 125.46 | 1080p | 1920×1080 | 0.00 |  |
