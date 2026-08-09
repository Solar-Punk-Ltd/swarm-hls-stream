# In-browser viewer nodes, phase 1: what weeb-3 is, and what it does to the scaling model

**2026-08-09.** Assessment of the in-browser Swarm node option ahead of Phase 3, written to be read
by the lab or parsed for a presentation.

**Cost so far: 0.0019231 BZZ, and no broadcast minutes.** All of it is one 40-read control against our
own gateway in section 5c. Everything else is source reading and browser sessions against a public
deployment, on an unfunded node that cannot spend.

⚠️ **Read the status column before quoting anything.** This document deliberately mixes three kinds
of statement and marks every one:

| mark           | means                                                                           |
| -------------- | ------------------------------------------------------------------------------- |
| **[SOURCE]**   | read out of weeb-3's own code at a named commit                                 |
| **[OBSERVED]** | seen once, in one browser, on one network, on 2026-08-09                        |
| **[DERIVED]**  | arithmetic over numbers this repository already measured. **Not measured here** |

---

## 1. The seven answers, up front

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

**4. ⛔⛔ Our own profiles are a better match, but "with room to spare" was WRONG and section 5c
retires it.** That claim rested on a ~580-670 KB/s band which turned out to be a distant gateway's
round trip rather than anything's delivery capability. **Measured directly at n=500, a browser node
delivers 115 KB/s sequentially and about 345 KB/s at its own configured concurrency of 3, against the
357 KB/s that 2.86 Mbps needs.** That is **0.99x of realtime at the median and 0.67x at the p90**, on
an idle laptop with nothing decoding. **The best-fitting profile we have does not fit with room to
spare, it fits with none.** 1080p/6000k is not a close call. **[OBSERVED]**

**5. ⛔⛔ In-browser nodes invert our scaling model, and this is the finding that matters most.**
Every result we have about serving many viewers rests on **pooling behind a gateway**: 16 viewers cost
the network what 1 costs, because bee fetches each chunk once and serves everyone from it. **Remove
the gateway and that saving is gone.** 20,000 browser nodes are 20,000 independent retrievals of the
same chunks. See section 6. **[DERIVED]**

**6. ⛔⛔⛔ A weeb-3 node is a PURE CONSUMER, and this is worse than answer 5 alone.** It creates seven
libp2p control handles and accepts inbound streams on exactly two of them, **pricing and gossip**. It
never accepts inbound retrieval, pushsync or swap. **A browser audience therefore adds no serving
capacity and no cache capacity at all**, while each node asks **six peers to confirm every chunk**
(`RETRIEVE_CHECK_CONFIRMATION_PEERS = 6`). All demand, no supply. See section 5c. **[SOURCE]**

**7. ⛔ A not-found costs a browser node 13.5 seconds**, against roughly 480 ms for a bee gateway, 28x.
Any design that speculatively asks for chunks that might not exist is disqualified. **[OBSERVED]**

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

✅ **CORRECTION: COOP/COEP cross-origin isolation is NOT required.** This document previously said it
was, on the assumption that the runtime used `SharedArrayBuffer`. **It does not.** On the live
deployment `crossOriginIsolated` is `false` and `SharedArrayBuffer` is `undefined`, there are **zero**
references to it in the built JavaScript, and the README lists moving the runtime into workers as
future work. The runtime is single-threaded on the main thread. **[OBSERVED] + [SOURCE]**

That removes a deployment constraint rather than adding one: third-party embeds and iframes are not
blocked by isolation headers. ⚠️ The service worker is still hardcoded to the `/weeb-3/` scope, which
is a separate and real packaging constraint.

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
within 15% of each other, and the content is 1.6x above all of them.

⛔⛔ **CORRECTION, made the same day by step 1. Do NOT read "~600 KB/s" as a property of the
network.** An earlier draft of this document said design against that band. **It is wrong**, and the
control that killed it was free: re-fetching a segment the public gateway had **just served** took
**exactly as long as the cold fetch** (0.99–1.23s warm against 1.11s cold). A cache hit that costs
what a miss costs is not measuring retrieval. That ~1.1s is the round trip to a distant public
gateway, and it sits inside every "KB/s" derived from it.

⭐ **So the public gateway is a usable instrument only where bytes dominate the round trip.** At
4.4 MB it is roughly fine. At our 95 KB segments it reports the instrument. See section 5b.

---

## 5b. ✅ STEP 1 RUN: our own stream through weeb-3

**2026-08-09, same browser, same node, same session type as section 5.** Free: the recording already
existed, the control ran on the host. The only difference from section 5 is **the content**.

**The recording**: `8d8a30ff…` / topic `38699de1-061c-494a-a0a2-571740f11760`, 2026-08-08, **917.2s,
3,444 segments at 0.266s, 1280x720, mean segment 94,978 B = 357 KB/s = 2.86 Mbps.** Exactly the
profile section 7 predicted would fit.

### ⭐⭐ Time to a playable state went from ~150s to 5s

|                               |   Abel's stream |  **our recording** |
| ----------------------------- | --------------: | -----------------: |
| bitrate                       |        8.5 Mbps |      **2.86 Mbps** |
| segment                       | 4.43 MB / 4.17s | **95 KB / 0.266s** |
| **`readyState 4` reached at** |       **~167s** |            **~5s** |

**The content hypothesis is confirmed.** Nothing else changed.

### ✅ weeb-3 reads our streams natively, end to end

- **feed frontier resolved to bounded candidate 3445**, which is exactly the index our catalog records
  for that recording. **The native feed path works on our feeds**, at least for read.
- ⭐ **It parses our absolute segment URLs.** Our manifests carry
  `http://49.12.149.62:10077/bytes/<ref>`, and `swarm_bytes_reference` strips host and route to the
  bare reference, so **segments are fetched from Swarm and not through our gateway**. Verified in
  source and in the served playlist. That trap would have made a browser node look fast while
  measuring nothing.
- It reported our segments correctly: `size 0.10 MB, duration 0.266 s, resolution 1280x720`.
- It issues HTTP **range** requests (`bytes=0-105279`).

### ⛔ Per-segment service time, n=18 — **SUPERSEDED by section 5c, do not quote these numbers**

**Section 5c re-ran this at n=500 and every figure in this subsection moved.** The bimodality was an
artifact of measuring **on the stream page while the player was running**, which mixed prefetch cache
hits into the sample. On the app shell, where nothing is prefetched, **there are no 2–9 ms requests at
all** and the floor is 784 ms. Kept here because the mistake is the instructive part.

Taken from the browser's own `performance` resource timings, so **the media-element pausing below
cannot contaminate it**. n=18.

|                                                         |                  ms |
| ------------------------------------------------------- | ------------------: |
| nine requests (already prefetched / SW cache)           |             **2–9** |
| p50 over all                                            |             **246** |
| **p90**                                                 |           **2,771** |
| max                                                     |           **3,152** |
| **crossing rate** (slower than the segment's own 266ms) | **27.8%** (5 of 18) |

⛔⛔ **The median says comfortable and the p90 says failing.** A real retrieval clusters near 250ms,
which is just inside real time for a 266ms segment, and then there is a tail to 3.1s. With weeb-3's
**`HLS_PREFETCH_BODY_MAX_PARALLEL = 3`**, three in flight at 250ms is 12 segments/s against the 3.76/s
this profile needs — comfortable. **Three in flight at the p90 of 2.77s is 1.08/s, which is not.**
Same lesson as every other sitting: quote the crossing rate, never the median.

### The local-RTT control

The same ten segments, fetched **on the host** from our own gateway: **24–66 ms, median 44 ms**,
against the public gateway's ~1,110 ms for the identical bytes. **25x.** That is what established the
public gateway as the instrument rather than the network.

### ⛔ What this run could NOT measure

**Sustained playback.** This browser keeps pausing the media element: the playhead advanced 1.9s in
26s, with 2 stall events, while a `play()` loop fought it. **A realtime ratio taken here is a number
about the harness.** Buffer-ahead never exceeded 0.5s, which is _consistent with_ the prefetch
pipeline not staying ahead, but is not separable from the pausing. **Step 4 in a real browser is now
the priority**, and it is still free.

---

## 5c. ✅ STEP 3 RUN: the distribution at n=500, and what the tail actually is

**2026-08-09.** Raw data `docs/bench/in-browser-service-time-2026-08-09.tsv`, harness
`deploy/scripts/in-browser-service-time.js`. Cost: **0.0019231 BZZ**, all of it the gateway control.
The browser node is unfunded and cost nothing.

### The one design choice that decides whether the number means anything

**Measured on the weeb-3 app shell, not on a stream page.** The app shell boots and connects the node
but attaches no stream, so **nothing is prefetched**. Section 5b measured on a stream page with the
player running, which is why nine of its eighteen samples came back in 2–9 ms and made the
distribution look bimodal. Those were cache hits, not retrievals.

Segments were fetched **sequentially** through `/weeb-3/hls/bytes/<ref>`, so nothing queues behind
anything else. Peer count was watched rising **143 → 200** and the run began at `Connected: 200,
Connecting: 0`, so the warm state is an observed transition rather than a value that started
satisfied. Idle time between consecutive fetches was **p50 0 ms, max 18 ms**, so the recorded
milliseconds are wall time and the page was never throttled mid-run.

### [OBSERVED] The distribution, n=500 cold, our own 0.266s / ~93 KB segments

| statistic |        ms |
| --------- | --------: |
| min       |   **784** |
| p10       |       792 |
| p25       |       797 |
| **p50**   |   **807** |
| p75       |       980 |
| **p90**   | **1,186** |
| p99       |     1,581 |
| max       |     2,184 |

⛔⛔ **The crossing rate is 100%. All 500 of 500 segments took longer than their own 266 ms**, and the
**fastest one was already 3x over**. Section 5b's 27.8% was measuring a sample half made of cache hits.

⛔ **The p90 of 2,771 ms from n=18 was an artifact.** At n=500 the p90 is **1,186 ms**. That is the
gap between a tail statistic and the sample size a tail statistic needs.

### ⭐⭐ The warm control is what makes this a measurement rather than a number

|                                         |        p50 |
| --------------------------------------- | ---------: |
| cold (n=500)                            | **807 ms** |
| **warm re-fetch of the last 40** (n=40) |   **1 ms** |

**800x.** Full ~90 KB bodies, HTTP 200, served from the node's local store.

⭐ **Last session a warm re-fetch cost exactly what a cold one cost, and that killed a published
figure.** Here the same control does the opposite job: it proves the ~790 ms floor **is retrieval**,
and that the service worker hop, the WASM boundary and the 90 KB copy together cost **single-digit
milliseconds**. An `/hls/bytes/` versus `/bytes/` route arm (20 each, alternating, matched) agreed
within noise, so the routing machinery is not the floor either.

### ⭐⭐⭐ The tail is QUANTISED. It is retry rounds, not slow peers.

25 ms bins, and the **valleys are empty**, which a smooth tail cannot produce:

| bin  | count |     | bin       | count |
| ---- | ----: | --- | --------- | ----: |
| 775  |   158 |     | 1050–1075 | **0** |
| 800  |   160 |     | 1150      |     7 |
| 900  |     2 |     | 1175      |    26 |
| 950  |    22 |     | 1450–1550 | **0** |
| 975  |    60 |     | 1575      |     2 |
| 1000 |     3 |     | 1700–1900 | **0** |

Fitting `base + k x step` over steps from 120 to 320 ms picks **step = 194 ms**, mean residual
**15.5 ms** against **48.5 ms** expected if the times bore no relation to any ladder. The winner sits
well inside the scanned range rather than at a bound, so the scan is not imposing its own answer.

Predicted modes 790 / 984 / 1178 / 1372 / 1566 / 1954 against observed 790 / 975–1000 / 1175 /
1350–1375 / 1575 / 1925.

### ⭐⭐⭐ And weeb-3's source names the mechanism exactly

⛔ **First, a correction to this document's own plan.** Section 8 rule 5 said "weeb-3 logs enough to
separate them". **It does not.** All 33 `interface_log` call sites are connection, refreshment and
service-worker events. **There is no per-chunk logging at all**, so the not-found / slow-peer / retry
/ erasure classification the plan called for cannot be done from logs. It can be done from the shape
of the distribution plus the constants, which is what follows.

In `retrieval.rs`, when `select_retrieve_peer` can find **no eligible peer**, because every candidate
is either already tried (`skiplist`) or **unaffordable (`overdraftlist`)**:

```rust
if !overdraftlist.is_empty() { reset_overdraft(&mut skiplist, &mut overdraftlist); }
async_std::task::sleep(Duration::from_millis(RETRIEVE_CHECK_RETRY_WAIT_MS)).await;
continue;
```

`RETRIEVE_CHECK_RETRY_WAIT_MS = 160`. **A 160 ms sleep plus per-round work is the 194 ms ladder step.**
`overdraftlist` is accounting, so **the ladder is the unfunded node waiting out its own credit
exhaustion.** That is the browser-side face of what our light versus ultra-light sitting measured on
bee as a funded node asking one peer where an unfunded one asks many.

| constant                            |  value | what it sets                                                   |
| ----------------------------------- | -----: | -------------------------------------------------------------- |
| `RETRIEVE_CHECK_CONFIRMATION_PEERS` |  **6** | ⛔⛔ peers that must confirm **every chunk**, by design        |
| `RETRIEVE_DATA_GROUP_CONCURRENCY`   |      8 | chunks in flight, so ~25 chunks is ~4 rounds = the 790 ms base |
| `RETRIEVE_CHECK_RETRY_WAIT_MS`      |    160 | the ladder step, on the overdraft path                         |
| `RETRIEVE_ATTEMPT_TIMEOUT_MS`       | 10,000 | what a miss costs before it gives up                           |
| `RETRIEVE_HEDGE_AFTER_MS`           |  1,000 | duplicate request after a second                               |

### ⛔⛔ A miss costs 13.5 seconds, and that kills read-ahead

20 references that do not exist, **all 20 returned HTTP 503**, between **11,679 and 14,474 ms**,
median **13,503 ms**. `RETRIEVE_ATTEMPT_TIMEOUT_MS = 10_000` is why.

⭐ Against the **~480 ms** a bee gateway takes for a not-found, this is **28x worse**. The announcement
floor work concluded that read-ahead by N costs N misses linearly. **In a browser node each of those
misses costs 13.5 seconds**, so speculative fetching is not merely expensive here, it is disqualifying.

### The gateway control, run on the host

|                                       |        p50 |
| ------------------------------------- | ---------: |
| our funded bee, **on the host**, n=40 |  **41 ms** |
| browser node, unfunded, this laptop   | **807 ms** |

⚠️ **Named honestly: this is not a clean funded-versus-unfunded comparison.** The two sit on different
machines and different network paths, and the gateway is in a datacentre. What it does establish is
that **the content is there and is cheap to fetch**, so the browser node's 807 ms is not the content
being slow. Attributing the gap to funding needs a funded light node on this same laptop, which is
step 4's proper design.

The control also re-confirmed the cost model: 3.72 MB for **0.0019231 BZZ = 0.000517 BZZ/MB**, against
the settled 0.000678.

### ⛔⛔ What this does to the throughput arithmetic

A 0.266 s segment stream needs **3.76 segments per second**. Measured:

| concurrency                                 | segments/s | versus realtime |
| ------------------------------------------- | ---------: | --------------: |
| 1 (measured directly)                       |       1.24 |       **0.33x** |
| 3 (`HLS_PREFETCH_BODY_MAX_PARALLEL`) at p50 |       3.72 |       **0.99x** |
| 3 at the p90                                |       2.53 |       **0.67x** |

⛔ **At its own configured concurrency, a browser node lands at 0.99x of realtime at the median and
0.67x at the p90.** There is no headroom whatsoever, on an idle laptop, with a full 200-peer table,
with no video decoding running, on the 2.86 Mbps profile this document already picked as the one that
fits. **1080p/6000k is not a close call.**

### ⭐⭐⭐ The structural finding: a browser node is a pure consumer

weeb-3 creates seven libp2p control handles and calls `.accept()` on exactly **two** of them:

```rust
incoming_pricing_streams = ctrl0.accept(PRICING_PROTOCOL).unwrap();
incoming_gossip_streams   = ctrl1.accept(GOSSIP_PROTOCOL).unwrap();
self.interface_log("Node protocol listeners ready".to_string());
```

**It never accepts inbound `/swarm/retrieval/1.4.0/retrieval`, pushsync or swap.** The other five
handles are cloned into outbound request paths only.

⛔⛔ **So 20,000 browser viewers are 20,000 takers and zero givers.** They add no serving capacity and
no cache capacity to the network. Every chunk they consume is drawn from the storer neighbourhood, and
each one asks **six peers per chunk** to confirm it. Combined with the loss of gateway pooling from
section 6, the demand a browser audience puts on storers is **larger than the same audience behind
gateways by roughly three orders of magnitude**, not smaller.

### ⛔ What this run still could NOT measure

- **Sustained playback**, unchanged from 5b. This measures retrieval, not a playhead.
- **Funded versus unfunded on equal footing.** The gateway control is confounded by machine and
  location, deliberately, because a viewer really does sit on a laptop.
- **Whether the ladder is worse under a herd.** Every fetch here was alone.

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

### ⛔ Architecture is NOT decided here

The owner holds a separate full architecture plan and a separate project for the higher-scale
simulation. **This repository measures at current scale and hands over parameters.** What follows is
that handover, not a design.

---

## 7b. ⭐⭐ What to feed the higher-scale simulation project

This is the deliverable for the other project. Everything below is a number this repository has
actually measured, with the statistic it must be used as.

### a) The per-viewer demand model — drive it in REQUESTS, not bytes

⛔ **Bytes per second is the wrong primitive.** Two streams with identical bitrates put completely
different loads on the network depending on fragment length, because service time has a large
per-request component.

| profile           | fragment | segment size | **requests/s per viewer** |    bytes/s |
| ----------------- | -------: | -----------: | ------------------------: | ---------: |
| 2.86 Mbps, 0.266s |   0.266s |        95 KB |                  **3.76** |   357 KB/s |
| 2.86 Mbps, 1.0s   |     1.0s |       357 KB |                  **1.00** |   357 KB/s |
| 8.5 Mbps, 4.17s   |    4.17s |      4.43 MB |                  **0.24** | 1,064 KB/s |

**Same bitrate, 3.76x the request rate.** A simulator driven on bytes cannot see that.

### b) The service-time distribution — feed it a DISTRIBUTION, never a mean

⛔⛔ **Every failure we have found hid inside a mean.** Measured service times, all from this
repository:

| path                              | shape                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **browser node, 95 KB segment**   | ⭐ **n=500: min 784 / p50 807 / p90 1,186 / p99 1,581 / max 2,184 ms.** Do NOT model this as a smooth distribution: it is **base 790ms + k x 194ms**, a quantised retry ladder with empty valleys between the modes. Sampling from a fitted lognormal will understate the modes and invent values that never occur |
| **browser node, local cache hit** | **1 ms.** The node serves anything it already holds essentially free                                                                                                                                                                                                                                               |
| **browser node, not-found**       | ⛔ **11.7–14.5 s, median 13.5 s** (`RETRIEVE_ATTEMPT_TIMEOUT_MS = 10_000`). 28x a bee gateway's miss                                                                                                                                                                                                               |
| **feed slot, hit**                | 1–2 ms                                                                                                                                                                                                                                                                                                             |
| **feed slot, miss** (not-found)   | **~426–480 ms**, and **~45% of live-edge reads are misses**                                                                                                                                                                                                                                                        |
| **our gateway, warm, 95 KB**      | 24–66 ms, median 44                                                                                                                                                                                                                                                                                                |
| **public gateway, 95 KB**         | ~1,110 ms — **instrument, not network. Do not use**                                                                                                                                                                                                                                                                |
| **public gateway, 4.4 MB**        | 4.7–6.8 s                                                                                                                                                                                                                                                                                                          |

⭐ **A miss costs ~480ms and ZERO BZZ.** Speculative reads are free in money and expensive in time,
and read-ahead by N costs N misses, linearly.

### c) The structural parameter that dominates everything: sharing

| viewer class         | chunk fetches for N viewers of the same chunk             |
| -------------------- | --------------------------------------------------------- |
| **behind a gateway** | **1.** Measured: 16 viewers cost the network what 1 costs |
| **in-browser node**  | **N.** No shared fetch exists                             |

**Model this as an explicit sharing factor per viewer class.** It is the single largest lever in the
whole simulation: at 20,000 viewers it is the difference between ~160 retrievals and 20,000.

### c2) ⛔⛔⛔ Browser nodes are DEMAND ONLY. Do not model them as network participants.

This is the parameter most likely to be got wrong, because "peer-to-peer" implies mutual aid and here
there is none. **[SOURCE]**

| parameter                             | value                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| inbound protocols a browser accepts   | **pricing and gossip only.** Never retrieval, pushsync or swap                     |
| chunks a browser node serves to peers | **zero, structurally**                                                             |
| cache it contributes to the network   | **zero.** Also no persistent state across sessions                                 |
| **peers asked per chunk**             | ⛔ **6** (`RETRIEVE_CHECK_CONFIRMATION_PEERS`), a confirmation quorum, not a retry |
| chunks in flight per retrieval        | 8 (`RETRIEVE_DATA_GROUP_CONCURRENCY`)                                              |
| **peer requests per 95 KB segment**   | ⛔ **~150** (~25 chunks x 6 confirmations)                                         |

**So a browser audience is a pure load multiplier on the storer neighbourhood.** Model N viewers as
N x 150 peer requests per segment period, with **no** term for browser-side supply, and **no** decay
from browsers caching for each other. If the simulation shows browser nodes relieving the network, the
model is wrong.

⚠️ The counterfactual worth simulating alongside it: **a browser node that did accept retrieval.** That
single protocol change flips the sign of the whole model, and knowing how much it would help is
exactly the kind of question a simulator answers better than a measurement.

### d) Arrival-time distribution is a first-class input, not a detail

- **128 viewers on one tick drain 12.8s of buffer. The same 128 in cohorts of 8 are comfortable.**
- Crossing rate ≥1s: **0.42% synchronised against 0.065% spread, 6.4x**, while the medians are
  identical (462–482 vs 463–482 ms).
- ⛔ **What limits a server is how many viewers want the SAME CHUNK at once**, not the instant they
  arrive. We shipped client jitter on the wrong reading of that once and measured it doing nothing.

### e) Client-side concurrency ceilings (weeb-3, from source)

A browser viewer is a **bounded** request engine, not an open tap:

| constant                                 |                        value |
| ---------------------------------------- | ---------------------------: |
| `HLS_PREFETCH_BODY_MAX_PARALLEL`         |                        **3** |
| `MEDIA_PREFETCH_MAX_PARALLEL`            |                            4 |
| `CONNECTION_BUILDUP_LIMIT` (peers)       |                      **200** |
| `HLS_LIVE_SYNC_SEGMENTS`                 |                            8 |
| `maxBufferLength` / `maxMaxBufferLength` | 90s / 120s (30/60 at ≤2 GiB) |

**A viewer's sustainable rate is `parallelism / service_time`.** At p50 that is 3/0.246 = 12.2
requests/s. At p90 it is 3/2.771 = **1.08 requests/s**, below the 3.76/s the 0.266s profile needs.

### f) Things the simulator can treat as free or flat

- **Feed reads do not scale with audience.** 128 concurrent readers cost what one costs; every loaded
  arm sits inside the spread four single-reader references show with nothing happening.
- **Publishing is independent of audience size.**
- **Not-found reads cost no BZZ.**
- **Segment cost is flat at 0.000678 BZZ/MB across an 8.5x segment-size range**, with no GOP premium.

### g) Validation targets — the sim should reproduce these before anyone trusts it

1. **128 concurrent viewers hold behind one gateway; 192 fail.** Throughput plateaus at **43–44 MB/s**
   even with the cohort held at 8.
2. **16 viewers cost the network what 1 costs.**
3. **A feed read at 128 readers costs what it costs at 1.**
4. **A cold gateway costs 2–3x for ~2 minutes**, and no readiness signal goes green late enough to
   predict it.
5. **Cache is a dial, not a gate**: a smooth curve from 4% removed at 0.24x the hot set to 37% at
   3.8x, with no step anywhere. Units are **chunks**, not bytes (1 GB ≈ 280,000).

### h) ⛔ What the simulation must NOT assume

- **That throughput is a constant KB/s.** It is not, and a warm-cache control proved it here the same
  day the number was written down.
- **That the median predicts failure.** It does not. Every real failure we have found was visible only
  in a **rate of crossing** a threshold.
- **That unfunded behaves like funded.** A bee node that cannot settle **asks 38 peers where a funded
  one asks 1** and is skipped ~37x per chunk. ⚠️ **Every browser viewer is unfunded**, but that figure
  came from bee's counters on a bee node and has **not** been shown to apply to weeb-3.
- **That a gateway result transfers to a browser node.** All of our capacity numbers are
  gateway-side.

### i) ⛔⛔ The one thing only the other project can answer

**What happens at a storer neighbourhood when thousands of unfunded nodes ask it for the same chunk
inside the same second.** Everything this repository has measured sits on the viewer side of a gateway
or the publisher side of the network. **That question decides the event, and nothing here can reach
it.** Suggested shape: sweep N viewers against one chunk address with the arrival distribution from
(d), and report the crossing rate rather than the mean.

## 8. The plan, rewritten by what step 1 found

⛔ **The original plan's step 1 is done and it moved the open questions.** What follows replaces it.
Ordered so that **everything that can kill the idea runs before anything that spends**. Only step 6
needs broadcast minutes.

Each row names **the statistic** and **the n** it needs, because the whole point is precision and
every one of these questions has a shape where a small sample lies.

| #     | question, stated so it can be answered wrong                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | statistic and n                                                                                                                                                 | why it is next                                                                                                                                                            | cost                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **1** | ~~Does our own stream shape fix it?~~ ✅ **DONE.** `readyState 4` at 5s vs 167s                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —                                                                                                                                                               | —                                                                                                                                                                         | done, free                                                                   |
| **2** | **Can a browser viewer SUSTAIN 2.86 Mbps?** Playhead advance per wall second, over ≥10 minutes, in a real browser that does not pause background media                                                                                                                                                                                                                                                                                                                                                                              | **realtime ratio** ≥ 0.999, plus **stall count** and **stall seconds**. One 10-minute run, then two more                                                        | ⛔ **This is the blocker on every throughput claim we have.** Today's harness paused the element, so the question is completely open                                      | free                                                                         |
| **3** | ~~What IS the service-time tail, and what causes it?~~ ✅ **DONE, section 5c.** n=500: p50 **807ms**, p90 **1,186ms**, crossing rate **100%**. The tail is a **quantised 194ms retry ladder** on the overdraft path, not slow peers. A miss costs **13.5s**                                                                                                                                                                                                                                                                         | —                                                                                                                                                               | ⛔ The plan said "weeb-3 logs enough to separate them". **It does not** — there is no per-chunk logging at all. The distribution plus the constants did the job instead   | done, 0.0019 BZZ                                                             |
| **4** | **Does the 38x unfunded amplification carry to weeb-3?** ⭐ **Source already sets a floor: `RETRIEVE_CHECK_CONFIRMATION_PEERS = 6`, six peers per chunk by design.** What is open is what the overdraft ladder adds on top of that                                                                                                                                                                                                                                                                                                  | requests **per distinct chunk**, a **funded** against an **unfunded** node **on the same laptop**, so machine and location stop being confounds. n ≥ 200 chunks | ⛔⛔ Still the highest-value number, but narrower now: the structural 6x is settled, the accounting multiplier is not                                                     | free                                                                         |
| **5** | **Which fragment profile does a browser node actually prefer?** Three forces now point two ways                                                                                                                                                                                                                                                                                                                                                                                                                                     | **A/B/A alternating**, same content at 0.266s and 1.0s, ≥ 300 segments per arm. Report crossing rate, not median                                                | ⛔ `HLS_LIVE_SYNC_SEGMENTS=8` favours 0.25s; per-request cost and `MAX_PARALLEL=3` favour 1.0s; our own campaign favours 1.0s. **Nothing resolves this but a direct A/B** | free                                                                         |
| **6** | **Does service time degrade when N browsers want the SAME chunk?**                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | crossing rate at N = 1, 2, 4, 8, alternating arms, ≥ 200 requests per arm                                                                                       | The herd question with **no gateway to absorb it**. The closest we can get to the storer-side question from here                                                          | free                                                                         |
| **7** | **Does it run on mobile at all?** ✅ **The blocking contradiction is SETTLED from source.** The runtime does not use a Shared Worker: `worker.js` is a `self.onconnect` SharedWorker entry point for the **old `Weeb3` class** and **nothing instantiates it**. `Weeb3No103` runs on the main thread, which is why the README lists Chrome and Firefox on Android. Confirmed live: `crossOriginIsolated` is **false** and `SharedArrayBuffer` is **undefined** on the public deployment, with zero references to it in the built JS | boolean, then time-to-playable on one Android and one iOS device                                                                                                | ⚠️ Source removes the objection but **does not prove mobile works**. A 4.15 MB WASM payload and a 200-peer WebSocket table on a phone still need a device                 | free                                                                         |
| **8** | ~~Is a segment one retrieval or twenty-four?~~ ✅ **ANSWERED from source and timing.** ~25 chunks, fetched **8 at a time** (`RETRIEVE_DATA_GROUP_CONCURRENCY`), each confirmed by **6 peers**, so **~150 peer requests per 95 KB segment** and ~4 rounds, which is the 790 ms base                                                                                                                                                                                                                                                  | —                                                                                                                                                               | ⭐ This is the mechanism behind step 5: fragment size changes the round count, not the per-chunk cost                                                                     | done, free                                                                   |
| **9** | **Live, against our own publisher.** Only after 2-8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | crossing rate and lag-behind-live, both profiles                                                                                                                | The only question that needs a live edge                                                                                                                                  | ⚠️ **broadcast minutes. Price in bytes and bring the number before booking** |

### ⭐ What "precise" requires here, learned the hard way today

1. **Name the instrument's contribution before trusting a number.** The warm re-fetch control cost
   nothing and killed a headline figure an hour after it was written. **Every new instrument gets a
   null or warm control before its first real reading.**
2. **n for a tail is not n for a median.** A p90 needs hundreds, not eighteen. Say the n beside the
   percentile or do not quote the percentile.
3. **Alternate arms, never ladder them**, and put a replicate of the **failing** arm in the budget.
4. **One question per sitting.** Today's session answered "is the content the problem" cleanly
   precisely because nothing else varied.
5. **Classify the tail, do not just measure it.** A tail with four different causes cannot be
   optimised. ⛔ **This rule originally said "and weeb-3 logs enough to separate them", which was
   false** — all 33 `interface_log` sites are connection and accounting events and none are per-chunk.
   What actually classified the tail was the **shape of the distribution** (quantised, with empty
   valleys) read against the **constants in the source**. When an instrument does not exist, the
   arithmetic of the result can still name the mechanism.
6. **A grep that anchors on layout under-reports.** Searching for `interface_log(format!("` found 14
   messages and missed 19, because the format string is often on the next line. The smaller answer
   looked complete and nearly became "weeb-3 does not log retrieval at all".

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
