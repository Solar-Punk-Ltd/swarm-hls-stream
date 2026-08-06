# Quality, judged at a viewer

**2026-08-06.** Three configurations at a 0.25s GOP, each watched for three minutes in real Chrome on
the deployment host, **in one sitting**. Task #89.

Everything this project knew about resolution and bitrate came from the bench, which reads bytes
rather than playing them. So the question "does 1080p arrive" had been answered as "the bytes arrive"
and never as "the picture arrives".

## The instrument that had to exist first

Quality had been judged on **resolution** and **dropped frames**, and the failure this project has
actually met shows up in neither. A consumer slower than the stream's bitrate does not error and does
not drop frames: it **stretches media time**, so the encoder's log shows its keyframe interval hit
exactly while the frame rate underneath collapsed. Task #76 reproduced **12.2fps against a requested
30** that way.

So a viewer sample now carries the decoder's own frame count and the summary divides it by **media**
seconds. That denominator is the whole point: a frozen picture decodes nothing, so a wall-time rate
reads a freeze and a collapse as the same number, and the two need opposite fixes.

## What arrived

| | resolution | **fps** | media per wall s | stalled | rebuffers | dropped | behind live | buffer |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 720p 2500k | 1280×720 | **30.0** | 1.012 | 0/178 | 0 | 8 | 5.91s | 4.84s |
| 1080p 4000k | 1920×1080 | **30.0** | 0.998 | 0/178 | 0 | 6 | 5.89s | 5.06s |
| 1080p 6000k | 1920×1080 | **30.0** | 0.999 | 0/178 | 0 | 4 | 5.84s | 5.01s |

⭐ **1080p at 6000kbps arrives intact.** Full resolution, thirty frames per second of media exactly,
no stalled samples, no rebuffers, and a viewer sits **5.84s behind live against 5.91s at 720p**. The
latency difference across a 2.4x bitrate range is **70 milliseconds**, which is smaller than the
spread between two sittings of one configuration.

**Nothing degrades gracefully here because nothing degrades.** The frame rate is the same integer at
every setting, and dropped frames go **down** as the bitrate goes up, which at 8, 6 and 4 frames over
three minutes is noise rather than a trend.

## What it costs

| | delivered | median transfer | BZZ per broadcast-minute |
| --- | ---: | ---: | ---: |
| 720p 2500k | 2.72 Mbit/s | 86ms | 0.0170 |
| 1080p 4000k | 4.23 Mbit/s | 89ms | 0.0260 |
| 1080p 6000k | 6.24 Mbit/s | 107ms | **0.0381** |

**The delivered bitrate tracks the requested one to within 9%**, so the encoder is producing what it
was asked for and all of it is reaching the viewer. The price of the best picture is **2.24x the BZZ**
and 21ms of median transfer time. Quality here is bought with bandwidth, not with latency.

## ✅ GATED AT TEN MINUTES, at the best configuration

`browser-watch-2026-08-06T06-21-17-165Z.md`, same sitting, 594 samples over 10.0 minutes.

| | 1080p 6000k, 3 min | **1080p 6000k, 10 min** |
| --- | ---: | ---: |
| resolution | 1920×1080 | **1920×1080** |
| frames per second of media | 30.0 | **30.0** |
| media per wall second | 0.999 | **1.000** |
| median of the per-sample ratios | — | **1.000** |
| stalled samples | 0/178 | **0/594** |
| rebuffers | 0 | **0** |
| dropped frames | 4 | 15 |
| fatal errors | 0 | **0** |
| behind live, median | 5.84s | **5.77s** |

⭐ **The best picture this deployment can make holds for ten minutes with nothing to report.** No
stalled sample, no rebuffer, no fatal error, thirty frames per second of media, and latency between
**4.52s and 6.45s** across the whole run against a 6s target. `heldTarget` true, `ranLong` false.

⚠️ The one number that moved is **refusals: 14 in 2271 segments, 0.61%**, against 0 in the three
minute run at the same setting. That matches [[swarm-hls-loop-fixed]]: refusals appear at length
rather than at rate, 94 in 13,617 over the hour at 720p, all served on retry. **Nothing was lost**,
and the run finished at 1.000.

**This is the answer to the standing goal.** Stable, constant latency at the best quality available:
1080p at 6000kbps, a 0.25s GOP, ten minutes, 1.000.

## ✅ AND IT HOLDS FOR AN HOUR, with one disturbance

`browser-watch-2026-08-06T07-26-32-437Z.md`, 3,557 samples over 60.0 minutes at 1080p/6000k.

| | **1080p 6000k, 60 min** | 720p 2500k, 60 min |
| --- | ---: | ---: |
| samples | 3,557 | 3,558 |
| **frames per second of media** | **30.00** | not measured |
| media per wall second | **1.0000** | 1.000 |
| stalled samples | **5** | **0** |
| rebuffers | **5, 7,520ms** | **1, 246ms** |
| fatal errors | 0 | 0 |
| behind live, median | 5.68s | 5.59s |

⭐ **`deliveredFps` is 30.00 exactly across the whole hour.** That is the reading the run was for: the
encoder was **never starved**, so this is not #76 reappearing at 2.4x the bitrate. Whatever went wrong
was delivery timing, not the picture.

**Six ten-minute windows, and only one is disturbed:**

| window | advance | median behind live |
| --- | ---: | ---: |
| 0-10 | 1.0011 | 5.82s |
| 10-20 | 1.0004 | 5.79s |
| 20-30 | 1.0000 | 5.49s |
| 30-40 | 1.0001 | 5.47s |
| **40-50** | **0.9976** | 5.45s |
| 50-60 | 1.0006 | 6.43s |

**All five rebuffers fall inside four minutes**, at 46.3, 46.4, 46.4, 46.7 and 50.5 minutes. Behind-live
dropped to a minimum of **0.48s**, which is the live edge stopping while the player kept going rather
than the player improving, then overshot to 8.27s and was pulled back by
`MAX_LIVE_SYNC_PLAYBACK_RATE`. `heldTarget` true, `ranLong` false: it never crossed the seek threshold.

**So the honest verdict is not "it holds" and not "it fails".** It holds, at a cost 720p does not pay:
five stalled samples against none, and 7.5 seconds of rebuffering against a quarter of one. In an
hour that is 0.2%, and it is 30x what the cheaper profile cost.

⚠️ **One disturbance in one hour cannot tell a periodic fault from an accident.** A second hour is
what separates them and has not been run.

## ⛔ The probe audit cannot be done on this run, and the reason is my own instrument

Fix 0.8a's probe was verified as **0 in 2,308 requests** on the ten-minute run. Repeating it here
reported 96%, with distances up to +35 against a ladder that only asks +1, +2, +4 and +8.

That is `thinRequestLog` doing its job: over `MAX_LOGGED_SUCCESSES = 5_000` it keeps every Nth
success, and this hour kept **4,506 of more than 14,000**. Consecutive slot reads are missing, so
every gap in the sampled log reads as a jump.

⚠️ **A thinned request log cannot support any analysis that depends on one request following
another.** The ten-minute run was under the cap and was not thinned, which is why its answer stands
and this one does not.

## What this does not say

**Three minutes each, one run each, one sitting.** Enough to screen, not to gate.
[[swarm-hls-optimisation-campaign]] holds the rule this follows: a three-minute run reproduces a
ten-minute median to within 0.06s, so screen at 3 and gate at 10.

✅ **Sixty minutes has now been run at 1080p/6000k and the answer is above.** The frame rate held
exactly, so #76's mechanism was ruled out rather than merely not seen. What sixty minutes found that
ten could not is a single four-minute disturbance costing 7.5 seconds of rebuffering.

⚠️ Refusals grow with length at every profile measured: 0% at three minutes, 0.61% at ten,
**1.27% at sixty** (174 of 13,522), all served on retry.

**One machine, one viewer, one publisher on the deployment host.** Nothing here says what a second
viewer costs at 1080p, and [[swarm-hls-concurrent-viewers]] found a viewer **adds** load rather than
sharing it.
