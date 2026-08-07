# An engine that dies, and the broadcast that used to outlive it

**2026-08-06.** Task #86, fixed and verified live against a real SRS restart. Two runs.

## What was wrong

SRS does not send `on_unpublish` when it dies, so nothing told the uploader the broadcast was over.
The stream stayed in `activeStreams` **for the life of the process**:

- `/health` answered `degraded` with `segment_stall` forever
- the catalog entry stayed `live` for a broadcast that had ended
- no VOD was ever published, so the recording was lost
- a viewer's playlist never got its `#EXT-X-ENDLIST`, so polling never stopped

Detection was already correct and there was no way out of it but restarting the process by hand. It
was found by [running a crash scenario](./crash-at-a-viewer-2026-08-05.md) rather than by looking
for it.

## The fix, and where it already existed

The recovery path has had this control since the beginning. `scheduleRecoveryFinalize` gives a stream
rebuilt after a process restart one window to hear from its engine, and finalizes it as a VOD
otherwise. **The same control was simply missing for a stream that was live all along**, so the fix
reuses the finalize path rather than inventing one.

⭐ **Two of the three arming points matter, and the second is the one worth knowing.** A stream is
watched from where it becomes live and fed: `spawnUploader`, the recovery-resume branch of
`startStream`, and **`handleSegment`'s recovery-cancel branch**. That last one is the route
production actually takes out of recovery, because neither shipped engine re-announces a session that
stayed open across a crash. Arming only at spawn would have left **every stream that survived one
crash unprotected for the rest of its life**, which is the longest-lived case of the bug rather than
an edge of it.

## ⛔ The window is its own constant, and that was not the first design

`ORPHAN_REAP_MS`, 60s. The first version reused `recoveryTimeout` on the argument that one number
should govern "how long do we wait for an engine that might come back". **The repository's own tests
refuted it**: `RECOVERY_TIMEOUT_MS` is set to **80 milliseconds** in `StreamOrchestrator.test.ts`,
because it is tuned for how fast a restarted process gives up on streams it restored.

That is a live footgun, not a test artefact. An operator shortening `RECOVERY_TIMEOUT` for crisper
restarts would have started reaping live broadcasts over ordinary engine hiccups.

`SEGMENT_STALL_MS` is wrong for the opposite reason: it is a health **reporting** threshold at half
the size, and ending a broadcast on it would kill streams that recover. A twenty second write outage
has been [measured freezing a viewer and then resuming correctly](./two-more-faults-2026-08-06.md).

The floor to stay above is the longest silence a healthy broadcast can produce, which is the engine's
own retry window. Both shipped engines use 60s.

## What the runs showed

`docker restart latbench-srs-1` with the publisher stopped, so nothing re-announces. `/health` polled
every 5 seconds from the fault.

| t from the fault | status | activeStreams | reasons |
| ---: | --- | ---: | --- |
| 8s | ok | 1 | |
| 23s | ok | 1 | |
| **30s** | **degraded** | 1 | `segment_stall` |
| 54s | degraded | 1 | `segment_stall` |
| **63s** | **ok** | **0** | **reaped** |

**Before the fix the last two rows never arrived.** The stream sat at `degraded` / `segment_stall`
until the container was restarted.

Both runs fired at the window to within three milliseconds:

```
No segments for video/reap in 60003ms and no stop was ever sent; finalizing it as a VOD.
No segments for video/reap in 60002ms and no stop was ever sent; finalizing it as a VOD.
```

✅ **And the recording survives, which is the part that matters to a viewer.** The catalog entry was
updated to `state: vod` in both runs, carrying 27.10s and 26.86s of duration at SOC index 85 and 84.
A broadcast that used to be lost is now retrievable.

`swarm_hls_streams_reaped_total` counts these, separately from the finalize total, because every one
is an engine that died without unpublishing. A deployment where this is routine has a sick engine,
and that condition used to be invisible.

## ⚠️ What this narrows, deliberately

**SEC-28 is weaker than it was, and there is a test named for it.** A proven publish key held its
stream id against every unproven announce for as long as the process lived, because the incumbent
session lived that long. Now the incumbent's broadcast ends when its engine does, `retireSession`
drops the claim with it, and the id is free.

An id is worth holding while there is a live broadcast behind it, and after the reaper there is not:
the VOD is published and the session is over. The key holder is never locked out either way, since an
authenticated announce is allowed against any incumbent. **What an operator gives up is squatting
protection on an id whose broadcast has already ended, and what they get back is that the broadcast
ends at all.**

⚠️ Five takeover tests advanced the clock as loose headroom, well past any window they were about.
They now declare a reap window they never reach, so a test about authentication cannot fail because a
stream was finalized. The interaction itself is pinned on its own rather than configured away.

## What this does not say

**Two runs, one engine, one fault.** Both are the same trigger, a hard SRS restart. An engine that
dies in some other way, or one that half-dies and keeps its socket open, is untested.

**Nothing here watched a viewer.** The reaper publishes a closing manifest through the ordinary
finalize path, which is [what stops a viewer polling and shows them the broadcast has
ended](./a-broadcast-that-ends-2026-08-06.md), but no browser was watching during these runs. The
uploader side is verified and the viewer side is inferred from a path that was verified separately.

**The 60 second window is a choice, not a measurement.** It is above the engine retry windows this
project knows about. Nothing has counted how long a real engine hiccup lasts on this deployment.
