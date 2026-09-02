# Why a capped in-tab node delivers nothing: the probe

**2026-09-02T10:53:22.247Z.** Chrome 151.0.7922.75, headed against an X display on the deployment host, driving the shipped client at `http://127.0.0.1:10074`. No broadcast: the node in the tab is booted through the client's own switch and every retrieval goes through the client's own fetch backend, so this is the product path rather than a stand-in.

The node joined the network in 0.8 s. Owner `8d8a30ff4cbcf8ad0e0773547686295f8157feb0`.

**The cap is Chrome's `Network.emulateNetworkConditions`**, applied over CDP at 2800 kbit/s. ⚠️ That is one aggregate budget the browser schedules across every transport itself, and how it divides one across an in-tab node's ~200 WebSockets is not a fact about a link of that speed. H0 below is what this report can say about it.

| rung | topic | segments | `EXT-X-TARGETDURATION` | typical `#EXTINF` |
| --- | --- | ---: | ---: | ---: |
| 360p | `906fe47f1d5c4e1c2a2bb0718aa0e55477a23b9a6d6c7229550c8b6ce0b1af10` | 127 | 2 | 2.000s |
| 1080p | `fbb12dbb0037cce1db284d7c751f7762ac75bf9bf371ec01f6aaa99156d4830b` | 127 | 2 | 2.000s |

⚠️ Segment **bytes** are not in a manifest and are not read from one. They are the payload each retrieval below returned. What a manifest declares is a duration, and that is what this table carries.

⚠️ **No reference is fetched twice in this run.** A repeat is answered out of the node's own cache in single digit milliseconds and would score as a miracle.

## Everything below is observations, none of them asserted

This is a measurement, not a suite. No figure here refuses a run, and a value that hit its budget is reported as not completing rather than as a duration.

## Part A, idle

The node booted and nothing requested, for 60.0 s per window. This is H2, and the last row is H0.

| window | mean inbound | mean outbound | connections, start → end |
| --- | ---: | ---: | ---: |
| unthrottled | 0 B/s | 0 B/s | 0 → 0 |
| 2800 kbps | 0 B/s | 0 B/s | 0 → 0 |
| 700 kbps | 0 B/s | 0 B/s | 0 → 0 |

### H0, the instrument

✅ **H0 holds.** Idle inbound under the 700 kbps cap averaged 0 bytes/s against the 87,500 bytes/s that cap allows, so the emulation reaches the WebSocket transport as one aggregate budget and the capped ratios below mean what they say.

## Part B, one fragment at a time

Every round opens with an unthrottled 360p canary. The budget is 90 s, and a row that hit it is reported as not completing rather than as a duration: the harness stopped waiting, the retrieval did not stop. The tail column is inbound bytes in the 10 s after a row settled, which is where the late answers land.

⛔ A ⛔ in the outcome column is a row past **20 s**, which is where hls.js abandons a fragment. A viewer would already have given up on it.

| round | arm | cap | reference | outcome | inbound during | out frames | inbound in the tail | ×payload | of the cap |
| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | canary | uncapped | `afd0706d9000` | 0.1 s, 224,848 bytes | 0 | 0 | 0 | 0.00 | — |
| 0 | 360p | 2800 kbps | `f514ccaeb1d9` | 0.1 s, 222,968 bytes | 0 | 0 | 0 | 0.00 | 0% |
| 0 | 1080p | 2800 kbps | `ce4a28d1c4c5` | 0.4 s, 1,163,720 bytes | 0 | 0 | 0 | 0.00 | 0% |
| 0 | 360p | uncapped | `74aacae461fc` | 0.1 s, 224,096 bytes | 0 | 0 | 0 | 0.00 | — |
| 0 | 1080p | uncapped | `0aa9d944e27c` | 0.3 s, 1,148,492 bytes | 0 | 0 | 0 | 0.00 | — |
| 1 | canary | uncapped | `541a26c78e47` | 0.1 s, 223,720 bytes | 0 | 0 | 0 | 0.00 | — |
| 1 | 1080p | uncapped | `ab920cf224fb` | 0.3 s, 1,209,780 bytes | 0 | 0 | 0 | 0.00 | — |
| 1 | 360p | uncapped | `acf08892b19a` | 0.1 s, 215,260 bytes | 0 | 0 | 0 | 0.00 | — |
| 1 | 1080p | 2800 kbps | `fb49651e6e90` | 0.3 s, 1,154,508 bytes | 0 | 0 | 0 | 0.00 | 0% |
| 1 | 360p | 2800 kbps | `43a62f43b044` | 0.1 s, 225,224 bytes | 0 | 0 | 0 | 0.00 | 0% |
| 2 | canary | uncapped | `f4c715d1fab7` | 0.1 s, 225,224 bytes | 0 | 0 | 0 | 0.00 | — |
| 2 | 360p | 2800 kbps | `e60adaf73f9e` | 0.1 s, 233,308 bytes | 0 | 0 | 0 | 0.00 | 0% |
| 2 | 1080p | 2800 kbps | `afab98c64ac2` | 0.3 s, 1,210,908 bytes | 0 | 0 | 0 | 0.00 | 0% |
| 2 | 360p | uncapped | `47aae5636d0e` | 0.1 s, 229,360 bytes | 0 | 0 | 0 | 0.00 | — |
| 2 | 1080p | uncapped | `dea4074580de` | 0.3 s, 1,185,152 bytes | 0 | 0 | 0 | 0.00 | — |

### Inbound bytes per payload byte

| arm | cap | min / median / max |
| --- | --- | ---: |
| 360p | 2800 kbps | 0.00 / 0.00 / 0.00 (n=3) |
| 360p | uncapped | 0.00 / 0.00 / 0.00 (n=3) |
| 1080p | 2800 kbps | 0.00 / 0.00 / 0.00 (n=3) |
| 1080p | uncapped | 0.00 / 0.00 / 0.00 (n=3) |

✅ **Every round's canary landed, so no round was degraded** and no row above was excluded.

## Part C, two at once

Two fresh 360p references started together under the 2800 kbps cap. Sitting five had up to three 360p retrievals overlapping, so this is the shape the viewer actually produced.

| round | arm | cap | reference | outcome | inbound during | out frames | inbound in the tail | ×payload | of the cap |
| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | pair | 2800 kbps | `952d6b84df54` | 0.2 s, 210,560 bytes | 0 | 0 | 0 | 0.00 | 0% |
| 0 | pair | 2800 kbps | `bcb3a1a07347` | 0.2 s, 230,676 bytes | 0 | 0 | 0 | 0.00 | 0% |
| 1 | pair | 2800 kbps | `d2c2b00e3c7c` | 0.1 s, 214,884 bytes | 0 | 0 | 0 | 0.00 | 0% |
| 1 | pair | 2800 kbps | `0945a3db5ac3` | 0.1 s, 230,112 bytes | 0 | 0 | 0 | 0.00 | 0% |

⛔ Two rows on one link each count the other's bytes, so a per row ratio above is a number about both. Read each pair together:

- Pair 0 together: 0 bytes inbound over 0.2 s against 441,236 payload bytes, ×0.00, link at 0% of the cap.
- Pair 1 together: 0 bytes inbound over 0.1 s against 444,996 payload bytes, ×0.00, link at 0% of the cap.

## The pre-registration, against what was observed

Written before the driver existed and before anything ran, so none of it can have been fitted to the result. `docs/bench/in-tab-throttle-probe-prediction-2026-09-02.md` is the plan.

| | predicted | observed |
| --- | --- | --- |
| **H1** hedge amplification | capped 360p at **3.0** or more, uncapped near 1.0 to 1.3 | capped 0.00 / 0.00 / 0.00 (n=3), uncapped 0.00 / 0.00 / 0.00 (n=3) |
| **H2** idle background load | idle inbound at **105,000 bytes/s** or more, which is 30% of the 2800 kbps cap | 0 bytes/s |
| **H3** accounting exhaustion | a capped retrieval hangs with the link mostly idle, well under the cap, and rejects when it answers. Under H1 the link is full while goodput is low | 0 of 10 capped rows rejected, 0 of them inside 20 s. Link at 0% / 0% / 0% (n=10) of the cap while capped rows ran |

## What this run consumed

Read off the deployment either side of the run rather than estimated, over 10.2 minutes.

| node | postage, fullest bucket | per min | chequebook BZZ | per min | postage runway |
| --- | ---: | ---: | ---: | ---: | ---: |
| 360p :10075 | 28/256 → 28/256 | 0.00 | 7.753 → 7.753 | 0.0000 | not measurable from this run |
| 480p :11071 | 36/256 → 36/256 | 0.00 | 3.470 → 3.470 | 0.0000 | not measurable from this run |
| 720p :11073 | 58/256 → 58/256 | 0.00 | 3.866 → 3.866 | 0.0000 | not measurable from this run |
| 1080p :11075 | 74/256 → 74/256 | 0.00 | 4.419 → 4.419 | 0.0000 | not measurable from this run |
| **whole stage** | 0 buckets used | 0.00 | 0.000 spent | 0.0000 | not measurable from this run |

At this run's own rate: **not measurable from this run of postage**, **not measurable from this run of BZZ**, and the first batch expires in 6.0 days.

⚠️ Both runways are the **shortest** any one node reported, never the stage's total. The stage stops when the first rung fills or runs dry, and across the ladder 1080p burns roughly seven times the bytes of 360p.

The postage runway is a **floor**. `utilization` is the fullest of sixty-five thousand buckets, and a maximum grows fastest while the batch is nearly empty and then flattens, so an early run overstates the long-run rate. **Two runs at different fullness are not comparable at all**, which is what retracted the postage half of the 2026-08-07 segment-length comparison. Later runs on the same batch, at similar fullness, are the ones to believe.

## What this cannot say

- **Which peers.** The node exposes no per peer view, and yamux frames are not one to one with attempts. Bytes per payload byte is robust to that, and no attempt count is claimed here.
- **Whether a fix works.** That needs the fix.
- **The live edge.** These are VOD references. The retrieval path does not know whether the playlist was live, so the mechanism transfers, but a live viewer's overlapping requests are only approximated by Part C.
