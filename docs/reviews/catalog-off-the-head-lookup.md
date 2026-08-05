# Taking the catalog off the head lookup

**2026-08-05, task #73. Read rather than measured, so every claim here is about what the code does and
none is about what it costs on this deployment. The measurement it needs is named at the end.**

The head lookup costs **1 second at minimum and about 5 on a thousand-slot feed**, against **4ms** for
the same chunk read by explicit address. See [`feed-head-scaling.md`](../bench/feed-head-scaling.md)
and the upstream report beside this file. The player was moved onto the explicit path already. The
catalog was not, and it is now the largest remaining consumer of the slow one.

## Three call sites, three different fixes

### 1. The catalog feed itself, polled every 5 seconds forever

[`App.tsx`](../../packages/client/src/providers/App.tsx) `fetchAppState` resolves
`/feeds/{appOwner}/{rawAppTopic}` on every poll, and `StreamBrowser` polls it through SWR at
`refreshInterval: 5000`. The feed gains a slot per broadcast lifecycle event and is never reset.

**A reader that polls the same feed forever is the exact case the explicit path was built for.** It
knows where it got to last time. `nextFeedRequest` in
[`feedFollow.ts`](../../packages/shared/src/feedFollow.ts) already returns a head request for a reader
with no position and a slot request for one that has a position, and both the player and the bench
route through it. The catalog does not.

**Fix: one head lookup on mount, then walk.** Same shape as the player, same shared function, no new
concept. This is the cheapest of the three and the one whose cost grows without bound.

### 2. VOD thumbnails, where the index is already published and thrown away

[`StreamPreview.tsx`](../../packages/client/src/components/StreamPreview/StreamPreview.tsx) resolves
`/feeds/{owner}/{hexTopic}` once per card, through a queue at concurrency 1, so ten cards is ten
lookups end to end.

**The catalog entry already carries the index those lookups are searching for.** `StreamEntry` in
[`StreamCatalog.ts`](../../packages/stream-uploader/src/libs/StreamCatalog.ts) has an `index` field,
and the uploader sets it on the VOD entry to the SOC index of the final VOD manifest.

**The client reads that field in exactly one place, [`StreamList.tsx:28`](../../packages/client/src/components/StreamList/StreamList.tsx), and only to sort by it.**

So for a finished stream the client is searching a feed for a position it was handed. A VOD thumbnail
can compute `soc/{owner}/{makeFeedIdentifier(topic, index)}` and fetch the manifest directly. The
helper is already exported and already covered by tests against bee-js's own vectors.

**Fix: use the index when the entry has one.** Nothing new is published, nothing changes on the
uploader, and the fallback for entries without an index is the path that exists today.

### 3. Live thumbnails, which genuinely have nothing to go on

`notifyStart` publishes a live entry with **no index at all**, unlike the VOD entry. So a live
thumbnail has no position and must search.

This is the only one of the three that needs a new publish, and it is the one to think hardest about
rather than the one to do first. A live stream's index advances every segment, so an entry carrying it
is stale almost immediately, and refreshing it costs a catalog feed write per refresh. That is the
same trade the announce rate limit already manages, and getting it wrong turns a viewer-facing latency
win into a per-segment postage cost.

**Worth noting the index does not have to be current to help.** A thumbnail is a still image. An index
from thirty seconds ago addresses a manifest whose segments have expired from the live window, but a
reader handed a stale position can walk forward from it at 4ms a step, which is the same thing the
player does. So a coarse periodic refresh may be enough, and how coarse is a measurement rather than a
judgement.

## What this is worth, stated as the prediction to check

On a deployment that has recorded **N** broadcast events, the catalog poll currently costs the head
lookup for a feed of length N, and it repeats every 5 seconds. At the measured shape that is about 1s
at N=1, 2s at N=10, 4s at N=100 and 5s at N=1000. **Past a few hundred events the poll no longer fits
inside its own interval**, so the catalog is never not in flight.

The prediction to refute: **fixes 1 and 2 take the steady-state catalog poll to a single slot read at
about 4ms, and the thumbnail row for finished streams from N lookups to N direct fetches.** If they do
not, the reasoning above is wrong somewhere.

## Do not ship this on reading alone

The one time this project changed the client from reading rather than measuring, the change was wrong
and had to be reverted (`a4f9841`, reverted as `303184c`). The mechanism that caught it was measuring
the thing the change was supposed to improve.

**So: prototype against the rig, measure the catalog poll before and after, and only then touch the
client.** The rig for this already exists as
[`feed-head-scaling.mjs`](../../e2e/src/probes/feed-head-scaling.mjs), which reads feeds of several
lengths both ways round robin and needs no video and no broadcast. Extending it to walk a feed rather
than resolve its head is a small change to a probe that costs about a minute to run and roughly one
postage bucket.

⚠️ **Browser validation is separately blocked**, so the final confirmation that a real viewer sees the
improvement cannot come from the automated pane. See the note in the memory on that. The rig answers
whether the read path is faster. It does not answer whether the UI got better.
