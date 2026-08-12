# The reference beats its bytes by about 100ms. What, if anything, to do

Written 2026-08-12 straight after `gop-floor-replicate-2026-08-12.md` measured the window. No
broadcast needed to reach any of this.

## What the code does, in order

`uploadSegment` (`StreamUploader.ts:174`) runs inside `segmentQueue`, a `PQueue` at **concurrency 1**:

1. `uploadDataToBee(data)` with **`deferred: true`**. bee acks from its own local store and push-syncs
   in the background, so this returns before the bytes are retrievable anywhere else.
2. `manifestManager.addSegment(index, duration, ref, ...)`.
3. the manifest slot is written as a SOC with **`deferred: false`**, which blocks on push-sync.

So the segment gets a head start equal to however long step 3 takes, measured at about **300ms in
steady state** by the LAT-10 work that made step 3 synchronous. The measured refusal window is about
**100ms**, which is consistent: usually the segment finishes first, sometimes it does not.

## The three options, and the one I would take

### A. Make the segment write synchronous too

One flag. It closes the race completely: nothing could name a segment before its bytes were synced.

⛔ **Not obviously affordable, and I will not guess.** The queue is concurrency 1 and a 0.5s GOP gives
it a **500ms budget per segment**. A segment is roughly 200 KB against a manifest SOC of a few KB, so
its push-sync is the slower of the two and 300ms is the wrong number to reason from. If it exceeds
500ms the queue backs up without bound, `queuedSeconds` climbs and the existing pressure alarm fires.
That is a worse failure than the one being fixed.

⚠️ The comment on `uploadDataAsSoc` records that deferring was originally justified by an **~80s block
behind the segment backlog**, and that this turned out to be a post-restart condition rather than
steady state. The same might or might not hold for segments. It is measurable and has not been
measured.

### B. Confirm retrievability before publishing the slot

Keep the segment deferred, and gate step 3 on the bytes actually answering.

⛔ Costs a round trip on the viewer's critical path to save a race a viewer already survives, and
moves latency from a case that happens sometimes into every segment. Worse trade than A.

### C. ⭐ Accept it in the product, and fix the instrument

**The product is very likely already correct.** The window is ~100ms, every refusal in the sitting
resolved, and hls.js retries a refused fragment as a matter of course. `shipping-profile-sustains`
measured 0.9996 with zero stalls at this profile. Nothing a viewer does is known to be harmed by it.

What is wrong is the **bench**, which discards a refused segment and files it under `discarded`
alongside genuinely unreadable ones. That single column conflates:

- **the network could not serve this**, which is a product defect, and
- **we asked about 100ms early**, which is a viewer non-event.

Every "N% unreadable" figure this project has published at a small GOP is mostly the second. That is
how a 100ms race came to be written up as _"a viewer at the live edge cannot retrieve one segment in
five"_.

## Recommendation

**Take C now and keep A as an open question with a price.**

C is free, it is where the actual error was, and the machinery already exists: `UnservedSegmentWatch`
resolves refusals off the loop, so a report can say **"refused then served in 0.10s"** instead of
counting the segment as lost. The axis guard's `UNREADABLE-HIGH` note should not fire on refusals the
watcher resolved.

A stays open because it is the only thing that would make the race impossible rather than brief, and
because whether it fits inside a 500ms budget is a fact nobody here has. Measuring it needs a
broadcast with the flag flipped and the queue depth watched, and is worth roughly **0.45 BZZ** for
three arms against three controls.

⛔ **Nothing here is a reason to move the 0.5s GOP recommendation.** That rests on stalls and latency
against 2.0, and on #155 making sub-0.5 unreachable from shipped config.
