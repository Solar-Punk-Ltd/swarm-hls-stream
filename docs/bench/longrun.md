# Does a setting hold still? The first broadcasts longer than a minute

Measured 2026-08-03 on `manager-host`, profile `latbench`, engine SRS. Five continuous broadcasts of 5
to 20 minutes, produced by `pnpm bench:longrun`, against `profiles.md`'s 86 runs of about 50 seconds
each.

`profiles.md` answers "how fast does a viewer see the opening of a broadcast". This answers "does it
stay that way", which is a different question and the one an operator picking a setting actually has.

## The short answer

**The latency holds still. The feed does not.**

Nothing degrades with elapsed time: the fitted latency slope stays inside its own residual on every
run, and the buffer a player needs does not grow between the first third of a run and the last. That
was the failure mode this bench was built to look for, and it is not there.

What is there instead is worse, and no short run could have seen it: **the feed a player polls stops
naming new segments for 30 to 48 seconds at a time, on a 63 second cycle, for 42% to 70% of a
broadcast.** It is filed as LAT-10 and it is not this repository's code.

## Run by run

| picture | segment | minutes | samples | capture to fetchable, median | fitted drift | resolvable? | buffer demand, first third to last |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 720p 2500k | 0.5s | 19.4 | 171 | **2.51s** | -58ms/min | no | 5.00s to 4.80s (**-0.21s**) |
| 720p 2500k | 0.5s | 7.7 | 55 | 2.63s | +133ms/min | no | 3.58s to 5.22s (+1.64s) |
| 720p 2500k | 2.0s | 8.0 | 69 | 5.90s | +20ms/min | no | 4.98s to 5.29s (+0.31s) |
| 720p 2500k | 2.0s | 4.7 | 40 | 5.76s | | | |
| 720p 2500k | 2.0s | 5.7 | 42 | 4.82s | | | |

The last two are the publishes that carried the two-node experiment below, kept because they are
runs and reported without their drift columns because four and six minutes is not long enough for a
slope to mean anything.

There was a sixth, at 1080p 6000k and 0.5s for 2.1 minutes, which was the instrument's own first
smoke run. **Its artifact was deliberately not kept**: it reported a 48 second gap it had no way to
attribute, and `feedPolls`, the field that turns such a gap into a statement about whose it is, came
out of reading that report. Its latency figures were 2.55s median and a 2.76s to 4.39s buffer
demand, and they are quoted here rather than in the table because nothing in the directory backs them.

"Resolvable" is computed, not judged: the change the fitted line predicts across the run against
twice the root-mean-square spread of the samples around it. No run clears it, so every one of these
slopes is a line through scatter and none of them is a trend. The 20 minute run is the one to read,
because it is the only one long enough for a slope of any size to have cleared.

## The instrument checks itself first, and this is why

The publisher is paced by ffmpeg's `realtime` filter at the nominal frame rate, and every capture
instant is recovered from the media timestamps. So a publisher running one percent slow produces a
latency that climbs forever with no viewer of a real camera ever seeing it. Over 50 seconds that is
half a second and invisible under the scatter. Over 20 minutes it is 12 seconds and would be the
headline.

`mediaPacing` reads the rate two ways, from the uploader's segment count and from the timeline
itself, and both are reported before any drift figure:

| run | media delivered per wall second | timeline per wall second | media the timeline crossed that no segment carried |
| --- | ---: | ---: | ---: |
| 720p 0.5s, 20 min | 0.9991 | 0.9991 | 0.00s |
| 720p 0.5s, 8 min | 0.9942 | 0.9942 | 0.00s |
| 720p 2.0s, 8 min | 0.9985 | 0.9990 | 0.24s |

The two agreeing means the publisher was real-time; a gap between them would mean media the timeline
crossed that no segment carried, which a viewer would see as a jump and which no latency column shows.

## LAT-10: what the runs actually found

Over 20.1 minutes the feed named the same newest segment for 29 to 48 seconds on **18 separate
occasions, 679 of 1198 seconds, 57% of the broadcast**.

**It is not the broadcast.** Inside the longest window the uploader wrote 96 manifests, SOC index 34
to 129, with no error, warning or retry.

**It is not the bench.** `curl`, polling the same feed URL with none of this repository's code in the
path, reproduces it exactly.

**Nothing is lost.** The gateway's resolved feed index advances 127, 127 and 128 updates per 63
seconds against a writer doing two per second. The reader keeps up on average and fails only on
freshness, which is why every other signal is clean.

### Segment length mitigates and does not cure

| | 0.5s segments (2 feed writes/sec) | 2.0s segments (0.5 writes/sec) |
| --- | --- | --- |
| freezes over 15s, in 8 minutes | 7 | 6 |
| **period between freezes** | **63, 65, 64, 64, 66, 63s** | **60, 67, 63, 63, 61s** |
| freeze length, median | 47.4s | 33.3s |
| index jump on release | 96 | 17 |
| **frozen share of the broadcast** | **70%** | **42%** |

The period is the same at both write rates, so the cycle is driven by elapsed time. What the write
rate changes is how far the reader falls behind while frozen, and 96 against 17 is exactly the rate
ratio. **No operating profile escapes this.**

### It is the reading node's lookup

Both bee nodes polled for the same feed, on the same host, in one loop, during a live publish:

| node | stalls over 15s | frozen | worst |
| --- | ---: | ---: | ---: |
| `bee-uploader`, which wrote the feed | 1 | 11% | 26s |
| `bee-gateway`, which is what a viewer polls | 4 | **64%** | 44s |

The gateway ran up to 21 updates behind the writer's node. The feed is resolvable throughout by a node
in the same compose project. The writer's node is not immune either, which rules out a simple
local-storage explanation and points at the lookup rather than at chunk availability.

## What this changes about choosing a setting

**Read `profiles.md` as a comparison between settings on the capture-to-fetchable hop, which is what
it was built for, and not as a statement about what a viewer experiences.** A viewer does not sit
6.43s behind live at its best row. They sit somewhere between that and roughly fifty seconds depending
on where in the cycle they arrive, and a player configured with the buffer those rows derive
rebuffers on every cycle.

Until LAT-10 has a cause, the honest position on segment length is that 0.5s still wins on
capture-to-fetchable and loses on frozen share, and neither figure is the one that decides a
deployment while the feed behaves this way.

## What is still not measured

- **Concurrent viewers.** Never measured at all, at any setting. The gateway is one bee node.
- **Anything past 20 minutes.** The longest broadcast here is 20.1 minutes.
- **A real broadcaster.** Every run publishes a synthetic test pattern from the deployment host.
- **1080p over a long run.** The only long 1080p run is 2.1 minutes.
