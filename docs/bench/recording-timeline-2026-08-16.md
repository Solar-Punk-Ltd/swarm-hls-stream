# What sets a gateway-less viewer's main-thread cost, measured for no BZZ

**2026-08-16, fourteen arms of four minutes against recordings that already exist on Swarm.** Driver
`deploy/scripts/recording-timeline-arms.sh`, artefacts at
`/home/solarpunk/recording-timeline/sweep2-20260816-155526`.

**Cost: nothing.** Read off both nodes' own counters, bracketing every arm.

| | |
| --- | ---: |
| uploader spent | **0.0000 BZZ** |
| gateway spent | **0.0000 BZZ** |
| gateway retrieval requests | **0** |
| postage batch `7849851f` | **369 → 369 of 512 buckets, unchanged** |

## The question this answers

`gateway-less-live-2026-08-16.md` measured the native viewer's main thread rising **0.435 to 0.746**
with the broadcast's age at join, then withdrew the mechanism it had offered, because within an arm
the cost does not move at all. What sets the level at join was left open.

The obvious next move was a longer broadcast. The postage batch allows **2.3 more broadcast hours**,
which would have extended the range from 88 minutes to about 130, and cost roughly 1.6 BZZ.

⭐ **The question is about what the player lands on, not about fresh content.** Three recordings
already on Swarm share one profile, **0.5s GOP at 1280x720 and 2500 kbps**, and carry timelines of
**62, 100 and 190 minutes**. No publisher, no encoder, no upload, so no postage, and weeb-3's own
page asks a gateway for nothing, so no node spends either. See [[cheap-measurement-method]].

⭐ **The profile is verified per arm from its own artefact**, not taken from the sitting logs that
produced the recordings: every arm reports `1280x720` with 0.5s segments of 0.172 to 0.174 MB.
⚠️ The timelines are read the same way, off `seekableEnd`. A sitting log names the broadcast that was
**planned**, which is longer than what the publisher left behind: 125 planned against 100 recorded on
one of these.

## The two factors

| | |
| --- | --- |
| ⭐ **playhead position** | four arms inside ONE recording at `WEEB3_NATIVE_START_S` of 0, 1800, 3600 and 5000. Timeline length, content, encoder, profile and network all held fixed. This is the clean contrast. |
| ⚠️ **timeline length** | three recordings at one profile, playhead at the start. Content and publication day move with the length, so this is the weaker line. |

Arms ran in a counterbalanced order and its reverse, so position in the sweep cannot stand in for
either factor.

## ⛔⛔ What a recording arm is NOT

**There is no live edge here, and no timeline rebase.** A recording lets the player fetch ahead, and
it did: segment throughput opens at **7.15 Mbps** for the first sixty seconds and settles to
**2.76 Mbps**, which is realtime for this stream. Nothing here reproduces Result 2, and no figure
below may be quoted as a live-edge figure.

⭐ **The throughput column is what says two arms did comparable work**, and it is read from the
request log rather than from the run's own `segments` tally. That tally is weeb-3's log panel and
says so in its own documentation: it reads about 24 whatever the arm length. One arm here logged
**24** while its request log carried **671** segment fetches.

⚠️ Every byte the page fetched came from `lat-murmeldjur.github.io`, including the segments, because
weeb-3 serves `hls/bytes/<reference>` from a service worker backed by the node in the tab. That is
what makes the gateway-less gate readable by host, and it is why the gateway's own zero is the
evidence rather than the browser's request log alone.

## Result 1: ⭐⭐⭐ THE SAME BYTES PER SECOND, AND UP TO THREE TIMES THE THREAD

The live sitting's four native arms and this sweep's recording arms are the same page, the same
browser image, the same host, the same stream profile and the same day. Segment throughput is read
the same way from both request logs, as the median of 30-second buckets.

| | joined at | **steady Mbps** | fetches | **main thread** |
| --- | ---: | ---: | ---: | ---: |
| **live** arm 1 | 86s | **3.10** | 1,439 | 0.398 |
| **live** arm 3 | 1,556s | **2.77** | 1,437 | 0.676 |
| **live** arm 6 | 3,789s | **2.77** | 1,510 | 0.717 |
| **live** arm 8 | 5,313s | **2.77** | 1,508 | 0.768 |
| **recording**, 100 min timeline | — | **2.77** | 671 | **0.249** |
| **recording**, 62 min timeline | — | **2.81** | 671 | **0.248** |

⛔⛔⛔ **Throughput is identical and the thread is not.** A gateway-less viewer pulling 2.77 Mbps from
a recording costs **0.25 of one thread**. The same viewer pulling **the same 2.77 Mbps** from a live
broadcast costs 0.68 to 0.77.

⭐ **And the live climb is not throughput either.** Across live arms 3, 6 and 8 the byte rate is
2.77 Mbps to three significant figures while the thread goes 0.676 → 0.717 → 0.768. The one arm that
pulled *more* data, arm 1 at 3.10 Mbps, has the *lowest* thread of the four.

So the main-thread cost this project has been tracking is **not retrieval volume, and not timeline
length**. Both are now measured and neither moves it.

### ⭐⭐⭐ And being live costs more than nearly tripling the bitrate

The sweep also carries a 1080p recording, which is the same page reading **2.62x the bytes**.

| | steady Mbps | main thread | against 720p recording |
| --- | ---: | ---: | ---: |
| 720p recording | 2.77 | 0.253 | — |
| **1080p recording** | **7.25** | **0.450** | 2.62x the bytes, **1.78x** the thread |
| **720p live** | **2.77** | **0.768** | **1.00x** the bytes, **3.03x** the thread |

⭐ **Bytes do cost thread, and they cost it sub-linearly**, which independently reproduces
`1080p-main-thread-2026-08-15`.

⛔⛔⛔ **But being live costs more than that, for no extra bytes at all.** A gateway-less viewer on a
1080p recording pulling 7.25 Mbps is **cheaper** than the same viewer on a 720p live broadcast
pulling 2.77. Whatever live playback is doing, it is a larger effect than the quality ladder.

## Result 2: ⭐⭐⭐ TIMELINE LENGTH IS A NULL OVER A 3.05x RANGE

Three recordings, one profile, playhead at the start, steady thread from the last three windows.

| recording | **timeline** | steady thread | Mbps |
| --- | ---: | ---: | ---: |
| `34b57c4a` | 3,738s | **0.248, 0.249** | 2.81, 2.77 |
| `be608ecf` | 5,980s | **0.249, 0.253** | 2.77, 2.77 |
| `05abe325` | **11,410s** | **0.251, 0.250** | 2.79, 2.81 |

**A 3.05-fold range in timeline length, and every reading lands between 0.248 and 0.253.** The
withdrawn mechanism in `gateway-less-live-2026-08-16.md` required this column to rise. It does not
move at all.

## Result 3: ⭐⭐ PLAYHEAD POSITION IS A NULL TOO

One recording, 5,980s of timeline, only `WEEB3_NATIVE_START_S` moving. Content, encoder, profile and
network are identical across these four.

| asked | **landed** | steady thread | Mbps |
| ---: | ---: | ---: | ---: |
| 0 | **1** | 0.249, 0.253 | 2.77, 2.77 |
| 1,800 | **1,801** | 0.258, 0.227 | 2.76, 2.76 |
| 3,600 | **3,601** | 0.247, 0.236 | 2.76, 2.77 |
| 5,000 | **5,001** | 0.232, 0.245 | 2.77, 2.77 |

⭐ **The `landed` column is the check that this factor varied at all**, and it did: weeb-3 honoured
every seek to within a second. A flat thread column here means position does not matter, not that
position was never tested.

⚠️ **Seeked arms are noisier and two of them open high**, at1800 running 0.390 → 0.258 and 0.342 →
0.227 across its own window, and at5000 similarly. at3600 and at0 do not. **The transient replicates
but it is not monotonic in seek distance and this sweep does not explain it.** The steady windows
agree regardless.

## Result 4: bytes cost thread, and the live premium is larger

| | Mbps | steady thread |
| --- | ---: | ---: |
| 720p recording | 2.77 | 0.249, 0.253 |
| 1080p recording | 7.25 | 0.450 |
| 1080p recording | **8.80** | **0.513** |
| **720p LIVE** | **2.77** | **0.768** |

⛔⛔⛔ **A 1080p recording pulling 8.80 Mbps, 3.2 times the bytes, still costs a third less than a
720p live broadcast pulling 2.77.** Retrieval volume is a real cost and it is the smaller one.

⚠️ Two 1080p arms is two points. They are reported because the direction is unambiguous, not because
a slope has been fitted to them.

## ⛔⛔ What else was running on the box, and why it does not rescue the live figures

**The comparison in Result 1 crosses two sittings, so co-tenancy is not controlled by anything in
the design.** A bracket controls for drift over time and never for the neighbours, who are in every
arm including the controls. So it is read directly.

| | live sitting, 09:50-11:45Z | this sweep, from 15:55Z |
| --- | --- | --- |
| `loadlab-manager-host-srs-1` | **zero log lines** | **2,302 lines** |
| `loadlab-manager-host-stream-uploader-1` | **zero log lines** | **2,488 lines** |
| host load, 1-minute, per arm | 8.54, 15.36, 15.90, 9.18 | 14.12, 6.23, 7.43, 8.52 |

⭐ **The loud neighbour was broadcasting during THIS sweep and idle during the live one.** That is a
real difference between the two sittings and it runs **against** the result: a busier box should
raise these thread readings, and they came in three times lower anyway. Result 1 is therefore a
conservative bound on the gap, not a flattering one.

⭐ **Load is also controlled inside this sweep.** It ranges 6.23 to 14.12 across arms whose thread
column does not move, which independently reproduces `host-load-is-not-the-creep-2026-08-15`
(dU/dLoad = +0.00000 ± 0.00036 over a 4.7 to 56.1 range).

⚠️ **What is still not controlled** is everything else that differs between 10:00Z and 16:00Z on a
shared box carrying forty other bee nodes. The two sittings are four hours apart and nothing here
brackets that.

## What is now open

⛔ **What live playback does that recorded playback does not** is unresolved, and this sweep cannot
separate the two candidates, because a recording has neither of them:

1. **chasing a moving edge**, where the player repeatedly reaches for a segment that does not exist
   yet, and
2. **the timeline rebase** of Result 2 in `gateway-less-live-2026-08-16.md`.

⛔ Separating them needs a live broadcast in which the rebase does not fire, and our live window is
fixed at one bee chunk, so we cannot produce one. That makes it upstream work again, filed as
`lat-murmeldjur/weeb-3#2`.
