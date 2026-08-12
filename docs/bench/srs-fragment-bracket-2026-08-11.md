# ✅ #76: SRS does not double. ⛔ "Our deployment does" is WITHDRAWN

> ⛔⛔ **The title's second sentence was wrong and `segment-stretch-2026-08-12.md` replaces it.** The
> bracket below stands: every arm lands on its knob, min equal to max. What does not stand is the
> conclusion drawn by comparing it against a live broadcast, because **every arm here runs on one
> machine over loopback and the deployment publishes across the internet.** Move only the media engine
> onto the deployment host, keeping this same encoder on this same laptop, and the segments stretch to
> 2.4s while the bytes per segment stay put. It is the publish path, not the host and not SRS.
>
> ⛔ A local reproduction of a distributed system's fault is not a control. It is a different
> experiment, and here it produced a confident answer to a question nobody had asked.



**2026-08-11 evening. Cost: zero.** Stock `ossrs/srs:6` in local Docker with a minimal config, ffmpeg
publishing `testsrc2`, segment durations read as `#EXTINF` off a mounted directory. No bee, no
uploader, no postage, nothing on the manager host.

## The bracket

Encoder settings copied from `e2e/src/bench/wallclockPublisher.ts`. 1920x1080, 30fps, 6000 kbps,
`-sc_threshold 0`, `-tune zerolatency`, 60s per arm.

| `hls_fragment` | GOP | segments | **median** | **ratio** | min-max |
| ---: | ---: | ---: | ---: | ---: | --- |
| 2.0 (control) | 2.0 | 30 | **2.000s** | 1.00 | 2.000-2.000 |
| 0.9 | 0.9 | 67 | **0.900s** | 1.00 | 0.900-0.900 |
| **1.0** | **1.0** | **60** | **1.000s** | **1.00** | 1.000-1.000 |
| 1.1 | 1.1 | 55 | **1.100s** | 1.00 | 1.100-1.100 |
| **1.0** | **0.5** | 60 | **1.000s** | 1.00 | 1.000-1.000 |
| 0.5 | 0.5 | 120 | **0.500s** | 1.00 | 0.500-0.500 |

⭐ **Every arm lands exactly on the knob**, and min equals max on every one. The control reproduces the
historical fragment-2.0 result exactly, which is what makes the rest worth reading.

⭐ **The fifth arm breaks a confound every previous run carried.** Until now GOP was always set equal
to the fragment, so "is it 1.0" and "is it GOP equals fragment" moved together. With GOP at half the
fragment the answer is still 1.000s, exactly as `srs_app_hls.cpp:550` says it should be.

## ⭐⭐⭐ So the doubling is ours, not SRS's

| | segment bytes | duration | delivered |
| --- | ---: | ---: | ---: |
| **local, stock SRS** | **775 KB** | **1.000s** | **6.35 Mbps** |
| **the deployment, same knobs** | **801 KB** | **1.905s** | **3.44 Mbps** |

The deployment's 629 uploads over 1,205s are **evenly spaced**: median interval 1.905s, p90 2.261s,
maximum 2.5s, and **no gap over 3 seconds**. So this is a steady cadence for twenty minutes, not a
parsing artefact and not a stall.

⭐⭐ **The bytes per segment agree within 3% while the duration differs by 1.9x.** That is the shape of
one 30-frame GOP taking twice as long in wall-clock, not of a different segmentation decision.

## ⚠️ The hypothesis, and why it is NOT a finding

The fit is tight: bytes within 3%, duration ratio 1.905, bitrate ratio 1.85. An encoder running at
about half rate would produce exactly this, because `-g` counts **frames**, not seconds, so a 30-frame
GOP spans 1.9s of wall-clock at 15.7fps while still carrying a GOP's worth of bits.

⛔ **I could not reproduce it by construction, so it stays a hypothesis.** Three attempts to starve the
encoder locally all failed to starve it: `veryslow` gave 775 KB / 1.000s, and `veryslow` pinned to a
single thread gave 776 KB / 1.000s with 60.0s of media in 60s of wall clock. This machine keeps up
through everything, so the positive control tested nothing.

**The decisive test is on the deployment host, not here**: run this same harness there, or read the
encoder's achieved frame rate during a publish. Both are free.

## ⭐ What holds regardless of the mechanism

**The deployment delivered 3.44 Mbps when 6000 kbps was requested**, about 55%. Local, identical
settings, delivers 6.35. So **"1080p / 6000k" as measured on that host is really a ~3.4 Mbps stream**,
and every figure taken there at that profile describes the smaller one.

## ⛔ What this corrects, including one of my own corrections

This morning I recorded that `HLS_FRAGMENT=1.0` "publishes 1.917s segments" and treated it as the
knob failing to mean what it says. **The measurement was right and the attribution was wrong.** The
deployment really does emit a segment every 1.905s. SRS is not the reason.

⚠️ Two figures downstream of that need re-examination rather than inheriting the old story:

- The **cost model's BZZ/min correction** was justified by the same 1.917s. It stands for that host,
  because the host really did publish at that rate, but the reason changes.
- Tonight's concurrency write-up puts the shipping profile's requirement at **411 KB/s**, which is
  correct for the stream that host produced. Against a **full-rate** 1080p/6000k stream the
  requirement is ~775 KB/s, and the browser node's headroom is about **1.4x rather than 2.76x**.

⭐ The generalisable part is in `swarm-hls-gate-lesson` AGT and it survives unchanged: check the
byte-level input. What is new is that **a correct measurement can still carry a wrong cause**, and the
cause is the part that propagates.
