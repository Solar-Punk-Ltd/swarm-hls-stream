# A live edge, served by a Swarm node in the viewer's tab

**2026-08-13.** One live broadcast, eight arms, counterbalanced, 0.8188 BZZ.

#92 phase A2 proved the in-tab path works on a **recording**. A recording lets a player fetch as far
ahead as it likes, and the weeb-3 arm used that freedom: 19.99s of buffer against the gateway arm's
47.98s, real time held. A live edge has no ahead to fetch into, so nothing in A2 said whether an
in-tab node keeps up when the only segment available is the one published a moment ago.

It does.

## What was run

One publisher for the whole sitting, so both conditions read the same content from the same encoder
over the same window into the same network. 1280x720 at 2500 kbps, 0.5s GOP, the shipping profile.

Order `gateway weeb3 gateway weeb3 weeb3 gateway weeb3 gateway`, which is position-balanced and pays
one seam. Round 1 is warm-up and is discarded, leaving **n=3 per condition** of six minutes each.

Only **segment bytes** move between conditions. The catalog, the feed and the manifest come from the
gateway in both arms, by the design of PR #183. ⚠️ **A weeb-3 arm is not a gateway-less viewer**, it is
a viewer whose video comes from its own node. #44 was withdrawn for blurring exactly that line.

## What the viewer got

| arm | source | behind live | rebuffers | stalls | video played in a 360s window |
| --- | --- | ---: | ---: | ---: | ---: |
| 3 | gateway | 5.55s | 0 | 0 | 359.61s |
| 4 | weeb3 | 6.03s | 0 | 0 | 359.91s |
| 5 | weeb3 | 6.03s | 0 | 0 | 359.59s |
| 6 | gateway | 6.04s | 0 | 0 | 360.00s |
| 7 | weeb3 | 6.03s | 0 | 0 | 359.78s |
| 8 | gateway | 6.03s | 0 | 0 | 359.13s |

Every arm's instrument was SOUND.

### ⛔⛔ The latency column does not rank the two, and must not be quoted as if it does

`LIVE_SYNC_DURATION_S` is **6**. Every weeb-3 arm reads exactly 6.03s and two of three gateway arms
read 6.03 or 6.04. That is not a tie that was measured, it is **both conditions sitting on the same
configured target**, and a reading at a cap is not a measurement of what the thing could do.

⭐ What the column does support: **neither condition breached the target.** A player that could not
keep up would drift above 6s and stay there, because hls.js raises its latency target on a stall and
never lowers it. None did.

⭐ The uncensored evidence is beside it: **0 rebuffers and 0 stalls in all six counted arms**, and
359.1 to 360.0 seconds of video played in every 360-second window. The player was fed, continuously,
in both conditions.

## Where the bytes actually came from

Two instruments, neither trusting the other.

**Browser side.** Every arm passed `armBytesCameFromItsSource`, which throws rather than warns. A
weeb-3 arm is refused unless it made **zero** `/bytes/` requests inside its measured window **and**
fetched the weeb-3 wasm, because a client that never loaded the backend produces the same zero and it
is the more attractive of the two readings.

Whole-run HTTP, which includes the settle before the window opens:

| source | `/bytes/` requests | HTTP segment bytes |
| --- | ---: | ---: |
| gateway | 853, 855, 853 | 147.1, 147.4, 146.9 MB |
| weeb3 | 6, 8, 7 | 0.9, 1.2, 1.1 MB |

The six to eight are the fragments already in flight in the first second, before the switch took
hold. Inside the counted window every weeb-3 arm is a zero.

**Node side**, read off the gateway's own `/metrics` either side of every arm, and independent of
anything the browser reported:

| arm | source | gateway retrievals | gateway spend |
| --- | --- | ---: | ---: |
| 1 | gateway | 40,041 | 0.0935 BZZ |
| 2 | weeb3 | 1,570 | 0.00041 BZZ |
| 3 | gateway | 40,144 | 0.0743 BZZ |
| 4 | weeb3 | 1,613 | 0.00032 BZZ |
| 5 | weeb3 | 1,690 | 0.00075 BZZ |
| 6 | gateway | 40,118 | 0.0811 BZZ |
| 7 | weeb3 | 1,688 | 0.00074 BZZ |
| 8 | gateway | 40,063 | 0.0721 BZZ |

⭐⭐⭐ **24.4x fewer retrievals and 143x less gateway spend, with no overlap between the conditions on
either counter, across all eight arms including the warm-ups.**

The residual ~1,640 retrievals per weeb-3 arm are the feed and manifest reads, which still go through
the gateway by design.

## What this costs the operator

Per six-minute viewer, measured at the gateway: **0.0803 BZZ** through a gateway against **0.00056
BZZ** through an in-tab node.

⛔ **Do not multiply the gateway figure by an audience.** A bee gateway fetches each distinct chunk
once, so sixteen viewers behind one gateway cost close to what one costs. The in-tab figure is the one
that is genuinely per viewer, because each tab retrieves independently. The comparison above is
one viewer against one viewer, which is the arm that was run and not the shape of a real audience.

⚠️ **The in-tab node has no chequebook.** It retrieves as an unfunded light node, which #93 measured at
about 2x per segment against a funded one, absorbed by the buffer. This sitting is consistent with
that and does not settle who pays the serving peers.

## Preconditions and bounds, so the number can be defended

- Gateway warm and funded throughout: **134 peers**, 38h uptime, chequebook 2.388 to 2.061 BZZ. No bee
  container was restarted at any point.
- Uploader 4.355 to 3.536 BZZ. Postage `7849851f` 265 of 512 used, 250 hours left.
- **Host load 5.64 to 11.20** across arms, and the box carries some forty other bee nodes plus other
  tenants' stacks. Round 4 ran at the highest load of the sitting (10.93 and 11.20) and its two arms
  are one of each condition, so the counterbalancing carried it.
- The arms took 3,738s of a 4,520s broadcast, 782s to spare.
- The client was built with `VITE_EXPOSE_PLAYER=1` and a `gateway` default, and the byte source moved
  at runtime, so **one build served the whole sitting**. A2 needed a rebuild per arm.

## ⚠️ What this does not say

- **n=3 per condition, one sitting, one host, one profile.** A replicate is worth more than any caveat.
- Nothing about **many** in-tab viewers. One node per tab is a hard constraint: two reach 82 peers
  each and three reach zero and never re-dial.
- Nothing about a **cold** node on fresh content, which is #52.
- Nothing about CPU. An in-browser viewer was measured at 0.79 to 1.05 cores elsewhere, on Apple
  Silicon, and this sitting did not sample the browser container's CPU.
- **weeb-3 exposes no live peer count.** `networkState()` returns static configuration: 319 bootnodes,
  unchanged from t+2s to t+100s. So a weak arm cannot be attributed to a thin peer set from inside.
  Nothing here needed that, because no arm was weak.

## Where the evidence is

`weeb3-live-arms-2026-08-13/` holds the driver log, the arm ledger, and the gateway's `/metrics`
before and after every arm, which is the instrument the tables above were read from.

⚠️ The eight per-arm browser reports are **not** in the repo. `docs/bench/browser-watch-*` is
gitignored, and they stay on the deployment host at `swarm-hls-bench/docs/bench/`, stamped
`2026-08-13T12-50-35` through `13-44-27`.

## The harness

`deploy/scripts/byte-source-arms.sh`, PR #186. `browser:fetch-backend-check` is the free gate that
stands between this sitting and its most attractive wrong answer: a dead switch would leave every arm
reading the gateway, both columns would agree, and the report would say an in-tab node holds a live
edge exactly as well as a gateway does. It boots a real node as part of the check, because a host
where weeb-3 cannot reach a peer passes everything else and produces a treatment arm that fetched no
video.
