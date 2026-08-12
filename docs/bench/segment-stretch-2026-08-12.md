# What stretches a segment: our own publisher, and only once a network is in the way

**2026-08-12.** Predictions in `segment-stretch-prediction-2026-08-12.md`, written before any arm ran.
Free throughout: stock `ossrs/srs:6`, no bee, no uploader, no postage, nothing broadcast to Swarm.

#76 said stock SRS honours `hls_fragment` exactly and our deployment therefore under-delivers by 45%.
**The first half survives every arm here. The second half does not survive its own controls.**

## The two things that were already ruled out before an arm ran

| | measured | needed |
| --- | ---: | ---: |
| uplink, laptop to the deployment host | **26 Mbps** | 6 Mbps |
| encoder, 1080p/6000k, paced, n=2 | **30.0 fps, speed 0.997x** | 30 fps |

⭐ Both cost about a minute, and each kills a hypothesis I would otherwise have spent the night on.
The 720p arm ran first as the known-answer control and returned 30.0 fps exactly.

## ⛔⛔ THE PUBLISHER HAS NO RATE LIMIT OF ITS OWN, WHICH NOTHING HAD NOTICED

`-use_wallclock_as_timestamps 1` puts an epoch value on every frame. ffmpeg's `realtime` filter
decides how long to pause from the frame's own presentation time and **resets its timer on any gap
over its two-second `limit`**, so an epoch stamp defeats it on every frame. Against a null sink the
bench recipe ran at **418-882 fps** rather than 30.

⚠️ **Those are not capability figures**, they are the absence of a brake, and reporting them as speed
would be the same class of mistake this whole document exists to correct. What they establish is
structural: **a bench broadcast is paced by whatever consumes it, not by the `realtime` filters the
recipe was built around.** Against a healthy sink that consumer paces it to exactly 30 fps, which is
what every arm below shows.

## The local sitting, and it is as clean as this instrument has ever been

`hls_fragment 1.0`, GOP 1.0, 1080p/6000k, six arms, control first and last.

| recipe | transport | timeline | fps | median | min-max |
| --- | --- | --- | ---: | ---: | --- |
| **probe** | RTMP | invented | 30.0 | **1.000s** | 1-1 |
| bench-nostamp | SRT + MPEG-TS | invented | 30.0 | **1.052s** | 1-1.136 |
| **bench** | SRT + MPEG-TS | **wallclock** | 30.0 | **1.000s** | 1-1 |

**Every arm reproduced itself exactly across both rounds, and the control that ran last matched the
control that ran first.** SRT adds 5% of jitter and nothing else.

⛔ **H2 is refuted as stated: the bench recipe does not stretch a segment on loopback.** The wallclock
timeline produces 1.000s segments to three decimal places, because a loopback sink paces the publisher
perfectly and the stamps then record a pace that is correct.

⚠️ **Read that with the next section, not on its own.** The recipe turns out to be the cause after
all. What this sitting establishes is that **it needs a network to express itself**, which is exactly
why five earlier local brackets cleared it.

## ✅✅✅ H1 CONFIRMED: MOVE ONLY THE ENGINE ONTO THE HOST AND THE STRETCH APPEARS

Identical recipe, identical `hls_fragment 1.0` and GOP 1.0, identical 1080p/6000k, identical stock
image, identical encoder on this same laptop. **The single thing that changed is that the media
engine is on the deployment host and the frames cross the internet to reach it.**

| | segments | mean bytes | **median duration** |
| --- | ---: | ---: | ---: |
| local, loopback | 60 | 775 KB | **1.000s**, min = max |
| **to the deployment host** | 25 | **785 KB** | **2.400s** |
| the deployment itself, 629 segments | 629 | **787 KB** | **1.917s** |

⭐⭐⭐ **Same bytes per segment in all three, to within 1.5%, and the clock stretches.**

⚠️ **That 2.400s is one draw and the spread is wide.** A later replicate of the identical arm returned
**1.356s**, so the between-run variance of a stamped network arm is about **1.8x**. What is stable is
the loopback side: every loopback arm reproduced itself exactly, min equal to max, across both rounds.
So the number to carry is not 2.400s, it is **"stamped and across a network, always stretched, by an
amount that moves"**.

## ✅✅✅ AND THE PATH IS NOT SLOW EITHER. IT IS OUR OWN TIMESTAMPING.

The arm that separates the two ran the **same encoder to the same host over the same SRT connection**,
changing only whether frames carry wallclock stamps.

| recipe | loopback | **across the internet** |
| --- | ---: | ---: |
| unstamped, SRT + MPEG-TS | 1.052s | **1.052s**, n=3, identical to three decimals |
| **wallclock-stamped**, SRT + MPEG-TS | 1.000s | **1.356 to 2.674s**, n=6 |

⭐⭐⭐ **The unstamped arm crossed the internet at fps 30, speed 0.999x and a sustained 6,363 kbit/s,
delivering 1800 frames in 60.00 seconds and segments identical to its loopback twin.** The path
carries the full profile without complaint. Only the stamped arm stretches, and only when there is a
network in the way.

## ⛔⛔⛔ SO BOTH EARLIER CAUSES ARE WITHDRAWN, AND THE DEFECT IS OURS

Not SRS, which honours its knob everywhere. Not the deployment host, which receives what it is sent.
Not the link, which carries 6.36 Mbps of exactly this stream. **It is `wallclockPublisher`.**

1. epoch timestamps defeat the `realtime` filter, so the publisher has **no rate limit of its own**
2. it therefore writes as fast as the socket accepts, and SRT paces sends against its congestion window
3. that backpressure stalls the demuxer, and **wallclock stamps record each stall as elapsed media time**
4. SRS cuts on the timeline it is given, exactly where its knob says, and emits a longer segment

⭐⭐ Every step is ordinary and correct in isolation. Together they mean **transient send-side
backpressure is written permanently into the media timeline**. On loopback there is no backpressure,
which is why five separate local brackets could never see this.

⚠️ **The flag is not a mistake, it is a trade nobody had priced.** `wallclockPublisher.ts` documents
why it stamps at demux time: a bench measuring glass-to-glass latency needs capture instants that are
honest, and `-output_ts_offset` biases every reading by ffmpeg's ~1.45s startup. That reasoning holds.
What it did not anticipate is that the same stamps also record the network's pacing as the stream's
own frame rate.

## ⭐⭐⭐ THE IDENTITY: SEGMENT DURATION IS GOP FRAMES DIVIDED BY ACHIEVED FRAME RATE

Every arm in this campaign satisfies `median ≈ gopFrames / fps`, which makes the whole effect
predictive rather than merely observed. `-g` counts **frames**, so a 30-frame GOP spans 30/fps
seconds, and SRS cuts at the first keyframe at or after the fragment.

| arm | ffmpeg `fps` | 30 / fps | **measured median** |
| --- | ---: | ---: | ---: |
| unstamped, to the host | 30 | 1.00s | **1.052s** |
| stamped, 1080p 3000k | **17** | 1.76s | **1.740s** |
| the deployment, 629 segments | ~15.7 | 1.92s | **1.917s** |

⭐ The 3000k row is the one where ffmpeg's own `fps` was read rather than inferred, and it agrees to
within 0.3%. The rest of the identity is arithmetic on `-g` counting frames, so it holds wherever the
frame rate is known.

⛔⛔ **So the stream was never 30 fps. It was about 15.** ffmpeg reports it plainly once you look:
the 3000k arm logged `fps= 17` alongside **`drop=1495`**, having emitted 1021 frames across 59.29s.
The unstamped arm dropped nothing and emitted 1800 across 60.00s.

⭐ **Frames are being dropped to reconcile a real-time timeline with an unpaced source.** That is the
quality cost nobody had seen: not a lower bitrate at full motion, but **half the frames**, on a
profile the deck calls 1080p30.

## ⛔⛔ THE LADDER ORDERS NOTHING, AND ITS OWN REPLICATE IS WHY

Four stamped arms across the same path, in `host-stretch-ladder-2026-08-12.json`:

| arm | median | achieved kbit/s |
| --- | ---: | ---: |
| 1080p 6000k | **2.400s** | 2,680 |
| 1080p **3000k** | 1.740s | 1,968 |
| **720p 2500k** | 2.674s | 1,116 |
| **1080p 6000k, replicate of row 1** | **1.356s** | 4,776 |

⛔⛔ **The replicate of the first row lands at 1.356s against 2.400s. One configuration, two runs,
1.8x apart**, which is wider than every gap the ladder was built to read. After the first two rows I
had written "lower bitrate reduces the effect"; the 720p row refuted that, and the replicate then
showed the whole ranking was inside the noise.

⭐ **What survives is stronger than what did not.** Across six stamped arms and three configurations
the median never once came down to the unstamped value: **1.356s to 2.674s stamped, against 1.052s
unstamped on the same path.** The effect is present every time. Its magnitude is not modelled and
should not be quoted as a single number.

## ✅✅✅ THE CONTROL, REPLICATED, AND IT IS THE STRONGEST THING HERE

The whole conclusion rested on one unstamped network arm, which after a 1.8x spread on the other side
is not enough. So a second sitting alternated the two recipes across the same path.
`host-stamped-vs-unstamped-2026-08-12.json`.

| recipe | n | medians |
| --- | ---: | --- |
| **unstamped, across the internet** | **3** | **1.052, 1.052, 1.052** |
| stamped, across the internet | **6** | 1.356, 1.406, 1.740, 2.400, 2.642, 2.674 |

⭐⭐⭐ **Three unstamped runs returned the same median to three decimals, the same 1-1.136 range, and
the same 6363.1 kbit/s to one decimal place.** Six stamped runs returned six different numbers, none
of them below **1.29x** the unstamped value.

The two alternating rounds put the pair minutes apart rather than sittings apart: round 1 gave
**1.052 against 2.642**, round 2 gave **1.052 against 1.406**. The stamped arm moved by 1.9x between
rounds while the unstamped arm did not move at all.

⭐⭐ **That is the finding in its sharpest form.** The network is doing the same unruly thing to both
recipes. One of them absorbs it and delivers a steady stream. The other writes it into the media
timeline, where it becomes a longer segment and a lower frame rate that nothing reports as an error.

## ⚠️ This is the second re-attribution of the same measurement

The 1.917s figure has now been blamed on `HLS_FRAGMENT`, then on the deployment host, and is here
blamed on our own publisher. **The measurement was right all three times.** What kept changing is the
cause, and the cause is what propagated into the cost model, a headroom claim and a slide deck.

⛔ The reason the first two attributions survived as long as they did is that every arm testing them
ran on one machine over loopback, where the effect cannot exist. **A local reproduction of a
distributed system's fault is not a control, it is a different experiment.**

## What is still open

- **A GOP longer than the fragment** also stretches segments, by SRS's documented rule, and no arm in
  #76's bracket ever ran that pairing. It is not needed to explain these numbers, but it has never
  been measured here and `DEFAULT_KNOBS` sets `gopSeconds: 2`.
- **Whether the uploader's `on_hls` webhook contributes.** No arm here has an uploader behind it, by
  design, so the webhook is neither implicated nor cleared.
- **How big the effect is.** Its presence is solid at n=4 across three configurations, and a replicate
  of one configuration moved 1.8x, so nothing here supports a number. Anyone quoting one should say
  which draw it came from.
- **Why the stamped recipe drops frames at all**, given the unstamped one on the same socket in the
  same sitting drops none. `drop=` counts the reconciliation, not the cause.

## What is settled enough to act on

⭐ **Do not read a bench broadcast's segment duration as a property of the deployment.** It is a
property of the publisher's timeline, and this publisher's timeline records the network. The fix, if
one is wanted, is a publisher that paces itself rather than relying on a filter that epoch timestamps
switch off. That is a decision about the bench, not about the product, and it is the owner's.
