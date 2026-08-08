# Light against ultra-light, at a viewer

**2026-08-07, 15:21 to 17:50 UTC.** Six arms interleaved in one sitting on `latbench`, 720p 2500kbps
at a **1.0s GOP**, watched in Chrome on the deployment host through the shipped client.

> ⛔ **Read the reconciliation at the bottom before quoting the headline.** This sitting ran at a 1.0s
> GOP. **The profile that ships is 0.25s.** Ultra-light quadrupled segment transfer time here too, and
> the only reason no viewer felt it is that a 1.0s segment budget absorbs the penalty. At 0.25s it does
> not, which is what [the 2026-08-06 sitting](light-vs-ultra-light-2026-08-06.md) measured. The first
> version of this report claimed the funding question was settled generally. It is not.

The question is whether a viewer's gateway has to be funded. An ultra-light bee node
(`--full-node=false` with `--swap-enable=false`) has no chequebook and no way to pay a peer for
bandwidth, so it lives on the free allowance alone. If a stream holds on one, the viewer path needs no
chain, no wallet and no on-chain funding at all, which is a large difference in what it costs to
deploy this.

**L** is the funded light gateway that ships today. **U** is ultra-light. The only difference between
the two arms is `--swap-enable`, asserted on the container after every recreate and again on the node
itself: a funded node returns a chequebook balance and an ultra-light one has none to return.

## What a viewer got

| round | arm | min | advance | stalled | rebuffers | fps | median latency | latency target |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | L | 5 | 1.004 | 0 | 0 | 30.0 | 5.54 | 6 |
| 0 | U | 5 | 1.002 | 0 | 0 | 30.0 | 5.91 | 6 |
| 1 | L | 30 | 1.001 | 0 | 0 | 30.0 | 5.05 | 6 |
| 1 | U | 30 | 1.000 | 0 | 0 | 30.0 | 5.53 | 6 |
| 2 | L | 30 | 1.000 | **1** | **1** | 30.0 | ~~5.51~~ | **7** |
| 2 | U | 30 | 1.001 | 0 | 0 | 30.0 | 5.55 | 6 |

All six instrument-sound, 297 to 1778 samples each, every sample from a foregrounded page.

✅ **At a 1.0s GOP, an unfunded gateway delivers the same picture as a funded one.** Three U arms, all
clean: advance 1.000 to 1.002, nothing stalled, nothing rebuffered, 30.0fps throughout. The
qualification is not decoration, see the reconciliation below.

✅ **And it served every byte.** 1807 segment requests in each 30-minute arm, **0 refused and 0 never
served, in the unfunded arms as much as the funded ones**, with the same 0.0006 BZZ per megabyte
delivered. There is no retrieval degradation here to find.

✅ **The only stall in the sitting was in the funded arm.** Whatever produced it, it was not credit.

## The one difference, and why this report will not call it an effect

U's median latency sat above L's in both pairs where the two are comparable: **+0.37s** at five
minutes and **+0.48s** at thirty. Consistent in direction and size, and it would be easy to write down
as the cost of running unfunded.

Two things say it is not established.

**Round 2's L cannot be read against anything.** It contains a non-fatal stall, and hls.js raises its
latency target after one and never lowers it: that arm's target reached **7 seconds** while every
other arm held 6. A median measured against a 7s target is not the same measurement. So the sitting
has **one** comparable 30-minute L arm, not two, and with only one reading there is no L-against-L
spread to weigh the L-against-U gap against. An earlier reading of this sitting used round 2's 5.51 to
argue the gap was ordinary between-run variation. That argument was wrong, because it rested on the
one number in the table that is not comparable.

**The floor is identical.** Minimum latency was 5.03, 5.04, 5.03, 4.90, 5.24 and 5.02 across the six
arms. Whatever separates the medians, it is not that an unfunded node cannot reach the same latency;
it reaches it just as low and sits above it slightly more often.

So: **a candidate effect of about half a second in the median, on two pairs, with no within-arm
control on the funded side.** What would settle it is two more 30-minute L arms in one sitting, which
costs about 0.62 BZZ on the gateway and an hour, and the answer only matters if half a second matters.

## ⛔ The reconciliation, which changes what this sitting is worth

This report first said the funding question was settled. It is not, and the number that says so was in
this sitting's own reports the whole time, in a field it did not read.

| | median segment transfer | buffer held |
| --- | ---: | ---: |
| L funded, rounds 1 and 2 | 103ms, 100ms | 4.44s, 5.07s |
| **U ultra-light, rounds 1 and 2** | **458.5ms, 407ms** | 4.31s, 4.48s |

**Ultra-light multiplied segment transfer time by about four here too.** The penalty
[the 2026-08-06 sitting](light-vs-ultra-light-2026-08-06.md) found is not absent from this one. It is
absorbed, and what absorbs it is the segment budget.

| GOP | budget per segment | light | ultra-light |
| ---: | ---: | ---: | ---: |
| 0.25s, **the profile that ships** | 250ms | 26-36% of budget | **62-69% of budget** |
| 1.0s, this sitting | 1000ms | 10% of budget | 41-46% of budget |

A player needs the next segment before the current one finishes playing. At 1.0s an ultra-light
transfer eats under half the budget and the buffer never notices. At 0.25s it eats two thirds, and a
distribution whose median is at two thirds crosses the whole budget often enough to starve the buffer,
which is precisely the collapse 2026-08-06 recorded: buffer 4.60s to 1.46s, seventeen rebuffers in
three minutes, delivered frame rate below what was encoded.

**So the two sittings do not disagree about anything.** They measured the same mechanism at two
segment lengths and it is the segment length that decides whether a viewer feels it. The absolute
transfer times are not comparable across them, because a 1.0s segment carries four times the bytes of
a 0.25s one at the same bitrate; the fraction of budget is the comparable quantity, and it is the one
that predicts the outcome in both.

### What this sitting actually establishes

- ✅ At **1.0s GOP**, an unfunded gateway costs a viewer nothing measurable over 30 minutes.
- ⛔ It says **nothing in favour of** running unfunded at 0.25s, which is what ships, and the transfer
  figures above are evidence **against** it.
- ✅ The mechanism is now measured twice, independently, at two segment lengths, and it is a
  **per-segment transfer cost** rather than freezing.

### What would settle the shipping profile

The same six arms at 0.25s, which is where the decision actually lives, at about the same cost as this
sitting. Until then the operating assumption stays: **a viewer's gateway has to be funded at the
profile this project ships.**

## LAT-10 does not reproduce

The 2026-08-04 comparison found ultra-light **37% frozen** against light's 19%. At a viewer, across
three arms and 65 minutes of ultra-light playback, **nothing froze at all**.

That is what [the reader A/B](feed-reader-ab.md) predicted. Every frozen-share figure in LAT-10 came
through the bench's `/feeds/` head lookup, which is 50-57% frozen on its own and which a viewer never
calls, and the client has since been fixed to walk the feed rather than take one slot per poll. The
peer-accounting evidence LAT-10 gathered still stands on its own terms. Its magnitude at a viewer is
zero.

## What it cost

| | before | after | spent |
| --- | ---: | ---: | ---: |
| gateway chequebook | 7.967 | 7.233 | **0.734** |
| uploader chequebook | 5.443 | 3.528 | **1.915** |

The gateway paid **0.3074 and 0.3165 BZZ per 30 minutes** of 720p in the two funded arms, which is the
second and third independent sighting of the corrected 0.306 figure and confirms that the 0.123 this
project budgeted on until 2026-08-07 was 2.5x too low. **The unfunded arms cost the gateway nothing at
all**, which is the deployment argument in one line.

Total 2.65 BZZ against 2.40 planned. The overrun is one proving pass paid for twice, below.

## The instrument, and the three defects its own proving pass found

The sitting was driven by `deploy/scripts/phase06-light-vs-ultralight.sh`, run detached on the host so
it outlives the laptop, in the shape `sweep-interleaved.sh` established. It runs a five-minute arm of
each configuration first and only spends the sitting if both come back sound.

That proving pass earned its cost immediately. All three of these were invisible to inspection and
would each have ruined the night:

1. `newest_report` globbed `browser-watch-*.json`, which also matches the `.requests.json` companion
   written after it. It validated the wrong document, the validator raised on a shape it did not
   expect, and the verdict came back **empty** — which failed the gate on a run that had gone fine.
2. The validator died silently rather than naming an unexpected document, so the failure arrived as a
   blank cell in the state file.
3. `stop_publisher` removed a container named `phase06-publisher`, which `publish-clock.sh` never
   creates: it names its container `swarm-hls-publish-$$` and detaches it deliberately so it outlives
   its ssh session. The publisher leaked. Without the fix **every arm after the first would have
   measured the arm before it**, and the rows would have looked entirely reasonable.

The third was caught by the guard that refuses to start when the uploader already reports a live
stream, which is the check that turned a silent cross-contamination into a refusal.

⭐ The rule this pays for again: **dry-run an instrument against the deployment before spending a
broadcast on it.** None of the three was visible to a unit test, and together they cost 0.12 BZZ to
find instead of the sitting.

## Reproducing it

```bash
scp deploy/scripts/phase06-light-vs-ultralight.sh manager-host:/home/solarpunk/phase06/
ssh manager-host 'setsid nohup bash /home/solarpunk/phase06/phase06-light-vs-ultralight.sh >/dev/null 2>&1 &'
```

`PREFLIGHT_ONLY=1` answers whether the chequebooks and the postage batch cover the sitting without
publishing anything. The gateway is returned to the arm it was found in by an EXIT trap on every path,
including a refusal, and a sitting that never changed it does not bounce it.
