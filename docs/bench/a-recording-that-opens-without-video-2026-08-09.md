# A recording that opens without video plays without video, for its whole length

**2026-08-09.** Task #40, answered from the three archived VOD runs and two segments fetched off the
gateway. **Cost: nothing.** No broadcast, no postage, no BZZ beyond two reads.

## The claim it replaces

Task #40 was filed as _"playback of a long recording intermittently builds no video SourceBuffer,
1 run in 3, mechanism unmeasured"_. Both halves of that are wrong.

⛔ **It is not intermittent and it is not a player defect.** One specific recording is unplayable, and
it is unplayable every time, for a reason that is in the media rather than in the browser. The three
runs used **three different recordings**, so "1 in 3" was counting recordings, not attempts.

## Measured

| | **the failing run** | **a healthy run** |
| --- | --- | --- |
| recording | `8f2a4e2b…`, 209.0s | `fb4d8c71…`, 191.1s |
| source buffers created | **audio only**, three times over | audio **and** video |
| median segment | **18,612 B** | **1,217,864 B** |
| what the player said | `Attempting to append to the video SourceBuffer, but it does not exist` | one buffer-hole warning |
| how it ended | `PIPELINE_ERROR_DECODE`, element dead | `readyState` 4, playing, three seeks landed |

**65x** between the two segment sizes. That alone says the failing run was not playing the same kind
of thing at all.

## The mechanism, every step of it measured

Two segments of the failing recording were fetched from the gateway and probed:

| segment | bytes | **video packets** | audio packets |
| --- | ---: | ---: | ---: |
| first | 16,732 | **0** | 41 |
| fifth | 83,472 | **5** | 26 |

⭐ **The first four segments declare a video stream in the PMT and carry no video packets at all.**
Video appears from the fifth.

So the chain is:

1. The player parses the first fragment, finds audio and no video, and **fixes its codec set to
   audio only**. Only an audio `SourceBuffer` is created.
2. The fifth fragment arrives carrying video. There is nowhere to put it.
3. Every video sample for the rest of the recording is refused with
   `Attempting to append to the video SourceBuffer, but it does not exist` — a **non-fatal** warning.
4. The viewer gets sound over a blank picture, for 209 seconds, and nothing says so.

⛔ **The codec set is never revised.** Three MediaSource cycles happened in that run, from the
player's own error recovery, and all three built audio only, because all three started from the same
first fragment.

## ⭐ The uploader already knew, in these words

`measureSegmentDuration` run against the real bytes of that first segment:

```
{"seconds":2,"fellBackBecause":"cannot measure how much media this segment holds:
 it holds no video packets, so the media never reached the far end"}
```

The signal is there, it is logged once per stream, and `segment_durations_unread_total` counts it.
**Nothing connects it to the consequence**, so it read as a note about a duration rather than as a
recording about to be published unplayable.

## Why that recording had no video at the start

The fifth segment holds **5 video packets in 2.51s**, which is about **2 frames per second** against
a requested 30. That is the publisher throttle of Phase 0.2 and task #76, already diagnosed: a
consumer slower than the stream's bitrate does not error, it stretches media time and the delivered
frame rate collapses. This recording caught it at its worst, with the first eight seconds delivering
no frames whatsoever.

⭐ **So the cause is old and the consequence is new.** #76 said a throttled publisher degrades the
picture. What had never been shown is that a throttle **at second zero** does not degrade the
picture, it removes it entirely and permanently, and reports a warning that is marked non-fatal.

## What changed

`make:recording` now **refuses** a recording whose log names any segment holding no video packets,
and `parseUploaderLog` gained `videolessSegments` so any scenario can ask.

⛔ **The check is anchored on the reason, not on the warning.** The same warning fires when a
segment's timestamps are unusable, which is a different fault and does not cost the picture. A
pattern matching the warning would refuse usable recordings and send someone hunting for a video
problem that is not there. There is a test for exactly that distinction, and removing the anchor
fails it.

## ✅ What was decided: the uploader withholds them (task #41)

The instrument was fixed the same day. **A viewer was not**, until this: a broadcast whose opening
segments carried no video became an unplayable recording and the deployment published it anyway.

A video stream's opening segments are now held back until one carries a frame, so the first fragment
any player parses has a picture in it. It costs the audio in those seconds, about 8 here, and buys
the other 201. Nothing is uploaded for a withheld segment, so no stamp is spent on media no viewer
would ever be told about.

⛔ **The three bounds are the design. Withholding on its own is the easy half.**

| bound | why it is not optional |
| --- | --- |
| **Never for an audio stream** | every segment of one carries no video, so the guard would publish nothing at all, ever |
| **Give up at 10 seconds**, publish anyway at error level | a publisher that never sends a frame under a video mediatype would otherwise be taken off the air **by the guard**. A silent outage this causes is worse than the fault it prevents |
| **Publish bytes that are not a transport stream** and stay armed | zero video packets is equally what any other container looks like from here. Without the separation, an engine this cannot parse has **every** segment withheld, and the counter reports a publisher sending no frames |

That last one is why `countPesPackets` exists rather than a `videoPackets === 0` check: it separates
**media with no picture** from **bytes that are not media**, which `readVideoPts` answers identically.

`opening_segments_withheld_total` on `/metrics` and `openingSegmentsWithheld` on `/health`, with no
threshold and no reason raised, exactly as `segmentsSkipped` carries none. **The pair is the reading**:
climbing for a few seconds and stopping is the guard working, climbing while
`segments_uploaded_total` stays at zero is a publisher sending no frames, and those two were
indistinguishable from outside before this.

Six mutants, each run alone and each killed: arming for audio, dropping the ceiling, never disarming
on a segment with video, treating unreadable bytes as videoless, not counting a withhold, and arming
after recovery regardless of what the restored manifest already named.

⚠️ **After recovery the gate is armed only where the crash beat the first manifest.** A restored
manifest naming a segment is one players were served, and their codec sets are fixed whatever the
stream does next, so withholding there would lose media and change nothing a viewer sees.

## ⭐ The transferable part

**A recording is an artifact, and an instrument that produces one has to check it is usable.**
`make:recording` verified the variable it was built to vary — it refuses if the arm armed no
discontinuity, and refuses if the control armed one — and never checked that the media it made had a
picture in it. So it handed back a recording that could not play, and the playback run against it read
as an intermittent player defect for a day.

⚠️ Note what this does **not** overturn: the retracted seek claim was killed by a replicate, not by
this. Run 3 seeked perfectly across a discontinuity. This explains what run 1 was, which is a
different recording with a different fault.
