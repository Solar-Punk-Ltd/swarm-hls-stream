# Why a capped in-tab node delivers nothing: the probe

**2026-09-02T11:41:33.865Z.** Chrome 151.0.7922.75, headed against an X display on the deployment host, driving the shipped client at `http://host.docker.internal:10074`. No broadcast: the node in the tab is booted through the client's own switch and every retrieval goes through the client's own fetch backend, so this is the product path rather than a stand-in.

The node joined the network in 19.0 s. Owner `8d8a30ff4cbcf8ad0e0773547686295f8157feb0`.

**The cap is a real shaped link, not Chrome's emulation.** A `tc` ingress policer at 2800 kbit/s on the container's own interface, under every socket the tab opens, proved by `deploy/scripts/shape-container-ingress.sh` at 330,271 B/s against a real download from the host before the browser opened.

| rung | topic | segments | `EXT-X-TARGETDURATION` | typical `#EXTINF` |
| --- | --- | ---: | ---: | ---: |
| 360p | `906fe47f1d5c4e1c2a2bb0718aa0e55477a23b9a6d6c7229550c8b6ce0b1af10` | 127 | 2 | 2.000s |
| 1080p | `fbb12dbb0037cce1db284d7c751f7762ac75bf9bf371ec01f6aaa99156d4830b` | 127 | 2 | 2.000s |

⚠️ Segment **bytes** are not in a manifest and are not read from one. They are the payload each retrieval below returned. What a manifest declares is a duration, and that is what this table carries.

⚠️ **No reference is fetched twice in this run.** A repeat is answered out of the node's own cache in single digit milliseconds and would score as a miracle.

## Everything below is observations, none of them asserted

This is a measurement, not a suite. No figure here refuses a run, and a value that hit its budget is reported as not completing rather than as a duration.

## Part A, idle

The node booted and nothing requested, for 60.0 s under the shaped link. This is H2.

| window | mean inbound | mean outbound | connections, start → end |
| --- | ---: | ---: | ---: |
| external 2800 kbps | 50,778 B/s | 9,516 B/s | 10 → 200 |

⛔ **There is no uncapped condition inside an externally capped run.** The `tc` policer is installed for the life of the container and cannot be lifted for one window or one row, so this run carries one idle window and no free arm. **The uncapped comparison is the CDP run of the same day**, which measured the same client against the same references with the cap applied by Chrome instead. Read the two side by side, and read nothing here as this node's unconstrained behaviour.

### H0, the instrument

✅ **H0 does not apply, the cap is a real shaper proved by the preflight at 330,271 B/s.** H0 asks whether Chromium's emulation reached the WebSocket transport, and there is no emulation here: the cap is a `tc` ingress policer on the container's own interface, under every socket the tab opens, and `deploy/scripts/shape-container-ingress.sh` measured what it delivers against a real download from the host before this run was allowed to start.

## Part B, one fragment at a time

Every round opens with a 360p canary, which runs **under the same cap as every other row**: the policer cannot be lifted for one retrieval. So a degraded round here means the node could not answer under the cap rather than at all, which excludes less than the CDP run's unthrottled canary does. The budget is 90 s, and a row that hit it is reported as not completing rather than as a duration: the harness stopped waiting, the retrieval did not stop. The tail column is inbound bytes in the 10 s after a row settled, which is where the late answers land.

⛔ A ⛔ in the outcome column is a row past **20 s**, which is where hls.js abandons a fragment. A viewer would already have given up on it.

| round | arm | cap | reference | outcome | inbound during | out frames | inbound in the tail | ×payload | of the cap |
| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | canary | external 2800 kbps | `afd0706d9000` | 1.0 s, 224,848 bytes | 249,631 | 324 | 45,458 | 1.11 | 68% |
| 0 | 360p | external 2800 kbps | `fd547a30dd98` | 1.0 s, 231,052 bytes | 253,688 | 313 | 39,158 | 1.10 | 70% |
| 0 | 1080p | external 2800 kbps | `ce4a28d1c4c5` | 8.4 s, 1,163,720 bytes | 2,235,264 | 4609 | 2,240,950 | 1.92 | 76% |
| 1 | canary | external 2800 kbps | `4ef5d372972f` | 1.0 s, 222,216 bytes | 251,408 | 332 | 29,820 | 1.13 | 75% |
| 1 | 1080p | external 2800 kbps | `ab920cf224fb` | 8.9 s, 1,209,780 bytes | 2,340,593 | 5038 | 2,480,051 | 1.93 | 75% |
| 1 | 360p | external 2800 kbps | `9d0ed6b5b6cf` | 1.0 s, 234,436 bytes | 259,178 | 373 | 47,623 | 1.11 | 72% |
| 2 | canary | external 2800 kbps | `bc96b411c648` | 1.0 s, 235,752 bytes | 267,410 | 412 | 22,962 | 1.13 | 74% |
| 2 | 360p | external 2800 kbps | `69e957283b36` | 1.0 s, 218,832 bytes | 251,033 | 388 | 20,147 | 1.15 | 70% |
| 2 | 1080p | external 2800 kbps | `afab98c64ac2` | 8.4 s, 1,210,908 bytes | 2,224,166 | 4847 | 2,555,742 | 1.84 | 75% |

### Inbound bytes per payload byte

| arm | cap | min / median / max |
| --- | --- | ---: |
| 360p | external 2800 kbps | 1.10 / 1.11 / 1.15 (n=3) |
| 1080p | external 2800 kbps | 1.84 / 1.92 / 1.93 (n=3) |

✅ **Every round's canary landed, so no round was degraded** and no row above was excluded.

## Part C, two at once

Two fresh 360p references started together under the external 2800 kbps cap. Sitting five had up to three 360p retrievals overlapping, so this is the shape the viewer actually produced.

| round | arm | cap | reference | outcome | inbound during | out frames | inbound in the tail | ×payload | of the cap |
| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | pair | external 2800 kbps | `0c3f072a6946` | 2.0 s, 226,916 bytes | 621,880 | 938 | 199,483 | 2.74 | 87% |
| 0 | pair | external 2800 kbps | `c94211dd014e` | 2.3 s, 231,616 bytes | 675,280 | 1010 | 146,143 | 2.92 | 84% |
| 1 | pair | external 2800 kbps | `9873ccef47ad` | 1.8 s, 218,456 bytes | 538,058 | 870 | 191,802 | 2.46 | 85% |
| 1 | pair | external 2800 kbps | `2ebd27f52fbe` | 1.9 s, 232,744 bytes | 589,390 | 888 | 140,530 | 2.53 | 87% |

⛔ Two rows on one link each count the other's bytes, so a per row ratio above is a number about both. Read each pair together:

- Pair 0 together: 675,280 bytes inbound over 2.3 s against 458,532 payload bytes, ×1.47, link at 84% of the cap.
- Pair 1 together: 589,390 bytes inbound over 1.9 s against 451,200 payload bytes, ×1.31, link at 87% of the cap.

## The pre-registration, against what was observed

Written before the driver existed and before anything ran, so none of it can have been fitted to the result. `docs/bench/in-tab-throttle-probe-prediction-2026-09-02.md` is the plan.

| | predicted | observed |
| --- | --- | --- |
| **H1** hedge amplification | capped 360p at **3.0** or more, uncapped near 1.0 to 1.3 | capped 1.10 / 1.11 / 1.15 (n=3), uncapped NOT RUN, see the uncapped comparison in the CDP run of the same day |
| **H2** idle background load | idle inbound at **105,000 bytes/s** or more, which is 30% of the 2800 kbps cap | 50,778 bytes/s |
| **H3** accounting exhaustion | a capped retrieval hangs with the link mostly idle, well under the cap, and rejects when it answers. Under H1 the link is full while goodput is low | 0 of 13 capped rows rejected, 0 of them inside 20 s. Link at 68% / 75% / 87% (n=13) of the cap while capped rows ran |

## What this run consumed

Read off the deployment either side of the run rather than estimated, over 6.6 minutes.

| node | postage, fullest bucket | per min | chequebook BZZ | per min | postage runway |
| --- | ---: | ---: | ---: | ---: | ---: |
| 360p :10075 | 28/256 → 28/256 | 0.00 | 7.753 → 7.753 | 0.0000 | not measurable from this run |
| 480p :11071 | 36/256 → 36/256 | 0.00 | 3.470 → 3.470 | 0.0000 | not measurable from this run |
| 720p :11073 | 58/256 → 58/256 | 0.00 | 3.866 → 3.866 | 0.0000 | not measurable from this run |
| 1080p :11075 | 74/256 → 74/256 | 0.00 | 4.419 → 4.419 | 0.0000 | not measurable from this run |
| **whole stage** | 0 buckets used | 0.00 | 0.000 spent | 0.0000 | not measurable from this run |

At this run's own rate: **not measurable from this run of postage**, **not measurable from this run of BZZ**, and the first batch expires in 5.9 days.

⚠️ Both runways are the **shortest** any one node reported, never the stage's total. The stage stops when the first rung fills or runs dry, and across the ladder 1080p burns roughly seven times the bytes of 360p.

The postage runway is a **floor**. `utilization` is the fullest of sixty-five thousand buckets, and a maximum grows fastest while the batch is nearly empty and then flattens, so an early run overstates the long-run rate. **Two runs at different fullness are not comparable at all**, which is what retracted the postage half of the 2026-08-07 segment-length comparison. Later runs on the same batch, at similar fullness, are the ones to believe.

## What this cannot say

- **Which peers.** The node exposes no per peer view, and yamux frames are not one to one with attempts. Bytes per payload byte is robust to that, and no attempt count is claimed here.
- **Whether a fix works.** That needs the fix.
- **The live edge.** These are VOD references. The retrieval path does not know whether the playlist was live, so the mechanism transfers, but a live viewer's overlapping requests are only approximated by Part C.
