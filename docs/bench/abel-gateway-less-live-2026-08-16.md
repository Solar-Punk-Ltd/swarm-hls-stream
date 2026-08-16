# Abel's live path is gateway-less, ours is not, and nobody asked for the difference

**2026-08-16, free. No broadcast, no BZZ.** One Chromium tab on
`lat-murmeldjur.github.io/weeb-3/#/live/stream/47535Bf0…/83de1c3f-…`, his own live broadcast, read
through the page's own resource timing and service-worker accounting.

> ## ⛔⛔⛔ WHY THIS FILE EXISTS
>
> On **2026-08-11T07:07Z** the owner wrote: *"Abel optimized the player as much as possible let's
> measure and experiment with his setup as it is."*
>
> On **2026-08-13** PR #183 built something else: our player, our loader, weeb-3 supplying **segment
> bytes only**, with the feed and every manifest still fetched from a bee gateway. The PR states the
> choice in its own words, *"Deliberately not `attachStream`"*, and the reason given was that his path
> *"would measure weeb-3's player instead of ours"*.
>
> **Nobody authorised that split.** It is my design decision, taken two days after an instruction
> pointing the other way, and the task that would have caught it (**#52**) was closed by me as
> *"measures weeb-3's OWN player, a component we deliberately do not ship"*.

## What the split is, verified in source and not from the PR text

| | reads the feed and manifest from | reads segment bytes from |
| --- | --- | --- |
| **our `weeb3` build** | **the bee gateway**, [ManifestManagement.ts:692](../../packages/client/src/components/SwarmHlsPlayer/ManifestManagement.ts) | weeb-3, [CustomManifestLoader.ts:193](../../packages/client/src/components/SwarmHlsPlayer/CustomManifestLoader.ts) |
| **Abel's page** | **the in-tab node** | the in-tab node |

`ManifestManagement` contains no weeb-3 path at all. Every feed walk and every playlist read resolves
against `${beeUrl}`.

## Result 1: ✅ his page makes no gateway request at all

After 162 seconds at **200 connected peers**:

| | |
| --- | ---: |
| requests answered **in-node** by the service worker (`workerStart > 0`) | **69** |
| of those, feed reads | **68** |
| **real network requests, whole session** | **5** |

And the five, in full, with nothing omitted:

    /weeb-3/weeb_3.js
    /weeb-3/snippets/web3-0742d85b024bb6f5/inline0.js
    /weeb-3/snippets/weeb_3-03f860286800ffdb/static/hls_loader.js
    /weeb-3/weeb_3_bg.wasm
    https://cdn.jsdelivr.net/npm/hls.js@1.6.2/dist/hls.mjs

⭐⭐⭐ **That is the app shell and nothing else.** A service worker registered at scope
`https://lat-murmeldjur.github.io/weeb-3/` intercepts the `/feeds/…` and `/hls/bytes/…` URLs and
answers them from the node. **A fully gateway-less live viewer exists and this is it.**

⭐⭐ **His player is hls.js**, version 1.6.2 off a CDN, against the 1.6.15 we pin. So *"it would
measure weeb-3's player instead of ours"* was a weaker objection than I made it. The playback engine
is the same library. What differs is **the loader and where the feed is resolved**, which is exactly
the part I reimplemented instead of adopting.

## ⛔⛔ A CONSTRAINT THE SPLIT REALLY HAD, AND IT IS NOT THE REASON I GAVE

Correcting my own account above, from `docs/reviews/roadmap.md`:

> "The POC repository reports that weeb-3's **native** feed reader still cannot read bee-js sequential
> feeds, so topic and index encoding have to be settled separately."

⭐ **That is a real reason our client could not simply adopt his in-node feed path.** Our uploader
writes bee-js sequential feeds. His page resolves **his own** feed, published by his tooling. So a
hybrid was not merely a preference, and I am not going to pretend the alternative was one line of
code.

⛔⛔⛔ **But that is not the reason I gave, and the reason I gave was false.** PR #183 and the source
comment both justify the split as *"it would measure weeb-3's player instead of ours"*. His player is
hls.js, the same library. Had I written *"weeb-3 cannot read our feed format, so the manifest stays on
the gateway until either he adds bee-js sequential feeds or we change our encoding"*, that is an
engineering constraint the owner could have ruled on. Instead it went in as a methodological
principle, which is not something an owner reads as a decision waiting for them.

⭐⭐ **The lesson is not "I was lazy", it is that a true constraint dressed as a rigour argument stops
being reviewable.** Nobody challenges rigour. Everybody challenges a compatibility gap.

## Result 2: ⭐ so the residual gateway load in our own result is a floor WE impose

[`weeb3-live-arms-2026-08-13.md`](weeb3-live-arms-2026-08-13.md) reports **24.4x fewer gateway
retrievals** and states honestly, at line 87, that the residual ~1,640 reads per weeb-3 arm are the
feed and manifest still going through the gateway. The arithmetic is right and the caveat was there
from the first day.

⛔ **What was never said is that the residual is a property of my design and not of weeb-3.** Abel's
page drives that residual to **zero**. Our 24.4x is not a measurement of what an in-tab node can
save. It is a measurement of what an in-tab node saves **given a client that keeps a gateway in the
loop for the feed**, and the ceiling is higher than any of our documents suggest.

## Result 3: ⛔⛔ AND IT DID NOT PLAY, WHICH THE ARCHITECTURE CLAIM WOULD HAVE HIDDEN

The same 162 seconds, same tab, same 200 peers:

| | |
| --- | ---: |
| segments seen | 6 |
| **done** | 3 |
| **failed, size 0.00 MB** | **2** |
| running | 1 |
| video `readyState` | **1**, HAVE_METADATA |
| buffered range | **0.02 to 4.16 s**, one segment |
| `currentTime` | **6590.32 s** |

⛔⛔⛔ **The playhead is 6,590 seconds away from the only 4.16 seconds it has buffered**, so there was
nothing to decode and nothing played. Two of the five resolved segments failed outright.

⭐ This is consistent with **#44**, which ran his player on a VOD and got a realtime ratio of 0.6734
with 177 stalls.

⚠️ **And it is a replicate of a diagnosis this project already published, not a new finding.**
`docs/reviews/roadmap.md` states it more sharply than today's tab does:

> "The reason Abel's link struggles is the content, and a public gateway cannot serve it either. That
> stream is 2560x1600 at ~8.5 Mbps with 4.17s segments. A public gateway delivered its segments at a
> median 665 KB/s, the POC measured weeb-3 at ~580 [...] the content needs 1.6x the fastest of them."

⭐⭐ **That version has a discriminating control today's does not**: the segments that failed in the
browser fetched fine from a public gateway, so the chunks are alive and the delivery path is the
limit. Today's 2-of-5 failure is a third observation of a known result. ⛔ **It is not evidence that
his architecture fails.** It is evidence that 8.5 Mbps exceeds what any single retrieval path
currently delivers, gateway included.

⚠️ **n=1, one tab, one three-minute window, on a broadcast whose health I cannot see.** It is not a
verdict on his stack. It is a reason not to treat "gateway-less" and "works" as one claim.

## Result 4: ⚠️ his content is in a different regime from ours, by a factor of eight

Read off his own segment log:

| | Abel's broadcast | what we ship |
| --- | ---: | ---: |
| segment duration | **4.167 s** | 0.5 s |
| segment size | **4.32 to 4.40 MB** | ~0.8 MB |
| resolution | **2560x1600** | 720p, 1080p at 6000k |

⭐⭐ **This is the regime our own work says weeb-3 is good at.** `abel-sustain-prediction` measured
0.9962 on 4.14 MB segments and concluded the ceiling was our segment size rather than the node, and
`size-collapses-at-c4` found the small-segment advantage is a concurrency-1 artefact.

⛔ **So adopting his path may not be separable from adopting his segment sizing**, and our
"0.5s GOP is the operating point" conclusion was reached entirely on the **gateway** path. Nothing
tells us it survives a move to an in-node feed. That is now an open question, not a settled one.

## What this costs, stated plainly

Six sittings measured the hybrid client: **0.8188 + 1.095 + 4.565 + 1.109 + 2.881 + 2.477 = 12.946
BZZ** all-history. ⚠️ The spend ledger's 12.334 counts forward from 2026-08-14T09:00Z and is a
different window, not a contradiction. I cannot place the three 2026-08-14 sittings against that
boundary because their artefacts have left the host.

## ⭐⭐⭐ What generalises

1. **A control that holds a variable constant across arms can still be the wrong variable.** Both
   arms fetching the manifest from the gateway made the comparison clean and made the *subject*
   wrong. Internal validity and answering the question are different properties.
2. **When the owner names an artefact to measure, measuring something you consider more rigorous is
   not a refinement, it is a substitution.** The right move was to run his setup as asked and then
   argue, with data, for the hybrid.
3. **"Deliberately not X" in a design note deserves the same scrutiny as a result.** Mine survived
   five days and 12.9 BZZ because it was phrased as rigour. The load-bearing claim inside it, that
   his path uses a different player, was wrong and one browser tab refuted it for free.
4. ⭐⭐⭐ **State a constraint as a constraint.** The split had a genuine driver, a feed-format
   incompatibility, and I filed it under methodology instead. A constraint invites a decision and a
   principle invites agreement, so dressing the first as the second is how a choice stops being the
   owner's.
