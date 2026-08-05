# The picture keeps up now, and the fastest profile is no longer the worst one

**2026-08-05, same day as the diagnosis.** Three broadcasts through the shipped client in a real
Chrome, all three instrument-sound. Follows
[what starves the viewer](./what-starves-the-viewer-2026-08-05.md), which found the cause, and
[the first browser validation](./viewer-in-a-browser-2026-08-05.md), which found the symptom.

## The fix

The client consumed one feed slot per playlist reload. hls.js reloads a live playlist about once per
segment duration plus the round trip it just measured, so a viewer's picture could only advance at
`duration / (duration + roundTrip)` of real time. A poll now walks the feed to the publisher's head
instead, one slot at a time, stopping on the 404 that says there is nothing more.

## What it did, at the segment length that was worst

| at a 0.25s GOP | before | after | after, repeated |
| --- | ---: | ---: | ---: |
| **media seconds per wall second** | **0.819** | **1.000** | **1.003** |
| **wall clock frozen** | **17.3%** | **0%** | **0%** |
| rebuffers | 7 | 0 | 0 |
| samples where playback did not advance | 26 | 0 | 0 |
| buffered ahead, median | 1.57s | 4.73s | 4.39s |
| behind live, median | 2.19s | 5.86s | 5.89s |
| segments fetched per second | 3.07 | 3.90 | 3.91 |

The publisher writes 3.75 segments a second at this setting (`-g 8` at 30fps is 0.2667s of media).
Before, the client asked for 3.07 of them. Now it asks for more than are written, which is what
catching up looks like, and then holds.

**Behind live went up, and that is the fix working.** The player is configured to sit
`LIVE_SYNC_DURATION_S = 6` seconds back. It could not reach that before because it could not get
segments fast enough to build the buffer, so it drifted toward the edge it knew about and stalled
against it. 5.86s and 5.89s against a 6s target is the first time a player on this deployment has
held the position it was configured with.

## The reading that cannot be argued with

The publisher burns the host clock into the picture and the harness paints the viewer's clock into
the same screenshot, so one frame carries both ends.

| | before | after |
| --- | ---: | ---: |
| t≈30s | 10.1s | **7.3s** |
| t≈60s | 16.5s | **6.7s** |
| t≈90s | 17.9s | **7.0s** |
| t≈120s | not measured | **6.4s** |

**Before, the true gap nearly doubled across ninety seconds while `hls.latency` reported 1.05 to
1.69s throughout.** After, it is flat inside 0.9s, and `hls.latency` tracks it at a roughly constant
offset of about 1.2s rather than drifting away from it. The offset itself is expected: `drawtext`
stamps the frame before the `realtime` filter paces it, and the burned-in clock has one-second
resolution, so a constant bias of around a second is built into the method. **A constant bias cannot
produce the growth, which is why the growth was the finding and its absence is this one.**

## Which profile ships: the 2026-08-05 morning decision is reversed

That decision said ship 1.0s, because 0.25s bought 462ms of capture-to-fetchable that never reached
a viewer and cost seven times the freezing. The freezing was the client, and it is gone.

| | 0.25s | 1.0s |
| --- | ---: | ---: |
| media seconds per wall second | 1.000 / 1.003 | 1.015 |
| rebuffers | 0 | 0 |
| behind live, median | 5.86s / 5.89s | 5.75s |
| true gap from the burned-in clock | 6.4 to 7.3s | 7.1 to 7.3s |
| dropped frames over 150s | 15 / 6 | 102 |
| **latency at the join** | **11.61s** | **35.98s** |

**Both are stable. 0.25s is no worse on any axis and better on two**, so the reason to prefer the
longer segment is gone.

⚠️ **The join is the one place segment length still shows, and it is worth a look.** The live window
is budgeted in bytes, so it names about as many segments whatever their length, which is roughly 9
seconds of media at 0.25s and 36 at 1.0s. hls.js pins its sync position to the start of the playlist,
so the 1.0s viewer arrives 36 seconds back, past `LIVE_MAX_LATENCY_DURATION_S`, and is seeked
forward. It recovers by the next sample. But the first thing that viewer sees is stale, and then
skips.

⚠️ **Both join figures are read from the first sample, taken while `readyState` is still 1.** That is
a player that has started and is still filling, so the number describes a startup transient rather
than a settled position. The steady state below it is the solid part.

## What this does not say

**Two runs at 0.25s and one at 1.0s, one evening, one machine.** They agree with each other and with
a mechanism that predicted the direction and roughly the size before the run, which is stronger than
three bare numbers. This project has still been caught before reading one afternoon as a property of
a configuration.

**Nothing here has been gated at ten minutes.** The 0.25s profile that these replace was gated three
times at ten minutes on capture-to-fetchable, and this is a different measurement over 150 seconds.

**The walk has an untested tail.** `MAX_SLOTS_PER_POLL` bounds one poll at 16 slots, and nothing in
these runs came near it: live, the publisher is only ever a slot or two ahead. What a viewer
returning from a long backlog does is covered by unit tests and has not been watched.

**Segment length was the only variable.** Resolution, bitrate and frame rate were held at
720p/2500k/30fps throughout.
