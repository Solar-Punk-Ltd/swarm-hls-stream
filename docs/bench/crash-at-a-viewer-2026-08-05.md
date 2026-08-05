# Three crashes, watched from a viewer's seat

**2026-08-05.** The first time anything in this project has broken under a browser that was watching.
All three instrument-sound. `browser:crash`, which injects the fault itself over the docker socket so
the moment the service went down and the moment the sample was taken come off one clock.

Six crash scenarios already pass in `e2e/suites/scenarios/`, and every one of them reads the
uploader's log. They answer whether the **publisher** did the right thing. Nothing below is visible
from there.

## What the viewer got

| | gateway stopped 20.5s | uploader killed 15.3s | engine restarted 30.5s |
| --- | ---: | ---: | ---: |
| picture kept moving for | 6.1s | 7.1s | 7.1s |
| then froze for | **30.6s** | **54.9s** | **84.3s** |
| moved again, after the service returned | **16.2s** | **46.7s** | never |
| recovered without a reload | ✅ | ✅ | n/a, the broadcast ended |
| the client said | "Reconnecting to the stream" | "Waiting for the broadcast to continue" | "Waiting for the broadcast to continue" |
| behind live, before → after | 5.77s → 6.05s | 5.90s → 7.01s | 5.86s → 5.68s |

**The engine restart is the one where not recovering is correct.** It takes the publisher's
connection with it, so the broadcast genuinely ends and there is nothing left to play. The viewer was
told, in the right words, and stayed told. A scenario now declares `expectRecovery` so the report
does not read that as a defect, which it did on the first pass.

## ✅ The overlay works, and it is the first time anyone has seen it

Both `FeedStateOverlay` states rendered, both were correct, and both appeared **within one second of
the fault**. `reconnecting` when the gateway would not answer, `stalled` when the gateway answered
and the feed was not advancing. Those are genuinely different situations and the client told them
apart without being asked to.

A viewer who is told the stream is reconnecting waits. One looking at an unexplained frozen frame
reloads, or leaves. This was the whole argument for building that overlay and nothing had ever
watched it render.

The buffer also did exactly what it is configured to do: the picture kept moving for 6.1s and 7.1s
after the fault, which is `LIVE_SYNC_DURATION_S = 6` spending itself.

## ⛔ Recovery is not bounded by the outage

Both of the two faults that were meant to be survivable froze the picture for much longer than they
lasted, and in both the extra time is on this side.

**The gateway outage: 20.5s down, 30.6s frozen, 16.2s of it after the gateway was answering again.**
The client's manifest backoff doubles from `MANIFEST_RETRY_BASE_MS = 2000` and is stamped from the
failure, so attempts fall at t=0, 2, 6, 14, 30. The gateway came back at 20.5s and the next attempt
was not due until 30s. **The backoff overshot the outage by about ten seconds**, and at the
`MANIFEST_RETRY_CAP_MS = 30_000` cap it could overshoot by thirty. Task #85.

**The uploader crash: 15.3s down, 54.9s frozen, 46.7s of it after the uploader was healthy.** This one
is worse and the request log names it exactly.

## ⛔⛔ One unretrievable slot hides every slot behind it

The uploader recovered in **3.4 seconds**: container up at 17:12:22.9, first new manifest published
at SOC index 301 at 17:12:26.4, and continuously after that at about 3.75 slots a second.

The viewer saw none of it for another 43 seconds. From the request log:

| | |
| --- | ---: |
| feed slots asked for between the kill and recovery | 114 refusals over **3 distinct addresses** |
| of which, one address | **asked 112 times, t=46.4s to t=106.3s, 404 every time** |
| that same address, at t=106.8s | **served** |
| slots consumed in the second that followed | **31** |
| segments fetched in that same second | 6, all 200, 76 to 126ms |

So roughly 175 slots were written and retrievable while the viewer could not see a single one of
them. The walk is strictly sequential and cannot pass its oldest missing slot.

**A viewer's recovery is bounded below by the retrievability of the one oldest slot they have not
read, however healthy the publisher is.** That is task #71, which a 692-slot scan had downgraded
because it found no holes. The scan read chunks that had had minutes to settle. This is the case it
could not see.

The fix has been written down in the roadmap since before this run: on `stalled`, drop the index and
re-anchor through the head lookup. The stall signal already fires correctly, so only the recovery is
missing.

## What this does not say

**One run each.** Each agrees with a mechanism read off its own request log rather than assumed,
which is stronger than three bare numbers, and none has been repeated.

**Neither fault is the interesting one for the 43 seconds.** Why that particular chunk took 60
seconds to become retrievable from the viewer's gateway is not answered here. It may be a chunk the
killed process announced and never finished pushing, or ordinary propagation on a bad minute. What
is answered is the consequence, which does not depend on the cause: whatever makes one slot slow
makes every later slot invisible.

**The engine restart left the uploader holding a stream forever.** SRS never sends `on_unpublish`
when it dies, so `activeStreams` stayed at 1 with no activity and the uploader reported `degraded`
with `segment_stall` until it was restarted by hand. Correct detection, no path out of it. Task #86,
found by running this rather than by looking for it.

**Segment length was 0.25s throughout, and the client was the fixed one** from
[the loop fix](./the-loop-fixed-2026-08-05.md). All three sat at 5.77 to 5.90s behind live before their
fault, which is the healthy baseline that report establishes.
