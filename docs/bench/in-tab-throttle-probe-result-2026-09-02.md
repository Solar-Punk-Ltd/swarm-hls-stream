# The capped in-tab probe: a morning reading that was the instrument, and the evening that showed it

> ⛔⛔⛔ **Retracted the same day.** Everything from here down to "The arms, run the same evening" is
> the morning's reading of our client on weeb-3 `0.0.329001` under Chrome's
> `Network.emulateNetworkConditions`. The same release, client, recording and driver under a real `tc`
> link reads 360p in 1.0 s at 1.1 bytes per payload byte with the link 70% full, against the 3.4 to
> 4.2 s, 2x and half-idle link below. The headline was the emulation, not the node. The morning's
> sections are kept as written, for the record of what that instrument produced. The evening's
> sections carry the readings that stand.

> **Owner's correction, the same afternoon.** This run measured **our client**, driving **our pinned
> weeb-3 `0.0.329001` of 10 August** (twelve releases behind Abel's `0.0.341001`), under **Chrome's
> emulated slow connection**. Abel's latest weeb-3 plays streams well above this bitrate, so weeb-3 is
> not the suspect and is not to be changed. The mistake is on our side, in the harness, the toolset,
> the pin or the client, and the next three arms find which: Abel's own player under the same
> emulated cap, a real shaped link instead of the emulation, and our client on `0.0.341001`. Read
> every figure below as a reading of that one combination and nothing more.

**2026-09-02, measured on manager-host, 0 BZZ.** One run of `pnpm browser:in-tab-throttle-probe`
against the shipped client at build `dd21a1e`, Chrome 151, the recording of sitting five. Plan:
[`in-tab-throttle-probe-prediction-2026-09-02.md`](in-tab-throttle-probe-prediction-2026-09-02.md),
written before the driver existed. Artifact:
`in-tab-throttle-probe-2026-09-02T07-30-38-148Z.{md,json}` beside this file, with the sampled frame
log in `.requests.json` on the host under `~/swarm-hls-bench/docs/bench/`.

19 retrievals, 19 distinct references, every canary landed, nothing hit its budget, and the cost
bracket read every node's chequebook and batch unchanged.

## The headline, in three numbers

| | uncapped | capped at 2800 kbps |
| --- | ---: | ---: |
| bytes the node pulled per byte of segment, while the retrieval ran | **1.09 to 1.13** | **1.92 to 2.00** (360p), **2.33 to 2.87** (1080p) |
| more bytes arriving in the 10 s after the segment was complete | 6% to 33% of the segment | **another 0.65 to 1.16 segments' worth** |
| how full the capped link was while the retrieval ran | | **31% to 51%** |

Uncapped, a 360p segment took 0.1 s and a 1080p segment 0.4 s, about 2.9 MB/s. Capped at 350 KB/s,
the same node delivered **54 to 71 KB/s of segment**, one fifth of what the link allowed, and a
1080p segment took 16.5, 18.1 and 19.6 s against a 3.3 s link minimum, each within four seconds of
the 20 s at which hls.js abandons a fragment.

## Part A, idle: the background is not the cause

| window | mean inbound | connections |
| --- | ---: | ---: |
| unthrottled, opened at the first peer | 48,534 B/s | 13 → 200 |
| capped at 2800 kbps | 2,064 B/s | 200 → 200 |
| capped at 700 kbps | 2,024 B/s | 200 → 200 |

⚠️ The first window is the **join**, not the background. Its per-second series reads 121, 597, 784,
546, 519 and 147 KB/s in its first six seconds while the connection count climbed from 13 to 200,
then single-digit KB/s bursts. The driver opened the window the moment `ready(1)` returned, which is
the first peer, and that is a design fault recorded below. Once settled the node takes about
**2 KB/s**, under 1% of the 2800 kbps cap and 2.3% of the 700 kbps one.

**H2 is refuted.** The pre-registered threshold for it to be the cause was 105,000 B/s. Observed
2,064.

**H0 holds.** Idle inbound under the 700 kbps cap stayed at 2,024 B/s against the 87,500 that cap
allows, and no capped row ever exceeded its cap: the highest occupancy in the run was 51%. The cap
reaches the WebSocket transport, and the uncapped rows running at 2.9 MB/s beside capped rows that
never passed 350 KB/s is the stronger half of that proof.

## Part B, one fragment at a time

| round | arm | cap | outcome | inbound during | out frames | inbound in the 10 s after | ×payload | of the cap |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | canary | uncapped | 0.1 s, 224,848 bytes | 250,192 | 251 | 48,290 | 1.11 | — |
| 0 | 360p | 2800 kbps | 3.4 s, 222,968 bytes | 427,272 | 612 | 203,085 | 1.92 | 36% |
| 0 | 1080p | 2800 kbps | 16.5 s, 1,163,720 bytes | 2,705,805 | 4,879 | 1,350,367 | 2.33 | 47% |
| 0 | 360p | uncapped | 0.1 s, 224,096 bytes | 250,176 | 271 | 40,644 | 1.12 | — |
| 0 | 1080p | uncapped | 0.4 s, 1,148,492 bytes | 1,255,054 | 1,521 | 348,446 | 1.09 | — |
| 1 | canary | uncapped | 0.1 s, 223,720 bytes | 249,588 | 280 | 14,627 | 1.12 | — |
| 1 | 1080p | uncapped | 0.4 s, 1,209,780 bytes | 1,322,126 | 1,589 | 12,785 | 1.09 | — |
| 1 | 360p | uncapped | 0.1 s, 215,260 bytes | 242,237 | 305 | 13,398 | 1.13 | — |
| 1 | 1080p | 2800 kbps | 18.1 s, 1,154,508 bytes | 3,088,715 | 5,100 | 1,051,198 | 2.68 | 49% |
| 1 | 360p | 2800 kbps | 4.2 s, 225,224 bytes | 449,785 | 866 | 252,957 | 2.00 | 31% |
| 2 | canary | uncapped | 0.3 s, 225,224 bytes | 250,633 | 311 | 23,119 | 1.11 | — |
| 2 | 360p | 2800 kbps | 4.0 s, 233,308 bytes | 463,747 | 812 | 209,639 | 1.99 | 33% |
| 2 | 1080p | 2800 kbps | 19.6 s, 1,210,908 bytes | 3,476,433 | 5,264 | 786,844 | 2.87 | 51% |
| 2 | 360p | uncapped | 0.1 s, 229,360 bytes | 255,395 | 276 | 18,246 | 1.11 | — |
| 2 | 1080p | uncapped | 0.4 s, 1,185,152 bytes | 1,292,446 | 1,463 | 377,432 | 1.09 | — |

Arms alternated order each round. The rows replicate: three capped 360p rows within 0.8 s of each
other, three capped 1080p rows within 3.1 s, and every uncapped row of a size within 0.1 s of its
siblings. The capped 1080p rows also drift upward round on round, 16.5 → 18.1 → 19.6 s, which is
one run's hint and not a trend.

### What the columns say

- **Outbound request frames** under the cap are 2.5 to 3.4x the uncapped count for the same size
  (612 to 866 against 251 to 311 for 360p, 4,879 to 5,264 against 1,463 to 1,589 for 1080p). The
  node asked for far more than it needed.
- **Inbound during** is 1.9 to 2.9x the segment under the cap against 1.1x uncapped. The 1.1x is the
  protocol's own framing, and everything above it is chunks delivered more than once.
- **The tail** carries nearly a whole extra segment after the segment was already complete, under the
  cap, and a few percent uncapped. Those are the hedged attempts still answering. In a live viewer
  they land on the link while the next fragment is being asked for.
- **Occupancy** never passed 51%. The link was half empty while the node took five to six times the
  link time to finish.

## Part C, two at once

| round | arm | outcome | inbound during | out frames | inbound in the 10 s after | ×payload | of the cap |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | pair | 9.1 s, 210,560 bytes | 1,145,011 | 2,787 | 1,283,979 | 5.44 | 36% |
| 0 | pair | 6.4 s, 230,676 bytes | 714,048 | 2,274 | 1,712,002 | 3.10 | 32% |
| 1 | pair | 6.4 s, 214,884 bytes | 685,548 | 2,247 | 1,710,544 | 3.19 | 31% |
| 1 | pair | 8.8 s, 230,112 bytes | 1,086,169 | 2,724 | 1,311,973 | 4.72 | 35% |

Read together, since two rows on one link each count the other's bytes: pair 0 pulled 1,145,011
bytes over 9.1 s against 441,236 bytes of segments, **×2.60**, link at 36%. Pair 1: 1,086,169 over
8.8 s against 444,996, **×2.44**, link at 35%.

⭐⭐ **Two at once is worse than one after the other.** Alone, a capped 360p took 3.4 to 4.2 s, so
two in sequence would take about 7.6 s. Started together the slower of the two took 8.8 and 9.1 s,
and the pair left **1.3 to 1.7 MB** arriving in the ten seconds after it finished, three to four
times the two segments' combined size. Sitting five's viewer had three 360p retrievals overlapping
plus a 1080p in flight when the cap landed. On a 350 KB/s link, several megabytes of late duplicates
are ten or more seconds of the link carrying nothing a viewer will see, ahead of every new request.

## The pre-registration, against what was observed

| | predicted | observed | |
| --- | --- | --- | --- |
| **H1** hedge amplification | capped 360p at 3.0 or more, uncapped 1.0 to 1.3 | capped **1.92 / 1.99 / 2.00** during plus **0.9 to 1.1 more** in the tail, uncapped 1.11 / 1.12 / 1.13 | **confirmed in kind, below the in-window figure predicted** |
| **H2** idle background load | 105,000 B/s or more if it is the cause | 2,064 B/s settled | **refuted** |
| **H3** accounting exhaustion (amended 5e0558e) | link mostly idle, rejections when it answers. Under H1 the link is full | link **31% to 51%**, **0 of 10** capped rows rejected | **neither prediction as written** |
| **H0** the instrument | idle under 700 kbps at or under 87,500 B/s | 2,024 B/s, no row above 51% of its cap | **holds** |

⛔ **The strict H1 prediction failed and I am recording that rather than moving the goalposts.** I
wrote "at least 3.0" for the bytes arriving while a capped 360p retrieval ran, and the run read
1.92 to 2.00. Counting the tail the node pulls about three segments' worth per segment, but the tail
was not what the prediction named.

## What the run says, and what it only suggests

**Measured.** Under a bandwidth cap the in-tab node asks for two to three times the chunks it needs,
receives two to three segments' worth of bytes while a segment loads and about one more afterwards,
completes at a fifth of the link's capacity, and leaves the link half idle while doing so. Two
concurrent retrievals compound it. None of this happens uncapped, where the same node runs at
2.9 MB/s with 9% to 13% framing overhead.

**Inferred, and labelled so.** The duplicates are the one-second hedge in `retrieve_chunk`: every
chunk unanswered for a second is asked of the next peer, up to twenty, and nothing calls the losers
off (`RETRIEVE_HEDGE_AFTER_MS`, `RETRIEVE_ATTEMPT_TIMEOUT_MS`, read in
[`in-tab-throttle-probe-prediction-2026-09-02.md`](in-tab-throttle-probe-prediction-2026-09-02.md)).
The half-idle link is not explained by duplicates alone: with twice the bytes on a full link a
capped 360p would take 1.3 s, and it took 3.4 to 4.2 s. The reading most consistent with a half-idle
link, request frames continuing every second and no rejections is the amended H3 acting as a
consequence of H1: each hedge reserves the chunk's price at a peer before asking, hedges under a
cap pile reservations on the closest peers until they refuse, and the node then cycles its overdraft
list waiting for allowance that refreshes once a second per peer. The node exposes no counter that
would show that directly, so it stays an inference. A hedge that stopped fanning out on a
bandwidth-limited link would test both at once, and the test is this probe run again.

## Design faults of this run, for the next one

1. **The unthrottled idle window opened at the first peer.** It measured the join. The driver should
   wait for the connection count to stop growing before Part A, or read the settled minutes only.
2. **Sitting five's shape is not in the run.** Its cap landed while a 1080p fragment was in flight
   and the 360p requests came after. A Part D that starts a 1080p uncapped, applies the cap
   mid-flight, then asks for a 360p, replicates that order exactly. Still free.
3. **The kept frame log is a one-in-five sample.** `MAX_LOGGED_FRAMES` is 20,000 and the run made
   about 95,000. Every figure in the tables was computed over the full stream before thinning, so
   nothing above is affected, but a per-second reading taken from the `.requests.json` afterwards is
   indicative only.

## What this cannot say

- **Which peers, or how many attempts.** yamux frames are not one to one with attempts. Bytes per
  segment byte does not need them.
- **Whether a fix works.** That needs the fix, and then this probe, which costs nothing.
- **The live edge.** VOD references through the identical retrieval path. Part C approximates a live
  viewer's overlap and does not reproduce hls.js's abandon-and-retry loop on top of it.
- **n=1 run.** Three rows per arm inside it replicate tightly, but one afternoon on one host.

## What it means for V2, as written that morning

The morning's conclusion was that a capped in-tab node cannot supply the cheapest rung. The evening's
arms below showed that conclusion to be a property of the cap instrument. The verdict that stands is
under "What this means for V2" at the end of this document.

## The arms, run the same evening: three contracts of ours, and two void readings

Every arm below cost 0 BZZ. The client under test moved from weeb-3 `0.0.329001` (the morning's pin)
to `0.0.341001` (the latest release) during the evening, and the harness that measures it turned out
to have mistakes of exactly the kind the owner named.

### Three things the latest weeb-3 expects that our side did not provide

1. **A broadcast whose first segment is number 0.** Abel's player rebuilds a recording from the whole
   feed history and refuses unless the oldest update starts at `#EXT-X-MEDIA-SEQUENCE:0`. SRS keeps
   its segment counter across broadcasts of the same stream name while it runs, and our uploader
   publishes those numbers as they are, so the six ladder recordings of sitting five start at 210,
   317, 416, 580, 707 and 850, and his page opened none of them. After `docker restart
   latbench-srs-1` the next recording started at 0 and his page opened it in 4 to 5 s. A product
   decision for the owner: renumber each broadcast from 0 in the uploader, or leave it.
2. **The runtime served from our own origin.** From `0.0.341001` the node lives in a SharedWorker
   the package loads from `/weeb-3/worker.js`, and a SharedWorker script must be same-origin. Our
   nginx answered that path with the app's index, so the node never booted ("SharedWorker request
   timed out"). Fixed the same evening: the client now copies and serves `worker.js`, `weeb_3.js`,
   `weeb_3_bg.wasm`, `snippets/` and `service.js` under `/weeb-3/`, and on the stage the node joined
   the network in 833 ms.
3. **A secure context.** The glue registers a ServiceWorker at boot, and `navigator.serviceWorker`
   does not exist on a plain-http page reached by IP or hostname. The stage client is plain http on
   port 10074. Loopback counts as secure, which is why the boot check at `127.0.0.1` passed and the
   own-network probe at `host.docker.internal` died with "could not install ServiceWorker relay
   listener". A production deployment serves the client over https. The harness launches Chrome with
   `--unsafely-treat-insecure-origin-as-secure` for the one client origin.

### Arm 3 as run is void, and the reason is a harness fault: Chrome's emulated cap never reaches a SharedWorker

`in-tab-throttle-probe-2026-09-02T10-53-22-247Z.md`, our client on `0.0.341001`, the same recording,
the same `Network.emulateNetworkConditions` cap of 2800 kbps (350,000 bytes/s). Every capped 360p row
resolved in **0.1 s** for about 225 KB and every capped 1080p row in **0.3 to 0.4 s** for about
1.2 MB. At that cap the physical minimum is **0.64 s and 3.3 s**. The cap was applied to the page's
CDP session, and on this build the node's sockets belong to the worker target, which the page session
does not throttle. Two more instrument facts from the same report:

- every byte and frame column reads **0**, because the recorder listens to page sockets only.
- the report's H0 check declared "holds" on that zero. A blind instrument passed as a healthy one.
  The check has to refuse a zero, and the harness fix in progress makes both the cap and the recorder
  attach to worker targets and prove themselves by effect on every run.

So the pre-registered reading for arm 3, "a capped 360p in 1.5 s or less means the pin was our
mistake", was **not met and not refuted**: the cap did not bind. The pin question stays open.

### Two more readings the same fault voids

- **Arm 1, Abel's own page under the emulated cap** (`browser:weeb3-native`, recording `080a0715`,
  120 s settle, 60 s cap): "1.000x before, 1.000x while capped, 1.000x after". His page runs the
  same SharedWorker, so the cap never reached his node either, and the page also held 384 s of
  buffer. Not a download test.
- **Arm 1b, our VOD viewer in-tab under the emulated cap** (`browser:vod`, rung `6902cf52`, same
  settle and cap, client `0.0.341001`): "1.000x before, 1.000x while capped, 1.000x after", bytes
  from the in-tab node by the client's own account. Same fault, same verdict: void.

The one control that stands is **our player through the gateway under the same cap**: 1.000x
throughout, 183 fragments fetched, on both the 207 s and the 505 s recording. The gateway path is
HTTP from the page, which the emulation does throttle, and it kept pace.

### A harness trap that cost two attempts

`bench-on-host.sh --no-setup` skips the sync as well as the build and the install, so a run launched
with it measures the host checkout as of the last setup, not the head just landed. The second arm 2
attempt failed on the secure-context fault after the fix had been committed locally, because the fix
never reached the host. Every `--no-setup` result of the day has to be read against what the host
checkout actually held.

### Arm 2, the real link: the first valid capped reading of our client on the latest weeb-3

`in-tab-throttle-probe-2026-09-02T11-29-05-393Z.md`. `browser-on-host.sh --own-network
--shape-kbps 2800`: a `tc` ingress policer on the browser container's own interface, under every
socket the tab opens, proved at **326,904 bytes/s** against the 350,000 the cap allows by
downloading the 3.9 MB wasm before the browser opened. Our client on `0.0.341001`, the same recording,
0 BZZ. The node joined the network in **30.5 s** under the cap, against 0.8 s uncapped: the join alone
pulls about ten megabytes, and a capped viewer waits half a minute before it can ask for a byte of
video. All 13 rows completed inside their budget.

| arm | payload | observed | floor at 326,904 B/s | observed over floor |
| --- | ---: | ---: | ---: | ---: |
| 360p, n=6 (canaries included) | 219 to 236 KB | **0.76 to 1.04 s** | 0.69 s | 1.1 to 1.5x |
| 1080p, n=3 | 1.16 to 1.21 MB | **6.7 to 6.85 s** | 3.6 s | 1.9x |
| two 360p at once, n=2 pairs | 451 to 459 KB | both done in **2.5 s** and **3.5 s** | 1.4 s | 1.8 to 2.5x |

Against the pre-registration for this arm, written before it ran: a capped 360p in 1.5 s or less
**met**. The 1080p line, 4 s or less, **not met**, and its failure line of 12 s or more not met
either, so "improved, not closed" for a rung whose own bitrate exceeds the cap. The pairs are slower
than two in sequence (2.5 and 3.5 s against 2.0 s), a mild contention rather than the morning's
collapse.

Against the morning's figures (`0.0.329001` under Chrome's emulation: 360p 3.4 to 4.2 s, 1080p 16.5
to 19.6 s, pairs 6.4 to 9.1 s each) this is **four times faster on 360p, two and a half on 1080p**.
⚠️ **Two things changed between those runs, the weeb-3 release and the cap instrument**, so the
improvement belongs to neither alone until the like-for-like below separates them. The byte and frame
columns of this report read 0 for the reason given above, so the timing is the reading and no
amplification figure exists for this build yet.

### The like-for-like: the morning's pin under the same real link, and the morning's red was the instrument

`in-tab-throttle-probe-2026-09-02T11-41-33-865Z.md`. The stage client rolled back to `0.0.329001`
(node in the page, so the recorder sees its sockets and every column reads), the same `tc` shaper
proved at 330,271 bytes/s, the same recording, 0 BZZ. The node joined in 19.0 s. 13 of 13 rows inside
budget.

| arm | `0.0.329001` under Chrome's emulation, the morning | `0.0.329001` under the real link | `0.0.341001` under the real link |
| --- | ---: | ---: | ---: |
| 360p, one at a time | **3.4 to 4.2 s**, ×1.92 to 2.00, link 31 to 51% full | **1.0 s** (n=6), ×1.10 to 1.15, link 68 to 75% full | **0.76 to 1.04 s** (n=6), bytes unread |
| 1080p, one at a time | **16.5 to 19.6 s**, ×2.33 to 2.87 | **8.4 to 8.9 s**, ×1.84 to 1.93, link 75 to 76% full, 2.2 to 2.6 MB more in the tail | **6.7 to 6.85 s**, bytes unread |
| two 360p at once | 6.4 to 9.1 s each, 1.3 to 1.7 MB late | **1.8 to 2.3 s** each, ×1.31 to 1.47 together, link 84 to 87% full | 2.5 and 3.5 s for both |

Same release, same client, same recording, same driver, same 2800 kbps figure. Under a real link the
360p segment that took 3.4 to 4.2 s under Chrome's emulation takes **1.0 s**, carries **1.1 bytes
per payload byte** instead of 2, and fills the link to 70% instead of leaving it half idle. **The
morning's headline, doubled traffic on a half-idle link at the cheapest rung, was a property of
`Network.emulateNetworkConditions`, not of weeb-3 `0.0.329001`.** The owner's ruling that the fault
was on our side is confirmed at the instrument.

What survives from the morning, now measured on a link that is real: at **1080p** the old release
does pull **1.8 to 1.9 bytes per payload byte** and keeps pulling **about two more segments' worth**
after the segment is complete. A 1.2 MB retrieval outlives the one-second mark, which is where the
hedging the morning's document describes begins, and a 225 KB one does not. That rung's own bitrate
exceeds this cap, so no adaptive viewer should be on it under this link, and whether `0.0.341001`
still does it is unread until the recorder reaches the worker.

Between the two releases under the same real link: equal on 360p, `0.0.341001` about 20% faster on
1080p, `0.0.329001` a little faster on the pairs. Both join slowly under the cap, 19.0 s and 30.5 s
against 0.8 s uncapped, and one of two capped boots of `0.0.341001` timed out before the node
existed. A throttled viewer's first half minute is the join, on either release.

Caveats, in the open: one run per cell, and the morning's cell was four hours earlier against a
different peer set. Rows inside each cell replicate within 10%, and the gap between the emulated and
the real cell is 3.5 to 4x, so peer drift does not carry it. The pre-registration for arm 3 asked for
a capped 360p in 1.5 s or less on the new release, which the real link gave on both releases.

### What this means for V2

V2 as it was measured is an instrument reading. Its cap has to be a real one, the `tc` shaper with
its rate proof, or the worker-aware emulation once that harness change lands and proves itself by
effect on every run. Under a real 2800 kbps link, on either release, the in-tab node delivers the
cheapest rung at link speed with a second to spare per two-second segment. Whether the viewer's
adaptive logic then holds that rung is the question V2 has to be re-run to answer.
