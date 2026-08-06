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

## What this does not say

**Three minutes each, one run each, one sitting.** Enough to screen, not to gate.
[[swarm-hls-optimisation-campaign]] holds the rule this follows: a three-minute run reproduces a
ten-minute median to within 0.06s, so screen at 3 and gate at 10.

⚠️ **The hour that held was measured at 720p/2500k only.** The mechanism behind #76 is a consumer
slower than the stream's **bitrate**, and 6000k is 2.4x more of it, so length is exactly where a
1080p stream would be expected to fail if it fails at all. Three minutes cannot see that.

**One machine, one viewer, one publisher on the deployment host.** Nothing here says what a second
viewer costs at 1080p, and [[swarm-hls-concurrent-viewers]] found a viewer **adds** load rather than
sharing it.
