# A viewer with no gateway at all, on a live broadcast

**2026-08-16, one broadcast of 88 minutes at 1280x720 / 2500 kbps / 0.5s GOP.** Eight arms of eleven
minutes, alternating two viewers, round one discarded, **three counted per condition**. Artefacts at
`/home/solarpunk/byte-source-arms/gatewayless-20260816-095727`, driver
`ARM_PAIR=gateway-less bash deploy/scripts/byte-source-arms.sh`.

**Cost 1.267 BZZ** against a gate model of 2.962, because the model prices a gateway that half the
arms never ask.

## What the two conditions are

| | |
| --- | --- |
| **native** | weeb-3's own published page. Feed, manifest and segments all from the Swarm node in the tab. |
| **weeb3** | our client. Segments from the in-tab node, feed and manifest from a bee gateway. |

⚠️ **The contrast moves two things**, whose page and player, and whether a gateway serves the
manifest. It bounds what going fully gateway-less costs. It does not isolate either one.

⭐ The gateway ran **funded, warm and at 134 peers throughout both conditions**, deliberately. A
broke bee node answers `/health` in 1.1ms with 134 peers while viewers go 0.1% to 10.6% late, so a
zero read against a dead gateway would be an alibi rather than a result.

## Result 1: it works, and the gateway is provably untouched

| arm | condition | **gateway retrieval requests** | drift over 11 min | realtime |
| ---: | --- | ---: | ---: | ---: |
| 3 | native | **0** | +0.44s | 1.00 |
| 6 | native | **0** | +0.54s | 1.00 |
| 8 | native | **0** | +0.79s | 1.00 |
| 4 | weeb3 | 2,346 | −1.03s | 1.00 |
| 5 | weeb3 | 2,452 | −0.60s | 1.00 |
| 7 | weeb3 | 2,563 | −0.56s | 1.00 |

**Zero overlap, read off the gateway's own counters.** Gateway spend across the whole sitting,
including four hybrid arms, was **0.0070 BZZ**.

⭐ **Drift is the honest column here, and it is the same statistic on both viewers**: wall seconds
elapsed minus media seconds played. It needs no agreement about where the live edge is, and the
origin offset cancels, which matters because the two players do not share one.

## Result 2: ⛔⛔⛔ IT JOINS AT THE EDGE, THEN A TIMELINE REBASE LEAVES THE PLAYHEAD BEHIND

> ### ⛔⛔⛔ CORRECTED THE SAME EVENING, AFTER THIS FILE WAS MERGED
>
> The first version of this section was headed "IT DOES NOT JOIN AT THE LIVE EDGE, IT STARTS AT THE
> BEGINNING", and offered reading-the-feed-from-index-zero as the mechanism, marked as an inference.
> **Both clauses of that heading are wrong.** weeb-3 joins at the live edge and is moved off it a few
> seconds later. The measured lag is unchanged and every number in the old table still stands. What
> causes it, and therefore what to do about it, is completely different.
>
> ⭐ It was found by doing the free bundle read the old section itself asked for, and then re-reading
> the arms' own `seekable` ranges, **which were already on disk when the wrong version was written**.

### The arms open at the live edge, on weeb-3's own clock

`currentTime` and `seekableEnd` are read from weeb-3's own media element, so this needs no agreement
with our publisher's clock and no shared origin.

| arm | joined, into the broadcast | at the first sample | **behind its own edge** |
| ---: | ---: | --- | ---: |
| 1 | 86.2s | 22.57s of a 25.50s timeline | **2.93s** |
| 3 | 1,555.7s | 22.92s of a 27.03s timeline | **4.11s** |
| 6 | 3,788.8s | 22.90s of a 27.60s timeline | **4.70s** |
| 8 | 5,313.3s | 22.57s of a 25.50s timeline | **2.93s** |

**Four arms of four, at 2.9 to 4.7 seconds behind the edge**, against our own client's 2.02s. A
gateway-less viewer joins live.

### Then the timeline expands and the playhead does not follow

Between one and four seconds later, `seekableEnd` jumps from about 27 seconds to the broadcast's
whole age in a single sample.

| arm | at | edge before | **edge after** | jump | broadcast age then |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | t=1.1s | 25.5s | **82.0s** | +56.5 | 86.2s |
| 3 | t=2.0s | 28.5s | **1,557.0s** | +1,528.5 | 1,555.7s |
| 6 | t=3.0s | 28.6s | **3,790.0s** | +3,761.4 | 3,788.8s |
| 8 | t=4.0s | 29.0s | **5,315.5s** | +5,286.5 | 5,313.3s |

⭐ **The new edge is the broadcast's age at that instant**, within 4 seconds every time across a
62-fold range. weeb-3 is discovering the history behind the window it opened on. The playhead stays
where it was, near 25 seconds, and from there plays forward at realtime and never catches up.

⭐⭐ **The harness had already recorded this and nobody read it.** `appendedEdgeLagMaxS` is 82.0,
1,557.0 and 3,766.5 on the three counted arms, which is the jump itself. It sat in the same JSON as
every figure that was quoted.

### The lag is real, measured inside weeb-3 alone

At the last sample, `seekableEnd - currentTime` on weeb-3's own element:

| arm | behind its own edge, at the end | behind production, our clock |
| ---: | ---: | ---: |
| 1 | 57.2s | 64.5s |
| 3 | **1,056.4s** | **1,532.8s** |
| 6 | 3,765.7s | 3,765.9s |
| 8 | 5,290.5s | 5,290.7s |

Arms 6 and 8 agree to a quarter of a second across two independent clocks, which is what makes the
lag a finding rather than an artefact of mixing them.

⚠️ **Arm 3 disagrees by 476 seconds and is not explained here.** Its own reported edge, 1,738.6s,
sits well behind the broadcast's true age of 2,215.7s at that moment, so for that arm weeb-3's
timeline had not caught up with production either. Whatever that is, it is separate from the rebase
and this sitting does not resolve it.

### What the source says, read but not executed

weeb-3 is open source and the deployed build carries the same strings as the npm package we depend
on, checked both ways.

- The route selects the mode. `src/stream_conventions.rs` maps `/stream/...` to `HlsStart::Beginning`
  and `/live/stream/...` to `HlsStart::Live`. **The sitting used the live route**, so live was asked
  for and granted.
- `src/stream_hls.rs` emits `#EXT-X-START:TIME-OFFSET=-<tail>,PRECISE=NO` for a live start and
  `TIME-OFFSET=0,PRECISE=YES` only for a beginning start. The live tag is what we observed.
- `hls_timeline_rebase_required()` fires when a newly discovered playlist starts at a **lower media
  sequence** than the one in play. Our uploader publishes a byte-budgeted trailing window with a
  moving media sequence, so a full-history playlist discovered afterwards always satisfies it.
- `hls_timeline_rebase_position(previous_edge, current_time, candidate_edge)` computes
  `candidate_edge - (previous_edge - current_time)`, which **preserves the distance behind the edge**
  and is exactly right. For arm 8 it would have produced 5,312.1s and kept the viewer live.
- Its caller takes that position only when both the old and new edges are known, and otherwise falls
  back to the session's `initial_position`.

⚠️ **The last step is an inference, not a measurement.** The observed post-rebase playhead matches
the fallback and not the computed position, but this project has not run weeb-3's code to see which
branch it took.

⭐⭐⭐ **So this is a defect with a location, not a missing feature.** The distance-preserving
arithmetic already exists in weeb-3 and does not reach the media element.

### ⛔ And our half of the trigger is not ours to remove

The rebase needs a trailing window whose media sequence moves, which is exactly what we publish. The
obvious response is to publish the whole playlist instead. **That is not available.**

`LIVE_WINDOW_MAX_BYTES` is **4096**, and it is not a taste: it is one bee single-owner chunk. bee-js
writes a feed payload straight into the chunk while it fits, and past that uploads the payload
separately, downloads its root chunk back and wraps that instead. **Crossing it turns one round trip
per publish into three, on a path that runs once per segment.** An 88-minute broadcast at a 0.5s GOP
is thousands of segments, so a full playlist is orders of magnitude over the limit.

⭐ **And the window is demonstrably workable**, because our own client reads the same feed and sits
2.02s behind. It accumulates history as it goes, from the start of its own session, so its timeline
origin never moves. weeb-3 opens on the window and then fetches history behind it, which is what
changes the origin mid-session.

**Reported upstream as [lat-murmeldjur/weeb-3#2](https://github.com/lat-murmeldjur/weeb-3/issues/2)**,
with both candidate code paths named and neither asserted, because separating them needs their code
run rather than read.

## Result 3: ⭐⭐⭐ THE MAIN THREAD COST IS SET AT JOIN BY THE BROADCAST'S AGE, AND THE CONTROL IS FLAT

> ⛔ **The mechanism this section originally offered was withdrawn the same evening**, from the
> sitting's own saved samples. The measured climb below stands. See the withdrawal after the table.

The ceiling that matters for weeb-3 is a single JS thread.

| arm | joined at | **native main thread** | | weeb3 main thread |
| ---: | ---: | ---: | --- | ---: |
| 1 | 86s | mean 0.435, peak 0.781 | | 0.220 / 0.590 |
| 3 | 1,556s | mean 0.670, peak 0.851 | | 0.225 / 0.605 |
| 6 | 3,789s | mean 0.723, peak 0.879 | | 0.217 / 0.455 |
| 8 | 5,313s | mean **0.746**, peak **0.899** | | 0.215 / 0.514 |

**The native arm climbs 72% across the sitting. The hybrid arm sits at 0.220 ± 0.005 over the same
window.** That flat control is what makes this readable: host drift, thermal effects and neighbour
load would move both, and they moved one.

⛔⛔ **By 88 minutes in, a 720p gateway-less viewer peaks at 0.899 of one thread.** For comparison,
our hybrid client peaked at 0.707 of one thread at **1080p** (`1080p-main-thread-2026-08-15`). The
gateway-less path is closer to its ceiling at 720p than the hybrid is at 1080p.

⚠️ **Four points, and join lag is confounded with position in the sitting** for the native arms,
which ran 1st, 3rd, 6th and 8th. Counterbalancing does not break that particular confound. The flat
control is the argument, not the sample size.

### ⛔⛔⛔ THE MECHANISM PARAGRAPH WAS WITHDRAWN, THEN REINSTATED, 2026-08-16 evening

**What stood here** was: a viewer that keeps the whole broadcast pays per segment **count**, hls.js
re-parses the entire playlist on every refresh (`swarm-hls-viewer-manifest-growth`), the native arm
holds a playlist spanning the entire broadcast after the rebase, so the later the arm joined the more
of it there is to re-parse. It was marked "a mechanism that fits".

**It was withdrawn on the strength of the within-arm readings below, and then reinstated when the
request logs were counted.** Read both parts. The per-arm JSONL the sampler wrote was never read
past its mean and peak. With `deploy/scripts/main-thread-slope.py`, on sixty-second window medians:

| native arm | joined at | median | first 3 windows | last 3 windows | **change** |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 86s | 0.398 | 0.473 | 0.474 | **+0.001** |
| 3 | 1,556s | 0.676 | 0.678 | 0.675 | **-0.003** |
| 6 | 3,789s | 0.717 | 0.722 | 0.730 | **+0.008** |
| 8 | 5,313s | 0.768 | 0.812 | 0.769 | **-0.043** |
| *hybrid controls* | | | | | *+0.008, +0.009, +0.005, -0.007* |

**Within its own session a native arm does not move, and it does not move by more than the control
does.** The climb is entirely between arms.

### ⛔⛔⛔ AND THIS WITHDRAWAL WAS ITSELF WRONG, CORRECTED THE SAME EVENING

**The mechanism is right. My reason for withdrawing it was not.** Both were settled by counting the
arms' own request logs, which nothing had read.

| joined at | **manifest re-fetches** | per second | **median manifest** | manifest ÷ video bytes | thread |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 86s | 1,202 | 1.82 | **0.078 MB** | 0.37x | 0.398 |
| 1,556s | 1,291 | 1.95 | **0.322 MB** | 1.67x | 0.676 |
| 3,789s | 1,091 | 1.65 | **0.791 MB** | 3.29x | 0.717 |
| 5,313s | 1,110 | 1.68 | **1.083 MB** | 4.58x | 0.768 |

⭐⭐⭐ **weeb-3 re-fetches the whole manifest from one URL about 1.7 times a second, and its size
tracks the broadcast's age at roughly 205 bytes per broadcast second.** The last arm moved
**1,195 MB of manifest against 261 MB of video**. A recording arm fetches it **once**.

**So the playlist really is re-read continuously, and it really does grow with the broadcast.** That
is what the withdrawn paragraph said.

⛔ **What was actually wrong was my prediction, not the mechanism.** I derived "+0.042 inside every
arm" by fitting `cost = a + b x playlist_seconds`, which assumes the cost is **linear** in playlist
size. It is not: the measured response saturates, +0.278 of a thread for the first +0.244 MB and
+0.051 for the last +0.292 MB. Inside an eleven-minute arm the manifest grows by about 135 KB, which
in the flat region predicts a rise of roughly +0.02 — under this instrument's noise. **The absence of
a within-arm rise therefore does not refute the mechanism, and I treated it as though it did.**

⛔ **The second branch was refuted by measurement, not reasoning.** I argued the re-parsed playlist
could not be growing because `LIVE_WINDOW_MAX_BYTES` caps what our uploader publishes at 4096 bytes.
The payload actually fetched reaches **1.083 MB**, so whatever weeb-3 is polling is not our capped
live window.

✅ **What survives from the withdrawal:** the within-arm flatness is real and correctly measured, and
the per-sample fitting artefact below is real and worth keeping.

⛔⛔ **What is retracted:** "the mechanism does not fit", "both branches fail", and the claim that one
variable cannot have a large between-arm effect and no within-arm effect. **A saturating response
does exactly that.**

See `recording-timeline-2026-08-16.md`, where the recording arms make the same point from the other
side: one manifest fetch instead of 1,110, at identical video throughput.

### ⛔⛔ And the method that nearly published the opposite

Fitted **per sample** rather than per window, arm 8 reads **+0.176 of one thread over the arm,
t = 5.28**, and would have been written up as the native path accelerating toward saturation. On
window medians the same arm is `+0.151 +/- 0.114, t = 1.32`, and its first three windows are
**higher** than its last three. The entire apparent climb is one low opening window, 0.36 against
0.73 to 0.84 for the eleven that follow, which is the page still settling.

Five-second readings of a browser's task time are strongly autocorrelated, so an ordinary
least-squares standard error over them assumes an independence that is not there.
`drift-holds-and-bends-2026-08-15` already fitted on windows for this reason, and the script now
carries the reason so the next reader does not have to rediscover it.

### What Result 3 now says, and what is open

✅ **Stands:** the native arm's cost rises with the broadcast, 0.435 to 0.746, while the hybrid
control holds 0.220 ± 0.005. The flat control is still the argument.

⭐ **Sharper than before:** the cost is **set at join and then flat for the session**, and what sets
it is the manifest weeb-3 re-fetches about 1.7 times a second, whose size tracks the broadcast's age.
Within a session that manifest grows too little to move a saturating response.

✅ **No longer open.** `recording-timeline-2026-08-16.md` closes it: timeline length and playhead
position are both nulls on a recording, retrieval volume is the smaller cost, and the live premium
lands on manifest re-fetching, one fetch against 1,110 at identical video throughput.

## Container CPU, for completeness and not as the ceiling

Native 3.01 to 3.12 cores, hybrid 1.68 to 1.75. ⛔ The process-tree total flattered the in-tab node
by 2x once before (`main-thread-saturation-2026-08-14`), which is why the thread column above is the
one that carries the argument.

## What else was running on the box, read after the fact

⚠️ **Filed 2026-08-16 evening, not captured by the harness at the time.** A peer session measuring
from Frankfurt through the `loadlab` stack on this same host got in touch, which is what prompted
the check.

`loadlab-manager-host-srs-1` and `loadlab-manager-host-stream-uploader-1` emitted **zero log lines
between 09:50Z and 11:45Z**, which brackets the whole sitting. They were restarted at 13:50Z, after
it ended. So the loudest co-tenant on the host was not streaming during any arm.

⛔ **Zero log lines is not zero CPU**, and this is a reading taken afterwards rather than a snapshot
either side of each arm, which is what the standing rule asks for. The other compose projects on the
box (`pacbench-*`, `bee-1` through `bee-40`, `srs-check-test1-*`, `ome-e2e-test1-*`) were not read at
all. Treat this as ruling out one specific neighbour, not as a clean co-tenancy record.

⭐ It also does not carry the argument. **The flat hybrid control does**, because a neighbour heavy
enough to move the native arm 72% would have moved the control too.

## ⛔ An instrument defect found in this sitting, not fixed in it

**The segment tally is a rolling window of weeb-3's own log panel, not a total.** It reads about 24
in every arm, and 24 segments at 0.5s is twelve seconds of media against a 660-second window. It
cannot be quoted as throughput, and the label in `weeb3-native.ts` is being corrected to say so.

## What this changes

- ✅ **KEEP: a fully gateway-less viewer sustains a live broadcast at realtime**, three counted arms,
  zero gateway retrievals each, drift under a second in eleven minutes.
- ✅ **KEEP: it costs the gateway nothing.** 0.0000 BZZ on every native arm.
- ✅ **KEEP, NEW: it does join at the live edge**, 2.9 to 4.7s behind on its own clock, four arms of
  four. The gateway-less path is not architecturally a from-the-beginning viewer.
- ⛔ **DO NOT SHIP IT AS A LIVE VIEWER YET.** A timeline rebase drops the playhead seconds after the
  join, and the viewer then sits behind by the broadcast's age at that moment, permanently. A
  three-hour broadcast still opens three hours behind.
- ✅ **DONE: raised as [lat-murmeldjur/weeb-3#2](https://github.com/lat-murmeldjur/weeb-3/issues/2)**,
  with `hls_timeline_rebase_position()` named and both candidate code paths listed, neither asserted.
- ⛔ **DO NOT try to fix it by widening our live window.** 4096 bytes is one bee single-owner chunk,
  and crossing it costs three round trips per segment instead of one.
- ⛔ **DO NOT extrapolate the main thread past 88 minutes or past 720p** from this. What is measured
  is that it climbs and that the control does not.
- ⚠️ **Nothing here speaks to the multi-hour thread creep** measured over three hours in
  `drift-holds-and-bends-2026-08-15`. These arms are eleven minutes each.
