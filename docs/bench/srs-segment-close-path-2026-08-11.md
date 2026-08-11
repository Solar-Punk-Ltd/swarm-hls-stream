# What SRS actually does when it closes a segment, read from the source

**#76.** Read against **SRS 6.0.184**, the version the container runs (`ossrs/srs:6`, confirmed with
`srs -v` on the running `latbench-srs-1`). Source from the `6.0release` branch.

This is a source read, not a measurement. It settles the mechanism and it does **not** settle the
anomaly. Both halves are stated separately on purpose, because the last two times this question came
up I supplied a mechanism where the honest answer was that I did not have one.

## The rule, with line numbers

**A segment is cut at the first keyframe at or after `hls_fragment x hls_td_ratio`.**

| fact | where |
| --- | --- |
| `max_td = fragment * get_hls_td_ratio(vhost)` | `srs_app_hls.cpp:360` |
| `hls_td_ratio` **defaults to 1.0**, and we never set it | `srs_app_config.cpp:7062-7066` |
| cut test is `current->duration() >= max_td + deviation` | `srs_app_hls.cpp:550` |
| `deviation` is zero unless `hls_ts_floor` is on, which we do not set | `srs_app_hls.cpp:546` |
| the cut also requires a keyframe, unless waiting is off | `srs_app_hls.cpp:1086-1090` |
| `hls_wait_keyframe` **defaults to true** | `srs_app_config.cpp:7291-7295` |

So with our configuration the threshold **is** `hls_fragment`, and the delivered duration is the first
keyframe at or after it.

## ⭐ This partly rehabilitates a mechanism I withdrew, and only partly

On 2026-08-11 I proposed that SRS cuts on the first keyframe at or after the fragment, then withdrew
the whole thing when 0.5, 2.0 and 4.0 all landed on the knob.

- **The cutting rule was right**, and it is sitting at `srs_app_hls.cpp:550` and `:1086`.
- **The inference was still wrong.** I went on to say that a GOP equal to the fragment is therefore
  pathological. It is not: three of the four arms have GOP equal to the fragment and land exactly on
  it.

⭐ The lesson survives intact and gets sharper. The withdrawal was correct on the evidence, and a
mechanism being real in the source is not the same as it explaining the observation you attached it to.

## Two things this rules out

**The absolute cut path was never in play.** `is_segment_absolutely_overflow()` fires at
`hls_aof_ratio * hls_fragment` (`srs_app_hls.cpp:569`) and is only tested on audio
(`srs_app_hls.cpp:1040`). We set `HLS_AOF_RATIO=10`, so it arms at **10x** the fragment and cannot
account for a 1.92x segment.

**The minimum-segment guard was never in play.** `SRS_HLS_SEGMENT_MIN_DURATION` is 100ms and the guard
tests against **2x** that (`srs_app_hls.cpp:41, 541`), so it only suppresses cuts below 200ms. Our
smallest configured fragment is 250ms.

**And the encoder introduces no rounding.** The bench publisher runs `fps: 30` and
`-g round(fps * gopSeconds)` (`e2e/src/bench/wallclockPublisher.ts:73-74, 149`), so GOPs of 0.5, 1.0,
2.0 and 4.0 are 15, 30, 60 and 120 frames: whole numbers of frames, exact keyframe intervals.

## ⛔ What the source does NOT explain

Every arm has GOP equal to fragment and a keyframe landing exactly on the threshold, so the rule above
predicts **all four land on the knob**. Three do. One does not:

| `HLS_FRAGMENT` | GOP frames | predicted | **observed median** |
| ---: | ---: | ---: | ---: |
| 0.5 | 15 | 0.5 | 0.50s |
| **1.0** | **30** | **1.0** | **1.90s** |
| 2.0 | 60 | 2.0 | 2.00s |
| 4.0 | 120 | 4.0 | 4.00s |

⛔ **I am not proposing a fourth mechanism.** Everything left is a boundary-comparison story, and every
boundary story predicts the same failure at 0.5 and 2.0, which did not happen.

## ⭐⭐ The decisive test is free, and that is the finding to act on

**The cost of this question was never SRS. It was the uploader.** BZZ is spent putting segments on
Swarm, and this question is answered entirely inside SRS: publish, then read `#EXTINF` out of the
m3u8. **No bee, no uploader, no postage, no BZZ.** Docker runs on the workstation, so it needs nothing
from the manager host either.

The arm that discriminates is a **bracket around 1.0**, which no run so far has done:

| `HLS_FRAGMENT` | GOP | why |
| ---: | ---: | --- |
| 0.9 | 0.9 | is the doubling a property of 1.0 specifically, or of a neighbourhood? |
| **1.0** | **1.0** | the replicate, which the anomaly has never had |
| 1.1 | 1.1 | the other side of the bracket |
| 1.0 | 0.5 | separates "fragment is 1.0" from "GOP equals fragment" |

⭐ That last row is the one that matters most: every arm to date confounds the two, because GOP was
always set equal to the fragment.
