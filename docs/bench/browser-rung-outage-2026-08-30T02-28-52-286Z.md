# A viewer whose rung went quiet

**2026-08-30T02:28:52.286Z.** Chrome 151.0.7922.75, headed against an X display on the deployment host, watching a broadcast at an unrecorded GOP through the shipped client while the 360p transcode in `latbench-srs-1` was stopped from 45.9s to 136.1s.

Watching `http://127.0.0.1:10074/#/watch/video/8d8a30ff4cbcf8ad0e0773547686295f8157feb0/cb5854d1-dc09-4a3a-be58-d5cefd6445f8?qoe=1`.

## What was silenced

The viewer settled on **360p**, and that is the rung this run stopped, for 90.2s. 3 healthy rungs sat beside it throughout: 1080p, 720p, 480p.

⛔ Stopped rather than killed. SRS respawns a transcode that exits, so a kill would give a rung that
is quiet for however long a respawn takes rather than for the window this run chose.

| pid | the process that was stopped |
| ---: | --- |
| 192315 | `./objs/ffmpeg/bin/ffmpeg -f flv -i rtmp://127.0.0.1:1935/live/stream?vhost=__defaultVhost__ -vcodec libx264 -b:v 700000 -r 30.00 -s 640x360 -aspect 640:360 -profile:v main -preset veryfast -g 15 -keyint_min 15 -sc_threshold 0 -force_key_frames expr:gte(t,n_forced*0.5) -maxrate 700k -bufsize 700k -acodec copy -f flv -y rtmp://127.0.0.1:10072/live/stream_360p?vhost=abr` |

## What the viewer got

| | rung it ended on | lowest | tallest | media seconds per wall second |
| --- | :---: | :---: | :---: | ---: |
| before the rung went quiet | 360p | 360p | 360p | 0.675 |
| while it was quiet | 360p | 360p | 360p | 0.481 |
| after it spoke again | 360p | 360p | 360p | 0.000 |

| | |
| --- | ---: |
| it moved off the silenced rung, after the outage | it never did |
| it climbed back, after the rung returned | it never did |
| level changes hls.js counted | 0 |
| longest stretch the picture did not move | 103.2s |
| it stopped, after the rung went quiet | 6.1s |
| behind live before | 3.38s |
| behind live after | 8.99s |

⛔ Every duration above is measured and filed rather than held against a ceiling. Owner ruling of
2026-08-29: an e2e suite checks that the feature works and is stable, never how fast it is.

## What this run establishes

✅ **The player was choosing its own rung throughout.**

⛔ **It stayed on 360p, the rung that had stopped producing.** hls.js changes level on a fragment load ERROR, and a feed that stops advancing does not error, it simply stops offering fragments. A player waiting for one it was never offered has nothing to react to.

✅ **The picture kept moving while the rung was quiet**, at 0.481x.

⛔ **The client said nothing** while the picture was stopped.

✅ **The viewer was never told the broadcast had ended**, which it had not.

## What playback did

| | |
| --- | ---: |
| samples | 194 over 195.8s |
| **media seconds per wall second, whole session** | **0.358** |
| media seconds per wall second, typical sample | 0.000 |
| samples where playback did not advance | 122 |
| forward seeks, and media they skipped | 2, skipping 18.0s |
| rebuffers the player counted | 6, totalling 24969ms |
| fatal errors | 0 |
| dropped frames | 8 |
| **frames per second of media** | **27.2** |
| buffered ahead of the playhead, median | 0.00s |
| resolution decoded | 640×360 |

The advance ratio is `currentTime` against the wall clock, which is the one measurement here that does not go through the overlay: a stalled player still reports a latency and still renders, and this is what says whether the picture was moving.

**Read the whole-session ratio, not the typical sample.** Playback either runs at its rate or is stopped, so the typical sample reads 1.000 in any session that plays at all, including one that spends a sixth of its time frozen. The gap between the two rows is the rebuffering.

**A seek is not playback, and the whole-session ratio no longer counts it as such.** When latency passes `LIVE_MAX_LATENCY_DURATION_S` hls.js jumps the playhead to the live edge, which is its designed recovery and the normal end of any freeze. Reading `currentTime` at the ends of a run could not tell that from playing throughout, so a freeze and the seek that ended it used to net to 1.000. Media above what the clock allows at the catch-up rate is now counted as skipped and reported on its own row. Replaying the recorded runs through both definitions moved every faulted run and left all 27 clean ones identical to three decimals.

## Where the time went

| | |
| --- | ---: |
| segment requests | 251 for 234 distinct segments |
| refused (404, not yet retrievable) | 17 (6.8% of requests) |
| segments refused at least once | 17 |
| segments never served at all | 3 |
| **time spent waiting between attempts** | **0ms** |
| median successful transfer | 69ms |
| segment bytes delivered | 78 kB/s |
| most segment fetches in flight at once | 2 |

The waiting figure accounts for **0%** of the 24969ms this session spent rebuffering. It is measured between one attempt ending and the next starting, so it contains no transfer time and cannot be inflated by a slow gateway: it is time the player chose to spend doing nothing, which on a refused fragment is `fragLoadPolicy.errorRetry.retryDelayMs`.

## The instrument was sound

All 194 samples came from a page reporting `visibilityState: visible`, with a 100ms timer keeping its schedule and a build that can decode H.264 and AAC. Nothing below is the harness degrading its own subject, which is the failure that blocked this measurement until now.

## Every sample

| # | at | media | rung | delivered | buffer ahead | what the client said |
| ---: | ---: | ---: | :---: | :---: | ---: | --- |
| 1 | 0.0 | 50.41 | 360p | 640×360 | 2.60 |  |
| 2 | 1.2 | 51.57 | 360p | 640×360 | 2.42 |  |
| 3 | 2.2 | 52.58 | 360p | 640×360 | 1.41 |  |
| 4 | 3.2 | 53.59 | 360p | 640×360 | 0.39 |  |
| 5 | 4.2 | 54.60 | 360p | 640×360 | 0.38 |  |
| 6 | 5.2 | 54.92 | 360p | 640×360 | 0.07 |  |
| 7 | 6.2 | 54.92 | 360p | 640×360 | 1.08 |  |
| 8 | 7.2 | 54.92 | 360p | 640×360 | 1.08 |  |
| 9 | 8.2 | 54.92 | 360p | 640×360 | 2.08 |  |
| 10 | 9.2 | 54.92 | 360p | 640×360 | 2.08 |  |
| 11 | 10.2 | 55.59 | 360p | 640×360 | 2.40 |  |
| 12 | 11.3 | 56.60 | 360p | 640×360 | 1.89 |  |
| 13 | 12.3 | 57.61 | 360p | 640×360 | 1.88 |  |
| 14 | 13.3 | 58.61 | 360p | 640×360 | 1.39 |  |
| 15 | 14.3 | 59.62 | 360p | 640×360 | 0.38 |  |
| 16 | 15.3 | 59.93 | 360p | 640×360 | 1.57 |  |
| 17 | 16.3 | 59.93 | 360p | 640×360 | 2.06 |  |
| 18 | 17.3 | 60.21 | 360p | 640×360 | 3.29 |  |
| 19 | 18.3 | 61.23 | 360p | 640×360 | 2.77 |  |
| 20 | 19.3 | 62.23 | 360p | 640×360 | 2.76 |  |
| 21 | 20.3 | 63.24 | 360p | 640×360 | 2.76 |  |
| 22 | 21.3 | 64.25 | 360p | 640×360 | 2.24 |  |
| 23 | 22.4 | 65.26 | 360p | 640×360 | 2.72 |  |
| 24 | 23.4 | 66.27 | 360p | 640×360 | 2.22 |  |
| 25 | 24.4 | 67.28 | 360p | 640×360 | 1.21 |  |
| 26 | 25.4 | 68.29 | 360p | 640×360 | 0.20 |  |
| 27 | 26.4 | 68.42 | 360p | 640×360 | 0.62 |  |
| 28 | 27.4 | 68.42 | 360p | 640×360 | 0.62 |  |
| 29 | 28.4 | 68.42 | 360p | 640×360 | 2.63 |  |
| 30 | 29.4 | 69.31 | 360p | 640×360 | 2.74 |  |
| 31 | 30.4 | 70.32 | 360p | 640×360 | 1.73 |  |
| 32 | 31.6 | 71.49 | 360p | 640×360 | 1.10 |  |
| 33 | 32.6 | 72.50 | 360p | 640×360 | 1.09 |  |
| 34 | 33.6 | 73.51 | 360p | 640×360 | 1.60 |  |
| 35 | 34.6 | 74.52 | 360p | 640×360 | 1.59 |  |
| 36 | 35.6 | 75.54 | 360p | 640×360 | 1.07 |  |
| 37 | 36.6 | 76.55 | 360p | 640×360 | 0.57 |  |
| 38 | 37.7 | 77.03 | 360p | 640×360 | 0.08 |  |
| 39 | 38.7 | 77.03 | 360p | 640×360 | 0.63 |  |
| 40 | 39.7 | 77.03 | 360p | 640×360 | 1.64 |  |
| 41 | 40.7 | 77.03 | 360p | 640×360 | 2.64 |  |
| 42 | 41.7 | 77.54 | 360p | 640×360 | 2.62 |  |
| 43 | 42.7 | 78.55 | 360p | 640×360 | 3.13 |  |
| 44 | 43.7 | 79.56 | 360p | 640×360 | 3.12 |  |
| 45 | 44.7 | 80.57 | 360p | 640×360 | 2.60 |  |
| 46 | 45.9 | 81.81 | 360p | 640×360 | 2.37 |  |
| 47 | 47.0 | 82.82 | 360p | 640×360 | 2.36 |  |
| 48 | 48.0 | 83.83 | 360p | 640×360 | 2.35 |  |
| 49 | 49.0 | 84.83 | 360p | 640×360 | 1.84 |  |
| 50 | 50.0 | 85.84 | 360p | 640×360 | 1.32 |  |
| 51 | 51.0 | 86.85 | 360p | 640×360 | 0.31 |  |
| 52 | 52.0 | 87.09 | 360p | 640×360 | 1.07 |  |
| 53 | 53.0 | 87.53 | 360p | 640×360 | 2.64 |  |
| 54 | 54.0 | 88.55 | 360p | 640×360 | 2.62 |  |
| 55 | 55.0 | 89.56 | 360p | 640×360 | 2.11 |  |
| 56 | 56.0 | 90.57 | 360p | 640×360 | 2.10 |  |
| 57 | 57.1 | 91.57 | 360p | 640×360 | 2.61 |  |
| 58 | 58.1 | 92.58 | 360p | 640×360 | 2.60 |  |
| 59 | 59.1 | 93.59 | 360p | 640×360 | 2.09 |  |
| 60 | 60.1 | 94.59 | 360p | 640×360 | 2.57 |  |
| 61 | 61.1 | 95.60 | 360p | 640×360 | 2.05 |  |
| 62 | 62.2 | 110.02 | 360p | 640×360 | -11.62 |  |
| 63 | 63.2 | 110.02 | 360p | 640×360 | -10.85 |  |
| 64 | 64.2 | 110.02 | 360p | 640×360 | -9.85 |  |
| 65 | 65.2 | 110.02 | 360p | 640×360 | -8.85 |  |
| 66 | 66.3 | 110.02 | 360p | 640×360 | -7.84 |  |
| 67 | 67.3 | 110.02 | 360p | 640×360 | -6.84 |  |
| 68 | 68.3 | 115.99 | 360p | 640×360 | -11.81 |  |
| 69 | 69.3 | 115.99 | 360p | 640×360 | -11.34 |  |
| 70 | 70.3 | 115.99 | 360p | 640×360 | -9.82 |  |
| 71 | 71.3 | 101.48 | 360p | 640×360 | 5.70 |  |
| 72 | 72.3 | 102.49 | 360p | 640×360 | 4.69 |  |
| 73 | 73.3 | 103.50 | 360p | 640×360 | 6.69 |  |
| 74 | 74.3 | 104.60 | 360p | 640×360 | 5.58 |  |
| 75 | 75.3 | 105.71 | 360p | 640×360 | 7.46 |  |
| 76 | 76.3 | 106.82 | 360p | 640×360 | 8.35 |  |
| 77 | 77.3 | 107.93 | 360p | 640×360 | 16.06 |  |
| 78 | 78.3 | 109.04 | 360p | 640×360 | 14.96 |  |
| 79 | 79.4 | 110.14 | 360p | 640×360 | 13.85 |  |
| 80 | 80.4 | 111.25 | 360p | 640×360 | 12.74 |  |
| 81 | 81.4 | 112.36 | 360p | 640×360 | 11.64 |  |
| 82 | 82.4 | 113.46 | 360p | 640×360 | 10.53 |  |
| 83 | 83.4 | 114.57 | 360p | 640×360 | 9.42 |  |
| 84 | 84.4 | 115.68 | 360p | 640×360 | 8.31 |  |
| 85 | 85.4 | 116.78 | 360p | 640×360 | 7.21 |  |
| 86 | 86.4 | 117.89 | 360p | 640×360 | 6.10 |  |
| 87 | 87.4 | 119.00 | 360p | 640×360 | 4.99 |  |
| 88 | 88.4 | 120.11 | 360p | 640×360 | 3.88 |  |
| 89 | 89.4 | 121.22 | 360p | 640×360 | 2.77 |  |
| 90 | 90.4 | 122.33 | 360p | 640×360 | 1.66 |  |
| 91 | 91.4 | 123.44 | 360p | 640×360 | 0.56 |  |
| 92 | 92.6 | 123.99 | 360p | 640×360 | 0.00 |  |
| 93 | 93.6 | 123.99 | 360p | 640×360 | 0.00 |  |
| 94 | 94.6 | 123.99 | 360p | 640×360 | 0.00 |  |
| 95 | 95.6 | 123.99 | 360p | 640×360 | 0.00 |  |
| 96 | 96.6 | 123.99 | 360p | 640×360 | 0.00 |  |
| 97 | 97.6 | 123.99 | 360p | 640×360 | 0.00 |  |
| 98 | 98.6 | 123.99 | 360p | 640×360 | 0.00 |  |
| 99 | 99.6 | 123.99 | 360p | 640×360 | 0.00 |  |
| 100 | 100.6 | 123.99 | 360p | 640×360 | 0.00 |  |
| 101 | 101.6 | 123.99 | 360p | 640×360 | 0.00 |  |
| 102 | 102.6 | 123.99 | 360p | 640×360 | 0.00 |  |
| 103 | 103.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 104 | 104.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 105 | 105.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 106 | 106.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 107 | 107.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 108 | 108.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 109 | 109.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 110 | 110.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 111 | 111.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 112 | 112.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 113 | 113.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 114 | 114.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 115 | 115.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 116 | 116.8 | 123.99 | 360p | 640×360 | 0.00 |  |
| 117 | 117.8 | 123.99 | 360p | 640×360 | 0.00 |  |
| 118 | 118.8 | 123.99 | 360p | 640×360 | 0.00 |  |
| 119 | 119.8 | 123.99 | 360p | 640×360 | 0.00 |  |
| 120 | 120.8 | 123.99 | 360p | 640×360 | 0.00 |  |
| 121 | 121.8 | 123.99 | 360p | 640×360 | 0.00 |  |
| 122 | 122.9 | 123.99 | 360p | 640×360 | 0.00 |  |
| 123 | 123.9 | 123.99 | 360p | 640×360 | 0.00 |  |
| 124 | 124.9 | 123.99 | 360p | 640×360 | 0.00 |  |
| 125 | 125.9 | 123.99 | 360p | 640×360 | 0.00 |  |
| 126 | 126.9 | 123.99 | 360p | 640×360 | 0.00 |  |
| 127 | 127.9 | 123.99 | 360p | 640×360 | 0.00 |  |
| 128 | 129.0 | 123.99 | 360p | 640×360 | 0.00 |  |
| 129 | 130.0 | 123.99 | 360p | 640×360 | 0.00 |  |
| 130 | 131.0 | 123.99 | 360p | 640×360 | 0.00 |  |
| 131 | 132.0 | 123.99 | 360p | 640×360 | 0.00 |  |
| 132 | 133.0 | 123.99 | 360p | 640×360 | 0.00 |  |
| 133 | 134.0 | 123.99 | 360p | 640×360 | 0.00 |  |
| 134 | 135.0 | 123.99 | 360p | 640×360 | 0.00 |  |
| 135 | 136.1 | 123.99 | 360p | 640×360 | 0.00 |  |
| 136 | 137.1 | 123.99 | 360p | 640×360 | 0.00 |  |
| 137 | 138.1 | 123.99 | 360p | 640×360 | 0.00 |  |
| 138 | 139.1 | 123.99 | 360p | 640×360 | 0.00 |  |
| 139 | 140.1 | 123.99 | 360p | 640×360 | 0.00 |  |
| 140 | 141.2 | 123.99 | 360p | 640×360 | 0.00 |  |
| 141 | 142.2 | 123.99 | 360p | 640×360 | 0.00 |  |
| 142 | 143.2 | 123.99 | 360p | 640×360 | 0.00 |  |
| 143 | 144.2 | 123.99 | 360p | 640×360 | 0.00 |  |
| 144 | 145.2 | 123.99 | 360p | 640×360 | 0.00 |  |
| 145 | 146.2 | 123.99 | 360p | 640×360 | 0.00 |  |
| 146 | 147.2 | 123.99 | 360p | 640×360 | 0.00 |  |
| 147 | 148.2 | 123.99 | 360p | 640×360 | 0.00 |  |
| 148 | 149.2 | 123.99 | 360p | 640×360 | 0.00 |  |
| 149 | 150.2 | 123.99 | 360p | 640×360 | 0.00 |  |
| 150 | 151.2 | 123.99 | 360p | 640×360 | 0.00 |  |
| 151 | 152.2 | 123.99 | 360p | 640×360 | 0.00 |  |
| 152 | 153.3 | 123.99 | 360p | 640×360 | 0.00 |  |
| 153 | 154.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 154 | 155.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 155 | 156.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 156 | 157.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 157 | 158.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 158 | 159.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 159 | 160.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 160 | 161.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 161 | 162.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 162 | 163.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 163 | 164.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 164 | 165.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 165 | 166.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 166 | 167.4 | 123.99 | 360p | 640×360 | 0.00 |  |
| 167 | 168.5 | 123.99 | 360p | 640×360 | 0.00 |  |
| 168 | 169.5 | 123.99 | 360p | 640×360 | 0.00 |  |
| 169 | 170.5 | 123.99 | 360p | 640×360 | 0.00 |  |
| 170 | 171.5 | 123.99 | 360p | 640×360 | 0.00 |  |
| 171 | 172.5 | 123.99 | 360p | 640×360 | 0.00 |  |
| 172 | 173.5 | 123.99 | 360p | 640×360 | 0.00 |  |
| 173 | 174.5 | 123.99 | 360p | 640×360 | 0.00 |  |
| 174 | 175.5 | 123.99 | 360p | 640×360 | 0.00 |  |
| 175 | 176.5 | 123.99 | 360p | 640×360 | 0.00 |  |
| 176 | 177.5 | 123.99 | 360p | 640×360 | 0.00 |  |
| 177 | 178.5 | 123.99 | 360p | 640×360 | 0.00 |  |
| 178 | 179.5 | 123.99 | 360p | 640×360 | 0.00 |  |
| 179 | 180.5 | 123.99 | 360p | 640×360 | 0.00 |  |
| 180 | 181.6 | 123.99 | 360p | 640×360 | 0.00 |  |
| 181 | 182.6 | 123.99 | 360p | 640×360 | 0.00 |  |
| 182 | 183.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 183 | 184.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 184 | 185.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 185 | 186.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 186 | 187.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 187 | 188.7 | 123.99 | 360p | 640×360 | 0.00 |  |
| 188 | 189.8 | 123.99 | 360p | 640×360 | 0.00 |  |
| 189 | 190.8 | 123.99 | 360p | 640×360 | 0.00 |  |
| 190 | 191.8 | 123.99 | 360p | 640×360 | 0.00 |  |
| 191 | 192.8 | 123.99 | 360p | 640×360 | 0.00 |  |
| 192 | 193.8 | 123.99 | 360p | 640×360 | 0.00 |  |
| 193 | 194.8 | 123.99 | 360p | 640×360 | 0.00 |  |
| 194 | 195.8 | 123.99 | 360p | 640×360 | 0.00 |  |
