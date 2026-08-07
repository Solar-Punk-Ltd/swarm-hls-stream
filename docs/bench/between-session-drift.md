# The same settings measure 1.05s apart on different nights

**2026-08-05. Six ten-minute-class runs of one configuration, 720p 2500kbps at a 2.0s GOP, three
yesterday afternoon and three tonight. Nothing about the deployment was changed between the two
groups except a postage batch, and that turns out not to be the cause.**

|             run | postage batch | capture to fetchable, median |    p95 | feedPropagation |  fetch |
| --------------: | ------------- | ---------------------------: | -----: | --------------: | -----: |
|  2026-08-04 14:41 | depth 22, old |                    **4.84s** | 6.11s |          1542ms |  448ms |
|  2026-08-04 14:52 | depth 22, old |                    **4.95s** | 6.16s |          1590ms |  452ms |
|  2026-08-04 15:02 | depth 22, old |                    **4.85s** | 6.05s |          1397ms |  701ms |
| 2026-08-05 02:07 | depth 23, new |                    **3.79s** | 5.00s |           924ms |  262ms |
| 2026-08-05 02:19 | depth 23, new |                    **3.81s** | 4.95s |           678ms |  290ms |
| **2026-08-05 02:32** | **depth 22, old** |                **3.88s** | 5.03s |           971ms |  217ms |

Within a session the runs agree to about 0.1s. Between sessions they differ by **1.05s**, which is ten
times the within-session spread.

## It is not the postage batch

The last row is the control: the old batch, redeployed onto the same stack, run the same night. **It
lands with tonight, not with the batch it shares.** So swapping depth 22 for depth 23, or a 78%-full
mutable batch for an empty immutable one, is not what moved the figure.

## It is not the publisher, the encoder or the uploader

The hop split places the whole change on one side.

| hop                     | yesterday |  tonight | moved |
| ----------------------- | --------: | -------: | ----- |
| segment (encoder)       |     1966-2000ms | 1966-2000ms | no |
| upload (uploader to bee) |      478-488ms |  474-500ms | no |
| manifestPublish         |      286-319ms |  232-239ms | a little |
| **feedPropagation**     | **1397-1590ms** | **678-971ms** | **yes** |
| **fetch** (segment bytes) |  **448-701ms** | **217-290ms** | **yes** |

`segment` and `upload` are identical to within a few milliseconds across all six runs, so the pipeline
produced the same work at the same rate both nights. The two hops that moved are the two where Swarm
delivers to a reader.

## What is left

Network conditions, most likely the hour. Both hops that moved depend on peers we do not run, and
Swarm is a public network whose load and peer availability vary.

Container age is not fully excluded, since every run tonight followed a redeploy. It is weakly
disfavoured: yesterday's three ran back to back on one container and showed no trend across them
(4.84, 4.95, 4.85).

Two sessions is not a diurnal curve, and this document does not claim one. What it claims is the thing
that matters for method: **a 1.05s shift occurred between two measurement sessions on identical
settings, and nothing in our stack explains it.**

## Why that is the important part

**It is bigger than most of the differences a profile sweep is trying to detect.** The retired grid
separated its best rows by about 1.2s. A sweep that measures configuration A in the afternoon and
configuration B at night would report this drift as the difference between them, and the report would
look exactly like a result.

So the sweep design changes:

1. **Interleave rather than block.** Run A, B, C, A, B, C rather than A, A, A, B, B, B, so that any
   drift lands on every configuration equally instead of being confounded with one of them.
2. **Carry a reference configuration through every block** and report each row relative to the
   reference measured beside it, not against a number from another session.
3. **Never compare a row against a run from a different sitting**, however carefully the settings were
   matched.

It also explains part of an old observation. `bench-network-floor` recorded scatter of 7125ms per
minute and concluded that repeats per setting were needed. Repeats within a sitting do not address
this, because the drift is between sittings and a repeat inherits it.
