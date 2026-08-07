# Does a feed slot ever stay unserved

**2026-08-05. The trigger for task #71, measured rather than argued.**

`ManifestFetcher.handleFollowupFetch` pins its index, asks for the next slot, and on a 404 polls that
same slot again without advancing. After `UNSERVED_SLOT_POLL_LIMIT = 30` polls the UI shows
`FEED_STATE_STALLED` and nothing further happens. The only path that re-anchors the reader is
`restartStream`, which fires on a manifest **parsing** error, and a stuck feed produces none: the
fetcher keeps returning the last manifest, which parses fine. So the recovery that exists is not
reachable from the failure that needs it.

**That parks a viewer only if a slot is unserved forever.** A slot missing for a while costs a delay
and a stalled badge, and the viewer recovers when it appears. So the question is narrow and empirical,
and the task said to settle it before touching the player, because the one time this project changed
that file from reading rather than measuring the change was wrong and was reverted (`a4f9841` →
`303184c`).

## The scan

Probe: [`feed-hole-scan.mjs`](../../e2e/src/probes/feed-hole-scan.mjs). Every slot of the newest
finished broadcast, read by explicit address, with up to three passes over anything that failed so a
transient miss is told apart from a permanent one. Costs no broadcast and no postage.

| | |
| --- | ---: |
| slots scanned | **692** |
| answered on the first pass | **692** |
| transient holes, missing once then answered | **0** |
| **permanent holes** | **0** |
| first-pass read time | 1ms min, **4ms median**, 126ms max |

**No hole of either kind.** The trigger for #71 did not occur once in a 692-slot broadcast read back
immediately after it finished.

## What this does and does not settle

**Settled: there is nothing here that can park a viewer.** The defect is reachable by reading the code
and its precondition was not met.

**Not settled: the live edge.** This reads a feed whose chunks have had a few minutes to settle. A
viewer meets slots the instant they are written, and a just-written chunk is measurably slower to
retrieve: the same sweep's collection loop spent roughly 260ms per slot read while riding the edge,
against the 4ms median here. That is a delay rather than a hole, and no run in the sweep showed a
reader failing to advance, but it is a different condition from the one measured above.

**So #71 keeps its severity in principle and loses it in practice.** The fix is cheap and worth doing
when the player is next opened, and it is not urgent, and it must not be done on reading alone.
