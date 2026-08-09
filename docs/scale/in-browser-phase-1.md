# In-browser viewer nodes, phase 1: what weeb-3 is, and what it does to the scaling model

**2026-08-09.** Assessment of the in-browser Swarm node option ahead of Phase 3, written to be read
by the lab or parsed for a presentation.

**Cost so far: nothing.** No broadcast, no postage, no BZZ. Everything below is source reading, one
browser session against a public deployment, and four reads from a **public** gateway.

⚠️ **Read the status column before quoting anything.** This document deliberately mixes three kinds
of statement and marks every one:

| mark           | means                                                                           |
| -------------- | ------------------------------------------------------------------------------- |
| **[SOURCE]**   | read out of weeb-3's own code at a named commit                                 |
| **[OBSERVED]** | seen once, in one browser, on one network, on 2026-08-09                        |
| **[DERIVED]**  | arithmetic over numbers this repository already measured. **Not measured here** |

---

## 1. The five answers, up front

**1. Abel's link is the current build.** GitHub Pages deploys from `main`, and the live deployment is
`f21ddd91`, which is `main` HEAD. **[OBSERVED]**

**2. It reaches a playable state in about 150 seconds, and sustained playback could not be confirmed
here.** At 56s: zero frames decoded, buffer stranded at 0–4.2s while the playhead sat at 6594s. At
167s: `readyState 4`, 141 frames decoded, buffer at the playhead. **A verdict taken at one minute
would have said "does not play at all" and would have been wrong**, the same lesson a cold gateway
taught us. ⚠️ But over the following seven minutes `currentTime` never advanced by a millisecond, and
the element kept returning to `paused` even after an explicit muted `play()` resolved. **This browser
has autoplay and background-media restrictions, so that is very likely an artifact of the harness
rather than a weeb-3 fault.** It is not evidence either way, and confirming it needs a real browser
session. That is step 4 of the plan. **[OBSERVED]**

**3. ⛔⛔ The reason it struggles is the content, not weeb-3.** That stream is **2560x1600 at
~8.5 Mbps**, and a **public gateway** — a full node, not a browser — delivered its segments at a
median **665 KB/s = 5.3 Mbps**. The content needs **1.6x more throughput than the fastest arm
delivered**. Nothing in the browser causes that. **[OBSERVED]**

**4. ⭐ Our own profiles are a much better match, and one of them fits with room to spare.** At
2.83 Mbps a viewer needs 354 KB/s against the ~580-670 KB/s these paths deliver. At 1080p/6000k they
need 750 KB/s, which is **above** it. **[DERIVED]**

**5. ⛔⛔ In-browser nodes invert our scaling model, and this is the finding that matters most.**
Every result we have about serving many viewers rests on **pooling behind a gateway**: 16 viewers cost
the network what 1 costs, because bee fetches each chunk once and serves everyone from it. **Remove
the gateway and that saving is gone.** 20,000 browser nodes are 20,000 independent retrievals of the
same chunks. See section 6. **[DERIVED]**

---

## 2. What weeb-3 is, from its own source

Repository `lat-murmeldjur/weeb-3`, MIT, Rust compiled to WebAssembly, `main` at **`f21ddd9`
("Commit number 328"), 2026-08-06**. 33,831 lines of Rust across `src/`, of which **8,942 are
`stream_hls.rs`** — HLS is by far the largest single component. **[SOURCE]**

| property                | value                                                                  | where                                                                                    |
| ----------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| node type               | browser-only Swarm client, **no persistent state across sessions**     | README                                                                                   |
| transport               | libp2p WebSocket / WSS                                                 | README                                                                                   |
| connection pool ceiling | **`CONNECTION_BUILDUP_LIMIT = 200`**                                   | `accounting.rs`                                                                          |
| free-credit rate        | **`REFRESH_RATE = 450000`**                                            | `accounting.rs`                                                                          |
| chunk price ceiling     | `MAX_CHUNK_PRICE = 32 * 10000`                                         | `accounting.rs`                                                                          |
| erasure coding          | **on the retrieval path**, not just upload                             | `retrieval.rs` imports `RedundancyLevel`, `reconstruct_data_indices`, `reference_layout` |
| race retrieval          | **absent.** No occurrence of `race` anywhere in `src/*.rs`             | grep                                                                                     |
| WASM payload            | **4.15 MB raw**                                                        | research handoff                                                                         |
| npm                     | `@lat-murmeldjur/weeb_3`, latest **`0.0.327001`** published 2026-08-06 | registry                                                                                 |

### Two corrections to the research note

⛔ **"weeb-3 needs to support erasure coding (already in progress)" is out of date.** Erasure decoding
is on the retrieval hot path today, and the POC repository confirms it independently: _"native
`retrieveBytes` decodes erasure coding in the node (no client-side joiner needed)"_. **[SOURCE]**

✅ **"weeb-3 needs race retrieval" is correct and still open.** There is no race or multi-peer
first-response-wins path in the retrieval code. The note's other claim, that race-vs-normal made
little difference to latency, is worth revisiting once the content is right-sized: on a path running
at 1.6x over capacity, no request strategy shows a difference, because the bottleneck is bytes.

### Supply chain

Per the standing rule, all four checks on `@lat-murmeldjur/weeb_3@0.0.327001`:

| check              | result                                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| publish age        | **2026-08-06, three days old. This is a flag**, and it is the only one |
| signature          | ✅ present, keyid `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U` |
| provenance         | ✅ **SLSA `https://slsa.dev/provenance/v1` attested**                  |
| malware advisories | ✅ none (`gh api /advisories?type=malware`)                            |

Queried one field at a time, and sanity-checked against a package the change did not touch. **A
three-day-old release with attested provenance is a much better position than an old one without**,
but if we pin it, pin the exact version rather than a caret range.

---

## 3. Does it speak our dialect? Yes, and this was the open question

⭐⭐ **weeb-3's feed topic derivation is byte-identical to bee-js.** The live page derived topic
`d1e6072f…1a7a` from the UUID `83de1c3f-edc4-42c9-bfd8-62782c70b289`, and `Topic.fromString` on that
same UUID in our own uploader's bee-js produces the same 32 bytes. **[OBSERVED]**

That matters because our uploader's `streamRawTopic` **is** a `crypto.randomUUID()`, and the topic in
Abel's link is a v4 UUID. The stream he is testing with has the exact shape our stack produces.

⚠️ **The POC repository reports the opposite result** — that weeb-3's native `acquireFeedBytes()`
returns not-found for bee-js sequential feeds. Both can be true: the **topic** convention matches
while the **index encoding** does not. That is the first thing phase 1 should settle, because it
decides whether we get the native path or must keep a custom loader.

### What weeb-3's service worker actually serves

The player never sees Swarm. A service worker under `/weeb-3/` answers virtual routes: **[OBSERVED]**

- `/weeb-3/feeds/{owner}/{topic}?start=live` — the playlist
- `/weeb-3/hls/bytes/{ref}` — one segment
- `?codec-bootstrap=4` — a **codec bootstrap** variant of the playlist

⭐ **That `codec-bootstrap` parameter is weeb-3 solving our task #40.** A player fixes its codec set
from the first fragment it parses, so weeb-3 hands it a bootstrap playlist first. We reached the same
problem from the other end and fixed it in the uploader (task #41). **Both fixes are wanted**: ours
stops a broadcast being published unplayable, theirs stops a player choosing wrong. Neither replaces
the other.

⛔ **The service worker is hardcoded to the `/weeb-3/` scope**, so `attachStream()` assumes the app
_is_ weeb-3's deployment. Embedding it at our own path means either serving under `/weeb-3/` or
writing our own hls.js loader, which is what the POC did.

⛔ **COOP/COEP cross-origin isolation is required** (SharedArrayBuffer). That is a real deployment
constraint: it breaks third-party embeds and iframes, so a "watch on any site" story gets harder.

---

## 4. Is it configured for _our_ streams? Partly, and one number decides it

**[SOURCE]** for every weeb-3 value below.

| knob                                  | weeb-3                                    | what it means for us                                                      |
| ------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| **`HLS_LIVE_SYNC_SEGMENTS = 8`**      | player targets **8 segments** behind live | ⛔ **the decisive one, see below**                                        |
| `maxBufferLength`                     | 90s (30s on ≤2 GiB devices)               | never binds live, binds hard on VOD                                       |
| `maxMaxBufferLength`                  | 120s (60s low memory)                     | same                                                                      |
| `backBufferLength`                    | 30s                                       | fine                                                                      |
| `maxBufferSize`                       | 96 MB (32 MB low memory)                  | ⚠️ at 8.5 Mbps that is 90s; at our 2.83 Mbps it is 270s                   |
| `maxBufferHole`                       | 1.0s                                      | tolerant, good on a lossy path                                            |
| retry policy                          | **`maxNumRetry: 1`**, 500ms, exponential  | ⚠️ thin. Our announcement floor says an edge miss costs ~480ms on its own |
| `autoStartLoad` / `startFragPrefetch` | both false                                | deliberate, the Rust side drives loading                                  |
| `enableWorker`                        | true                                      | good                                                                      |

### ⛔ `HLS_LIVE_SYNC_SEGMENTS = 8` against our two candidate profiles

hls.js counts the live sync target in **segments**, not seconds, so the same 8 means completely
different things depending on our fragment length. Our live manifest window is **9.0 seconds** at the
best profile. **[DERIVED]**

| our profile               | segments in the 9.0s window |    8 segments back is | margin before the wanted segment leaves the window                                 |
| ------------------------- | --------------------------: | --------------------: | ---------------------------------------------------------------------------------- |
| **1.0s fragments**        |                           9 |      8.0s behind live | ⛔ **one segment.** The player sits on the oldest segment the manifest still names |
| **0.25s fragments**       |                          36 |      2.0s behind live | ✅ **28 segments**                                                                 |
| Abel's test stream, 4.17s |         n/a, EVENT playlist | 30.15s behind the end | matches the observed `#EXT-X-START:TIME-OFFSET=-30.150002` exactly                 |

⛔⛔ **So weeb-3 plus our 1.0s profile is the fragile combination, and it is fragile in the worst
possible way.** One segment of margin means an ordinary slow read drops the player off the back of the
window, and per `hls-stall-latency-penalty` **one non-fatal stall raises hls.js's latency target and
it never lowers it again**. The viewer degrades permanently and nothing reports it.

⚠️ **This is a new input to an already-open question, not a decision.** The optimisation campaign's
evidence favours 1.0s on cost (8.4%), postage (37%) and refusals (0 vs 45). This does not overturn
any of that. It says: **if in-browser viewers ship, the profile question has to be re-opened with this
on the table**, and the cheapest resolution is to make `liveSyncDurationCount` configurable rather
than to move the fragment length.

---

## 5. What actually happened when we loaded Abel's link

**[OBSERVED]**, one session, in-app Chromium, 2026-08-09.

| t         | what                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| +2ms      | node created, mainnet, chain 100, xBZZ                                                                         |
| +19ms     | dialing **160 configured bootnodes**                                                                           |
| ~15s      | **43 peers connected**, 156 still dialing                                                                      |
| ~30s      | feed frontier **resolved, bounded candidate index 1535**                                                       |
| ~56s      | **138 peers.** `readyState 1`, **0 frames decoded**, buffer stranded at 0–4.2s while the playhead sat at 6594s |
| ~56s      | repeated **`Applied refreshment 450000`** — the pseudosettle free-credit path, matching `REFRESH_RATE` exactly |
| ~56–150s  | several `hls-segment … [failed] … size 0.00 MB`, some succeeding on retry                                      |
| **~167s** | ✅ `readyState 4`, **141 frames decoded**, buffer now at 6592.2–6596.3, at the playhead                        |
| 167-407s  | ⚠️ `currentTime` **frozen at 6594.4**, frames climbed to 282, element repeatedly `paused`                      |
| ~350s     | a muted `play()` resolved and `paused` went false, then returned to true within 43s, playhead still 6594.4     |

⚠️ **Do not read that last stretch as starvation.** A `paused` element makes "did not advance" carry
no information about whether bytes were arriving, and this browser applies autoplay and
background-media restrictions. The buffer stayed populated **at the playhead** and frames kept
decoding throughout, which is the opposite of what starvation looks like. Sustained playback is
genuinely untested, which is why it is step 4 rather than a conclusion.

### The playlist it served

```
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-START:TIME-OFFSET=-30.150002,PRECISE=NO
#EXT-X-MEDIA-SEQUENCE:0
… 1591 segments, 160,853 bytes …
#EXT-X-ENDLIST
```

⛔ **The stream Abel is testing with has ended.** `#EXT-X-ENDLIST` is present, the playlist holds
**1591 segments of a 6,622 second (1h50m) recording**, and `?start=live` simply seeks to 30.15s from
the end. So this link exercises **a cold VOD seek deep into a long recording**, not live playback.
That is a perfectly good test, but it is not the test its URL implies, and it is not the test we need.

### ⭐ The discriminating control, which is what makes any of this a finding

Two segments failed in the browser and two landed. All four were then fetched from a **public**
gateway, costing us nothing:

| segment     | in the browser      |       from a public gateway |
| ----------- | ------------------- | --------------------------: |
| `71b4aa28…` | landed              | **200, 4,343,552 B, 4.67s** |
| `c0729b94…` | landed              | **200, 4,400,892 B, 6.70s** |
| `9f069894…` | **failed, 0.00 MB** | **200, 4,498,276 B, 6.75s** |
| `620a332d…` | **failed, 0.00 MB** | **200, 4,496,020 B, 6.76s** |

**Every chunk is alive and retrievable.** The browser node's failures are reach and throughput, not
missing content. Without this control the honest reading would have been "the recording has rotted",
and that would have been wrong.

### ⭐⭐ And the arithmetic that explains the whole session

| quantity                                    |                     value |
| ------------------------------------------- | ------------------------: |
| mean segment                                |               **4.43 MB** |
| segment duration                            |               **4.1667s** |
| **throughput the content demands**          | **1,064 KB/s = 8.5 Mbps** |
| median delivered, **public gateway**        |   **665 KB/s = 5.3 Mbps** |
| measured elsewhere, weeb-3 in Chrome (POC)  |                 ~580 KB/s |
| ultra-light bee baseline (research handoff) |                 ~670 KB/s |
| **shortfall**                               |                  **1.6x** |

⛔⛔ **Even a public gateway cannot play this stream in real time.** Three independent
measurements — a public gateway at 665, a browser node at 580, a native ultra-light bee at 670 — land
within 15% of each other. **That band, roughly 600 KB/s, is the number to design against**, and the
test content is 1.6x above it.

⚠️ **n=1 per arm on the gateway reads, one browser session.** The consistency across four refs and
three independent sources is what makes it worth stating; it is not yet a replicated measurement.

---

## 6. ⛔⛔ What in-browser nodes do to everything we have measured

This is the section to put in front of the lab.

**Every scaling result this repository holds is a result about a gateway.** The strongest one is that
**16 viewers cost the network what 1 costs**, because bee fetches each distinct chunk once and serves
every concurrent viewer from that one fetch. Pooling is the whole reason our numbers look affordable.

**An in-browser node removes the gateway.** So:

| what changes                                                     | direction                                | why                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **chunk fetches per viewer**                                     | ⛔⛔ **catastrophically worse**          | pooling is gone. 20,000 viewers are 20,000 independent retrievals of the same chunk, where 20,000 behind ~160 gateways would be ~160                                                                                |
| **our gateway ceiling** (128 hold, 192 fail, 43-44 MB/s plateau) | ✅ **gone**                              | there is no gateway to saturate                                                                                                                                                                                     |
| **who carries the load**                                         | ⛔ **moves onto storers and forwarders** | the neighbourhood holding each chunk now answers every viewer directly                                                                                                                                              |
| **the synchronised-audience problem**                            | ⛔ **worse**                             | we measured that what limits a gateway is how many viewers want the **same chunk at once**. That constraint does not disappear, it relocates to the storer neighbourhood, and there is no shared fetch to absorb it |
| **cost in BZZ to us**                                            | ✅ **plausibly near zero**               | viewers pay their own retrieval, or pay nothing, see below                                                                                                                                                          |
| **our infrastructure cost**                                      | ✅ **near zero**                         | no gateway fleet                                                                                                                                                                                                    |
| **quality ceiling per viewer**                                   | ⛔ **lower**                             | ~600 KB/s against a gateway viewer's share of 43-44 MB/s                                                                                                                                                            |
| **time to first frame**                                          | ⛔ **much worse**                        | ~150s observed cold, against a gateway viewer's seconds                                                                                                                                                             |
| **page weight**                                                  | ⛔ **+4.15 MB of WASM**                  | per viewer, per cold load                                                                                                                                                                                           |

### The funding question, which is now the default case rather than the edge case

We already measured what an **unfunded** node does: it cannot settle, so bee **skips peers ~37x per
chunk** and it **asks 38 peers where a funded one asks 1**. We concluded "do not ship unfunded".

⛔ **Every browser viewer is unfunded.** We watched `Applied refreshment 450000` repeatedly on the
live page: the node is living on pseudosettle free credit, exactly the regime that produced the 38x.
**[OBSERVED]**

⚠️ **Do not carry the 38x across without testing it.** That figure came from bee's own counters on a
bee node. weeb-3 is a different implementation with its own accounting (`refreshment_due`,
`bee_reconnect_delay_seconds`, a x10 `BEE_LIGHT_ACCOUNTING_FACTOR`). Whether it suffers the same
amplification is **the single highest-value thing phase 1 can measure**, because if it does, then
20,000 browser viewers do not put 20,000 requests on the network, they put something closer to
760,000.

---

## 7. Could 10-20k hold?

Assuming "10-20 stage" means **10,000-20,000 concurrent viewers**, Devcon scale. Say so if that is
wrong, because the answer changes shape below about 2,000.

### The honest answer today: **we cannot say, and the three things that decide it are all unmeasured.**

What we can bound:

**a) Per-viewer quality is capped at roughly 600 KB/s.** **[DERIVED from three sources]** So:

| profile               |      needs | verdict for a browser viewer                                |
| --------------------- | ---------: | ----------------------------------------------------------- |
| **2.83 Mbps**         |   354 KB/s | ✅ **fits, ~1.7x headroom.** This is the profile to plan on |
| **1080p / 6000k**     |   750 KB/s | ⛔ **does not fit.** Above the observed band                |
| Abel's 2560x1600 test | 1,064 KB/s | ⛔⛔ 1.6x over, and a public gateway cannot serve it either |

**b) Our own delivery is not the constraint.** The feed scales: a feed read at 128 concurrent readers
costs what it costs at one. Publishing is unaffected by audience size. The publisher side of a
20,000-viewer event looks the same as a 1-viewer event.

**c) ⛔ The constraint is the storer neighbourhood, and we have never measured it.** Everything we
have measured sits on the **viewer** side of a gateway or on the **publisher** side of the network.
The question "what happens when 20,000 unfunded nodes ask one neighbourhood for the same chunk within
the same second" is one this repository has never asked, and it is the question that decides the
event.

### What would make it hold, in rough order of leverage

1. **Ship 2.83 Mbps to browser viewers, not 1080p/6000k.** Free, and it is the difference between
   fitting and not fitting.
2. **Jitter the client.** We already measured that a synchronised audience is the failure mode and
   that jittering the client is what fixes it: 128 viewers on one tick drain 12.8s of buffer, in
   cohorts of 8 they are comfortable. This applies **more** strongly with no gateway to absorb the
   burst, and it is a change we have already shipped once.
3. **Hybrid, not pure.** Gateways for the viewers who need low latency and high quality, browser
   nodes for the tail. Pooling stays where it pays, and the browser nodes take load off the fleet
   without being the only path.
4. **Fund the browser nodes, or prove they do not need it.** If the 38x amplification carries over,
   this stops being an optimisation and becomes the difference between working and not.
5. **Raise the fragment count in the live window, or make `liveSyncDurationCount` configurable**, so
   `HLS_LIVE_SYNC_SEGMENTS = 8` stops being one segment of margin.
6. **Push race retrieval upstream.** Absent in weeb-3, present in hoverfly. On a path running at
   1.6x over capacity it would show nothing, which is likely why it measured as no help.

---

## 8. The plan: in-browser phase 1

Ordered so that **every step that can kill the idea comes before any step that costs money**. Nothing
in steps 1-4 spends BZZ or needs a broadcast.

| #     | step                                                                                                                                                                                                                                    | answers                                                                                                                           | cost                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **1** | **Replay our own stream shape.** Point weeb-3 at an existing well-replicated recording **of ours** at 2.83 Mbps, and repeat the exact readings taken here: time to first frame, frames decoded, buffer occupancy, per-segment wall time | whether the 1.6x shortfall disappears when the content is right-sized. **The single most decision-relevant number**               | free, archived content                                                          |
| **2** | **Native feed path: does `acquireFeedBytes` read our feeds?** Topic derivation already matches. Test index encoding directly                                                                                                            | whether we get the native path or must ship a custom loader forever                                                               | free                                                                            |
| **3** | **Unfunded amplification.** Instrument request counts per chunk from the browser node and compare against the funded-gateway figure we already hold                                                                                     | whether the 38x carries to weeb-3. Decides whether 20k is 20k requests or 760k                                                    | free                                                                            |
| **4** | **Cold start, replicated.** Time-to-first-frame across n runs and both start modes (`live`, `beginning`), on desktop and on mobile                                                                                                      | ⚠️ ~150s was **one** observation. It is either the headline product problem or an outlier, and we do not know which               | free                                                                            |
| **5** | **Two browsers, one chunk.** Two browser nodes fetching the same segment simultaneously, then 4, 8. Measure whether service time degrades                                                                                               | the first real reading on the herd effect **without** a gateway to absorb it                                                      | free                                                                            |
| **6** | **Live, against our own publisher.** Only after 1-5. Both fragment profiles, measuring the `HLS_LIVE_SYNC_SEGMENTS = 8` margin directly                                                                                                 | whether 1.0s really is the fragile combination the arithmetic says it is                                                          | ⚠️ **broadcast minutes. Price it in bytes and bring the number before booking** |
| **7** | **Desktop vs mobile.** The research handoff flags that weeb-3 runs in a Shared Worker and **Shared Worker is unsupported on Chrome/Android**                                                                                            | the note's own first open question, "viewer device ratio". If mobile cannot run it, the device mix decides the whole architecture | free                                                                            |

### How to run it

⛔ **Do not measure through Abel's link.** It is a finished 1h50m recording at 1.6x over capacity, so
every number it produces is a number about that content.

⛔ **Take the crossing rate, not the median.** The right statistic for "does it keep up" is the
fraction of segments whose wall time exceeds their own duration. The POC's eight readings against 2s
segments were 1.9, 2.5, 2.9, 3.2, 3.4, 4.0, 4.2, 7.3s: **8 of 8 slower than real time, a 100%
crossing rate**, which the phrase "~3s typical" conceals entirely.

⛔ **Every arm needs the public-gateway control** taken here. It is the only thing that separates "the
browser node cannot reach it" from "the content is not there", and those two look identical from
inside the browser.

⚠️ **Alternate arms, never ladder them.** Same rule as every sitting we have run.

### Whether to vendor it

**Not yet.** Pin `@lat-murmeldjur/weeb_3@0.0.327001` exactly for steps 1-5. A submodule is worth it
only once we need to patch `HLS_LIVE_SYNC_SEGMENTS` or the retry policy, and by then we will know
whether we are patching or contributing upstream. Abel is in-house and a native streaming path is
reportedly already coming, so **the default should be to feed findings upstream rather than fork**.

---

## 9. ⛔ What this document cannot say

- **Nothing here is a measurement of weeb-3 against our own stream.** Every number is either from
  weeb-3's source, from one session against someone else's content, or derived from our earlier
  gateway work. That is exactly what phase 1 exists to fix.
- **~150s time-to-first-frame is one observation**, in one browser, on one network, against
  oversized content. It is not a product figure.
- **The ~600 KB/s band is three loosely-comparable numbers**, not a controlled measurement: a public
  gateway on 4.4 MB files, a POC's report, and a research handoff's baseline.
- **The 38x unfunded amplification has not been shown to apply to weeb-3 at all.** It is a bee result
  being carried across an implementation boundary, which is precisely the move that has burned us
  before.
- **No storer-side measurement exists**, so the central 20,000-viewer question is genuinely open.
- **Hoverfly and Vertex were not re-assessed here.** The research handoff's comparison stands, and
  its recommendation to start on weeb-3 is well supported by what this found.
