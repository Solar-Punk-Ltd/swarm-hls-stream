# Buffer sweep, 2026-08-28T00:16:49.842Z

240s per arm, 4 of 6 arms counted. `#EXT-X-TARGETDURATION` 1s, which caps the stall penalty.

⛔ Scored on stalls. A smaller buffer always shows a better latency, so the latency column
cannot locate the floor and is here only to show the arm did what it was told.

The `.json` beside this carries each arm's samples, so a rebuffer can be placed inside its arm
and lined up against the refusals in the `.requests.json`. That series is thinned and holds fewer
rows than the samples column counts: every sample where something happened is kept with the one
before it, and the uneventful rest is sampled evenly.

| target | held at | samples | rebuffers | stalled | median latency | counted |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 6s | 6s | 237 | 1 | 53 | 5.54s | no, warm-up |
| 1.5s | 1.5s | 237 | 0 | 236 | 5.66s | no, warm-up |
| 1.5s | 1.5s | 237 | 0 | 236 | 5.66s | yes |
| 2s | 2s | 237 | 0 | 236 | 5.66s | yes |
| 3s | 3s | 237 | 0 | 236 | 5.66s | yes |
| 6s | 6s | 237 | 0 | 236 | 5.66s | yes |

Cost: 0.055 BZZ over 1 postage buckets.
