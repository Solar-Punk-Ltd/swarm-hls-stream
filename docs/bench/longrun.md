# Does a setting hold still? The first broadcasts longer than a minute

Measured 2026-08-03 on `manager-host`, profile `latbench`, engine SRS. Seven continuous broadcasts of 5
to 20 minutes, produced by `pnpm bench:longrun`, against `profiles.md`'s 86 runs of about 50 seconds
each.

`profiles.md` answers "how fast does a viewer see the opening of a broadcast". This answers "does it
stay that way", which is a different question and the one an operator picking a setting actually has.

## The short answer

**The latency holds still. The feed does not, and by the end of the day the reason was our own
gateway node rather than anything this repository writes.**

Nothing degrades with elapsed time: the fitted latency slope stays inside its own residual on every
run, and the buffer a player needs does not grow between the first third of a run and the last. That
was the failure mode this bench was built to look for, and it is not there.

What is there instead is worse, and no short run could have seen it: **the feed a player polls stops
naming new segments for 30 to 48 seconds at a time, on a 63 second cycle, for 42% to 70% of a
broadcast.** It is filed as LAT-10. A public Swarm gateway serves the same feed smoothly and up to 34
updates ahead of ours, so it is our reader and not Bee, the network, or the data.

## Run by run

| picture | segment | minutes | samples | capture to fetchable, median | fitted drift | resolvable? | buffer demand, first third to last |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 720p 2500k | 0.5s | 19.4 | 171 | **2.51s** | -58ms/min | no | 5.00s to 4.80s (**-0.21s**) |
| 720p 2500k | 0.5s | 7.7 | 55 | 2.63s | +133ms/min | no | 3.58s to 5.22s (+1.64s) |
| 720p 2500k | 2.0s | 8.0 | 69 | 5.90s | +20ms/min | no | 4.98s to 5.29s (+0.31s) |
| 720p 2500k | 2.0s | 4.7 | 40 | 5.76s | | | |
| 720p 2500k | 2.0s | 5.7 | 42 | 4.82s | | | |
| 720p 2500k | 1.0s | 6.0 | 51 | 3.17s | | | |
| **1080p 6000k** | 1.0s | 10.3 | 88 | **3.59s** | -6ms/min | no | 6.25s to 3.92s (**-2.33s**) |

The three rows with no drift columns are the publishes that carried the experiments below, the two at
2.0s for the two-node comparison and the one at 1.0s for the segment retrievability measurement. They
are kept because they are runs and reported without a slope because five or six minutes cannot
support one.

**1080p holds still too.** Over 10.3 minutes its fitted slope is -6ms per minute, which predicts 0.06s
against a 0.84s residual, and its buffer demand falls rather than grows. Its median
capture-to-fetchable is 3.59s against 720p's 3.17s at the same segment length, so the picture costs
about 0.4s and nothing else. Its `mediaPacing` does show a **1.53s hole**, media the timeline crossed
that no segment carried, which is the 1080p publish-path contention `profiles.md` already records
rather than anything new.

There was an eighth, at 1080p 6000k and 0.5s for 2.1 minutes, which was the instrument's own first
smoke run. **Its artifact was deliberately not kept**: it reported a 48 second gap it had no way to
attribute, and `feedPolls`, the field that turns such a gap into a statement about whose it is, came
out of reading that report. Its latency figures were 2.55s median and a 2.76s to 4.39s buffer
demand, and they are quoted here rather than in the table because nothing in the directory backs them.

"Resolvable" is computed, not judged: the change the fitted line predicts across the run against
twice the root-mean-square spread of the samples around it. No run clears it, so every one of these
slopes is a line through scatter and none of them is a trend. The 20 minute 720p run and the 10 minute 1080p run are
the ones to read, because they are the only two long enough for a slope of any size to have cleared.

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
| 1080p 1.0s, 10 min | 0.9984 | 1.0010 | 1.53s |

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

| | 720p, 0.5s | 720p, 1.0s | 720p, 2.0s | **1080p, 1.0s** |
| --- | ---: | ---: | ---: | ---: |
| feed writes per second | 2 | 1 | 0.5 | 1 |
| freezes over 15s | 7 | 5 | 6 | 8 |
| **period between freezes** | **63-66s** | **48-80s** | **60-67s** | **49-109s** |
| freeze length, median | 47.4s | 36.8s | 33.3s | 33.0s |
| index jump on release | 96 | 30 to 51 | 17 | 32 to 49 |
| **frozen share of the broadcast** | **70%** | **55%** | **42%** | **50%** |

**Picture size barely moves it.** 1080p at 6000kbps against 720p at 2500kbps, same segment length, is
50% frozen against 55%, with the same freeze length and the same index jumps. Two and a half times the
bytes changes nothing, which is what the SOC finding below predicts: the announcement is one small
chunk whatever the video is.

The period is the same across a fourfold range of write rate, so the cycle is driven by elapsed time.
What the write rate changes is how far the reader falls behind while frozen, and 96 against 30 against
17 tracks the rate. **No operating profile escapes this.**

### It is not the lookup, it is retrievability at the reading node

Both bee nodes polled for the same feed, on the same host, in one loop, during a live publish:

| node | stalls over 15s | frozen | worst |
| --- | ---: | ---: | ---: |
| `bee-uploader`, which wrote the feed | 1 | 11% | 26s |
| `bee-gateway`, which is what a viewer polls | 4 | **64%** | 44s |

The gateway ran up to 21 updates behind the writer's node, which resolves the feed throughout.

**The obvious mitigation was tried, and it refuted the lookup explanation.** If the fault were the
"find latest" search, a client tracking its own position and asking for index N+1 explicitly would
walk past it. Measured against a live publish, the explicit read is blocked exactly as `latest` is:
both sat on index 14 for 32 seconds while the writer was far past it, `download({index: 15})`
returning 404 in 199ms throughout, and then 68 indices became readable in 18.9 seconds at 278ms each.
On a settled feed those same explicit reads take 270-500ms against 2955ms for `latest`, so the lookup
is slower and is not the freeze.

### And it is single-owner chunks specifically, not chunks in general

The segments themselves reach the gateway almost immediately. Each sampled segment's reference was
taken from the uploader's own `Segment N uploaded: <ref>` line and `/bytes/<ref>` polled on the
**gateway** node until it answered 200:

| | segments (ordinary content chunks) | feed updates (single-owner chunks) |
| --- | ---: | ---: |
| time from written to servable by the gateway | **0.8s mean, 3s worst** | **30 to 45s** |
| samples | 13 across 2.5 minutes, spanning two freeze cycles | 18 freezes across 20 minutes |

**A viewer's node holds essentially all of the video within seconds and cannot learn that it exists**,
because the only thing announcing it is a chunk that takes half a minute to arrive. That is much
narrower than "chunk retrieval is slow", and it is what to report upstream: ordinary chunks are fine
on the same pair of nodes, in the same windows, at the same time.

It also reopens one design lead, stated as a lead and not a recommendation: anything that carried
segment references to a viewer by a route other than the SOC feed would restore liveness, because the
bytes are already there.

**So: a feed update is not retrievable from the gateway node for 30 to 45 seconds after it is
written, and then a batch becomes retrievable at once.** Both nodes run bee 2.8.1 on one host in one
compose project with identical topology (134 peers, depth 9, reachability Private), so it is not
connectivity between them. The writer serves the update immediately because it holds it. The question
is chunk push and retrieval, not feed resolution, and this kills the one mitigation this repository
could have shipped on its own.

### Probable root cause: our own gateway node cannot pay for bandwidth

A public Swarm gateway was polled for the **same live feed in the same loop** as ours:

| reader | frozen, 251s window | shape |
| --- | ---: | --- |
| `latbench-bee-gateway-1`, on the writer's own host | **66%** | plateaus at index 30, 93, 157, 220: gaps of **63, 64, 63** updates at one per second |
| a public Swarm gateway, across the internet | 22% | no plateau structure, and it ran up to **34 updates ahead of ours** |

So the chunks are in the network promptly and retrievable by a stranger, and it is our reader that
cannot get them. That rules out Bee in general, the network, and everything this repository writes.

**What is different about that node.** It runs `--swap-enable=false` and `--cache-capacity=0`, has no
chequebook at all (`/chequebook/balance` answers `405 chain disabled`), and accounts 218 peers whose
largest debts cluster uniformly at **-9.70M to -9.86M**, just under a round ten million. The uploader
node runs `--swap-enable=true` with a funded chequebook and does not do this.

**The hypothesis, stated as one:** a node that cannot pay for bandwidth may consume only the free
allowance, which refreshes on a timer, so it downloads in bursts and is throttled in between. That
predicts what was measured, including a period independent of write rate and of picture size.

**Two things follow.** The test is to enable swap on the gateway and fund it, which is on-chain. The
mitigation already exists: `CLIENT_BEE_GATEWAY_HOST` points viewers at another gateway.

### The mitigation measured through the product, which is real and not free

The same bench, same publisher, same setting, pointed at each gateway in turn:

| | our gateway | a public Swarm gateway |
| --- | ---: | ---: |
| distinct segments a viewer saw in ~6 min | 51 | **62** |
| capture to fetchable, median | **3.17s** | 3.94s |
| capture to fetchable, worst | **5.93s** | 30.73s |
| freezes over 15s | 5 | **2** |
| **frozen share of the broadcast** | **55%** | **12%** |
| index jump when a freeze released | 47, 35, 51, 30, 36 | **1, 17** |

**The last row is the one to read.** Ours releases a backlog of thirty to fifty updates, which is a
reader that fell behind and caught up. The public gateway advances one at a time, so it is keeping
pace and merely serving some individual reads slowly, which is what a long tail across the internet
looks like.

So pointing viewers elsewhere is a genuine mitigation, **55% frozen down to 12% and eleven more
segments delivered in the same six minutes**, and it is paid for with a worse tail (30.73s against
5.93s) and with the viewer path leaving infrastructure we control. Neither reader is good. The fix
is to fund ours.

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
- **Whether funding the gateway fixes LAT-10.** The hypothesis is testable by enabling swap on that
  node and funding it, which is on-chain and has not been done.
