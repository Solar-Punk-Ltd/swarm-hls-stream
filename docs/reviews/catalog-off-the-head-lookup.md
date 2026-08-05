# Taking the catalog off the head lookup

**2026-08-05, task #73. Written from reading, then measured against the deployment, then fix 1 built.
The measurement is in the middle and the state of each fix is on its heading.**

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

### 2. ✅ VOD thumbnails, where the index was already published and thrown away

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

**Measured on the real catalog first, then built.** Probe:
[`vod-thumbnail-index.mjs`](../../e2e/src/probes/vod-thumbnail-index.mjs), 12 entries, round robin.

| arm                          |    min | **median** |    max |
| ---------------------------- | -----: | ---------: | -----: |
| head lookup, what a card did | 1107ms | **2647ms** | 4179ms |
| slot by the published index  |    3ms |    **4ms** |    8ms |

**12 of 12 byte-identical, and the head resolved to exactly the published index every time**, so the
two arms are the same read reached two ways. That equality was the thing that could have refused the
change: had the head been newer than the recorded index, an index-addressed thumbnail would show an
older manifest than today's does.

Worth stating what the queue makes of that. Previews share a `PQueue` at concurrency 1, so the
lookups are serial: **ten cards is about 26 seconds of head lookups against about 40ms of slot
reads.** At the time of measurement the catalog held **228 entries, all VOD, all carrying an index**,
so this covers every card on the page.

Shipped in `1ccb891`, with the address spelled by `feedSlotPath` in the shared package (`da6b043`)
rather than a second copy of the rule.

### 3. Live thumbnails, which genuinely have nothing to go on

`notifyStart` publishes a live entry with **no index at all**, unlike the VOD entry. So a live
thumbnail has no position and must search.

This is the only one of the three that needs a new publish, and it is the one to think hardest about
rather than the one to do first. A live stream's index advances every segment, so an entry carrying it
is stale almost immediately, and refreshing it costs a catalog feed write per refresh. That is the
same trade the announce rate limit already manages, and getting it wrong turns a viewer-facing latency
win into a per-segment postage cost.

#### The cheap version does not work, and here is the arithmetic that says so

The tempting move is to put the index on the live entry for free. `commitManifest` sets `socIndex`
and then calls `announceToCatalog` in the same pass, so `notifyStart`'s entry could carry the first
manifest's index at no extra write. A reader handed a stale position walks forward from it, which is
what the player does.

**That walk inverts partway through a broadcast.** A step costs 4ms and the head lookup it replaces
costs 2647ms, so walking wins while the stream is under **662 slots** old. The live manifest is
republished per segment, so at a 0.5s GOP that is one slot every half second:

| broadcast age at 0.5s GOP | slots behind |     walk | head lookup |
| ------------------------- | -----------: | -------: | ----------: |
| 1 minute                  |          120 |    480ms |      2647ms |
| **5.5 minutes**           |      **662** | **2.6s** |    **2.6s** |
| 30 minutes                |         3600 |    14.4s |      2647ms |

So a fix that helps a stream someone just started makes a long broadcast **five times worse**, and
which side of the line a viewer lands on depends on when they happened to open the page. That is not
a fix, it is a coin flip, and it is worth writing down because the free version looked obviously
correct until the crossover was computed.

#### What is actually on the table

**Address the first manifest and stop.** 4ms flat, no walk, at the cost of showing the opening frame
of the broadcast rather than a recent one. Worth weighing against how fresh the current thumbnail
really is: the effect runs once per mount and never refreshes, so a card that has been on screen for
twenty minutes is already showing a twenty-minute-old frame. The difference is between an old frame
and the oldest frame, and whether an opening frame is an acceptable thumbnail is a product call
rather than a measurement.

**Refresh the index periodically.** Keeps a recent frame and costs one catalog feed write per
refresh. The catalog is currently written twice per stream, at start and at stop, so this is a real
new cost rather than a reshuffle, and it lengthens the feed every viewer reads.

**Leave live thumbnails on the head lookup.** The status quo, and it is defensible: at the time of
measurement the catalog held 228 entries and **none of them were live**, because the VOD entry
replaces the live one on the same `(owner, topic)`. Fix 2 already covers every card on that page.

## What this is worth, stated as the prediction to check

On a deployment that has recorded **N** broadcast events, the catalog poll currently costs the head
lookup for a feed of length N, and it repeats every 5 seconds. At the measured shape that is about 1s
at N=1, 2s at N=10, 4s at N=100 and 5s at N=1000. **Past a few hundred events the poll no longer fits
inside its own interval**, so the catalog is never not in flight.

The prediction to refute: **fixes 1 and 2 take the steady-state catalog poll to a single slot read at
about 4ms, and the thumbnail row for finished streams from N lookups to N direct fetches.** If they do
not, the reasoning above is wrong somewhere.

Both halves were then put to the deployment and both held. The catalog poll is measured below, the
thumbnail row in the fix 2 section above.

## ✅ Measured against the real catalog feed, 2026-08-05, and it holds

Not a synthetic feed. The `latbench` app catalog, **455 slots deep**, read from its own gateway.
Probe: [`catalog-head-vs-walk.mjs`](../../e2e/src/probes/catalog-head-vs-walk.mjs). 15 rounds, round
robin. No deploy needed, because this measures the read pattern rather than the shipped client.

| arm                                        |    min | **median** |    max |
| ------------------------------------------ | -----: | ---------: | -----: |
| **head lookup**, what the catalog does now | 2412ms | **5015ms** | 5018ms |
| **walk**, slot present                     |    5ms |    **7ms** |   12ms |
| **walk**, slot absent, the idle case       |    3ms |    **5ms** | 1529ms |

**5015ms to 5ms, about a thousandfold**, and closer to the synthetic prediction than it had any right
to be given the feed is twenty times longer.

**The number that matters most is the comparison to the poll interval.** `StreamBrowser` polls at
`refreshInterval: 5000`, and the head lookup takes **5015ms**. This deployment is already past the
point where the catalog poll does not fit inside its own interval, so the catalog was never not in
flight. That was written above as something that would happen past a few hundred events. It has
happened: 455.

The 1529ms maximum on the absent arm is the same tail the synthetic probe found, about one miss in
twenty, and it is still under a third of the median it replaces.

## Do not ship this on reading alone

The one time this project changed the client from reading rather than measuring, the change was wrong
and had to be reverted (`a4f9841`, reverted as `303184c`). The mechanism that caught it was measuring
the thing the change was supposed to improve.

**So the order was: measure the prerequisite, measure the prediction, then touch the client.** Both
measurements are above, and both could have refused the change rather than confirming it.
[`feed-miss-cost.mjs`](../../e2e/src/probes/feed-miss-cost.mjs) asked whether a miss is cheap, since a
walking reader on an idle catalog mostly misses.
[`catalog-head-vs-walk.mjs`](../../e2e/src/probes/catalog-head-vs-walk.mjs) asked whether the
prediction held on the real feed. Neither needed a broadcast or a deploy.

[`vod-thumbnail-index.mjs`](../../e2e/src/probes/vod-thumbnail-index.mjs) asked whether the index a
VOD entry publishes addresses the same manifest the card's own lookup finds, since an index-addressed
thumbnail showing an older manifest would be a regression however fast it was.

**Fix 1 is built** (`a522e28`), with the position kept in a `CatalogFeedReader` that walks while slots
answer rather than advancing one per poll, because a follower whose catch-up rate equals its poll rate
never recovers from falling behind. **Fix 2 is built** (`1ccb891`). Fix 3 is not, and the section
above argues its cheapest form is a coin flip rather than a fix.

⚠️ **Browser validation is separately blocked**, so the final confirmation that a real viewer sees the
improvement cannot come from the automated pane. See the note in the memory on that. The rig answers
whether the read path is faster. It does not answer whether the UI got better.
