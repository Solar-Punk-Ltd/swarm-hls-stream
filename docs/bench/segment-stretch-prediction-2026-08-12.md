# What stretches a segment: written before the arms ran, 2026-08-12

#76 concluded that stock SRS honours `hls_fragment` exactly and that our deployment host therefore
under-delivers by 45%. The first half survives. The second half rested on comparing two runs that
differed in more than the host, and this is the attempt to find out which difference did it.

## What is already known, and what it rules out

| | |
| --- | --- |
| uplink, laptop to the deployment host | **26 Mbps** against a 6 Mbps stream |
| encoder alone, 1080p/6000k, paced, n=3 | **30.0 fps, speed 0.997x** |
| encoder alone, 1080p/6000k, wallclock-stamped | 427-882 fps, **unpaced** |
| the deployment, measured over 629 segments | 787 KB per **1.917s** = 3.28 Mbps, so **15.65 fps** |

So the encoder can produce 30 fps at this profile and the link can carry four times the stream. Two
easy explanations are already dead.

⭐⭐ **The third row is the discovery that makes this worth running.** `-use_wallclock_as_timestamps 1`
puts an epoch value on every frame, and ffmpeg's `realtime` filter resets its timer on any gap over
two seconds, so the filter never pauses and the publisher has **no rate limit of its own**. Whatever
sets the pace of a bench broadcast, it is not the `realtime` filters the recipe was built around.

## The arms

All against stock `ossrs/srs:6` at `hls_fragment 1.0`, GOP 1.0, 1080p/6000k. No bee, no uploader, no
postage, so every arm is free.

| arm | encoder | engine | transport | timeline |
| --- | --- | --- | --- | --- |
| **probe** | laptop | laptop | RTMP | invented |
| **bench-nostamp** | laptop | laptop | SRT + MPEG-TS | invented |
| **bench** | laptop | laptop | SRT + MPEG-TS | **wallclock** |
| **bench-on-host** | laptop | deployment host | SRT + MPEG-TS | **wallclock** |

`probe` is the arm with the known answer and it runs first and last, because a sitting whose control
moved has not measured anything. `bench-nostamp` separates the transport from the stamping, which are
otherwise confounded: an epoch timestamp cannot ride in a 32-bit RTMP field, so every stamped arm has
to be an SRT arm.

## Predictions, each with what would kill it

**H1, the path.** SRT across the internet sustains well below what TCP does on the same link, the
publisher has no brake of its own, and the wallclock stamps record the socket's pace as the frame
rate.

- predicts: local arms all ~1.000s, **`bench-on-host` ~1.9s**
- killed by: `bench-on-host` landing on 1.000s

**H2, the recipe.** Wallclock stamping stretches the timeline wherever it runs, and the host has
nothing to do with it.

- predicts: **both `bench` arms ~1.9s**, `probe` and `bench-nostamp` 1.000s
- killed by: the local `bench` arm landing on 1.000s

**H3, the sitting.** Nothing here reproduces it, and the 1.917s belongs to whatever else was running
on the laptop during that broadcast.

- predicts: **all four arms 1.000s**
- killed by: any arm stretching

⛔ H3 is the outcome that would leave #76's headline correction wrong in both halves, and it is the
one to be most careful about wanting: it is also the outcome that follows from doing nothing.

## What no arm here can settle

Nothing measures whether the uploader's `on_hls` webhook backpressures SRS, because no arm has an
uploader behind it. That is deliberate, since an arm with one would spend, but it means a result of
"all four arms 1.000s" leaves the webhook standing as the next candidate rather than clearing it.
