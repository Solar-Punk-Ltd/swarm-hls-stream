# The encoder never missed its GOP

**2026-08-05. Task #76, which was filed twice with the wrong cause both times.**

It was first filed as a 1080p limit: at 6000kbps the encoder was read as falling behind real time.
Then the sweep of 2026-08-05 hit the same signature at 720p 2500kbps, in two of six runs, at both
segment lengths, so the filing was widened to "the encoder misses its GOP in about one run in three
and it is not a 1080p limit".

It is not the encoder and it is not a GOP. **The publisher was rate-limited by whatever was consuming
its output, and the recipe converts that into stretched media time with nothing reported anywhere.**

## What the six runs actually say

`videoPacketCount` per segment is not approximately right. It is **exactly** the frames one requested
GOP holds, in every run, good and bad alike:

| run   | requested GOP | packets/segment | media span | **delivered fps** |
| ----- | ------------: | --------------: | ---------: | ----------------: |
| 08-42 |          0.5s |        **15.0** |     0.533s |              28.1 |
| 08-45 |         0.25s |         **8.0** |     0.666s |          **12.0** |
| 08-48 |         0.25s |         **8.0** |     0.266s |              30.1 |
| 08-52 |          0.5s |        **15.0** |     0.500s |              30.0 |
| 08-55 |          0.5s |        **15.0** |     0.633s |          **23.7** |
| 08-59 |         0.25s |         **8.0** |     0.266s |              30.1 |

`-g` is set in **frames** (`gopFrames` is `fps * gopSeconds`), and it is honoured perfectly every
time. What moves is the frame rate, and the segment length follows from it. A run at 12fps produces
its 8 frames in 0.666s, so the segment is 0.666s long, and the encoder did exactly what it was told.

**The rate is flat.** Median delivered fps per decile of run 08-45: 12, 12, 12, 12, 12, 13, 12, 12,
12, 12. Not degradation, not a warm-up, not thermal. It is decided at spawn and held for three
minutes. That rules out contention building up, and it ruled out a container CPU quota too, since
`bench-on-host.sh` sets no `--cpus` and no `--cpuset`.

## The mechanism, reproduced

`wallclockEncodeArgs` stamps timestamps at the demuxer with `-use_wallclock_as_timestamps` and paces
inside the filter graph with `realtime`. So when anything downstream of the muxer blocks, the demuxer
stops pulling, **no frames are stamped while it is blocked, and the wall clock keeps running**. Media
time stretches to match the consumer rather than the source. No frame is dropped, no timestamp is
wrong, and nothing warns.

Fed to a pipe read at a fixed byte rate, with no engine, no SRT, no Swarm and no postage:

| consumer    | frames | media span | **delivered fps** | vs requested |
| ----------- | -----: | ---------: | ----------------: | -----------: |
| unthrottled |    597 |    19.867s |          **30.0** |         1.00 |
| 400 kB/s    |    589 |    19.800s |              29.7 |         0.99 |
| 250 kB/s    |    392 |    19.767s |          **19.8** |         0.66 |
| 150 kB/s    |    239 |    19.433s |          **12.2** |         0.41 |

**12.2fps against a run that measured 12.0.** The knee sits at the stream's own bitrate: 2500kbps is
about 312kB/s, and 400kB/s is unaffected while 250kB/s is not.

That also unifies the two filings. The demand scales with **bitrate**, not with picture size, so
1080p at 6000kbps needs 750kB/s and meets the limit far more often. Resolution was never the variable.

## What this does and does not settle

**Settled: the mechanism, and that the encoder is not at fault.** A consumer slower than the stream's
bitrate stretches media time under this recipe, silently, and the numbers match what the runs showed.

**Not settled: which consumer.** In a real run the muxer feeds SRT to SRS, and nothing here identifies
what was slow or why it was slow in two runs of six and not the other four. The reports carry no
segment byte size, so the throttle cannot be read out of the runs already taken. **Recording segment
bytes would make it directly visible in the next sweep**, and that is the cheapest next step.

**Not settled: whether a real broadcaster hits it.** This is our publish recipe. Another encoder under
the same network limit may drop frames instead, which is a different and louder failure.

## What changed as a result

`check-axis.py` used to report this as `segments are being cut mid-GOP`, which sends a reader straight
to the encoder. The check itself was fine, since `packets < span * fps` and `delivered fps < fps` are
one inequality rearranged, but the cause it named was wrong.

The discriminator is whether the segment holds a **whole** GOP. Under a throttle it does and the span
is stretched. When the segmenter cuts mid-GOP it does not. Both are still caught, they now say which
happened, and the delivered frame rate is printed on passing runs too, so run 08-42 at 28.1fps reads
as mildly throttled instead of silently passing.
