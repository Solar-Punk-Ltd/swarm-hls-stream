# Light against ultra-light, at a viewer

**2026-08-06.** Four three-minute browser runs at 720p/2500k, 0.25s GOP, **interleaved L U L U** in
one sitting. Task #88. The gateway's `--swap-enable` was flipped and the node redeployed between
arms.

## Why this was open

`--swap-enable=false` plus `--full-node=false` is bee's **ultra-light** mode: no chequebook, nothing
to pay a peer for bandwidth with, and only the free allowance to live on. LAT-10 concluded that cost
a viewer 30 to 48 second freezes. **That conclusion was then retracted**, because every measurement
behind it went through the bench's `/feeds/` head lookup, which is 50-57% frozen on its own and which
a viewer calls once per mount. See [`feed-reader-ab.md`](feed-reader-ab.md).

So the direction was never actually established through the product, and the question the owner asked
about non-chain nodes had no answer: **are they reliable the same way?**

## The manipulation was checked, not assumed

Each arm's node was verified rather than trusted to the env file: on the ultra arms
`/chequebook/balance` answered **405, chain disabled**, and the container's own arguments read
`--swap-enable=false --full-node=false`.

## What a viewer got

| arm | fps | media per wall s | stalled | rebuffers | behind live | **buffer** | **median transfer** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| L1 light (warm) | 30.0 | 0.999 | 0/178 | **0** | 5.96s | 5.00s | 91ms |
| U1 ultra | 30.1 | 0.994 | 2/178 | 3 | 6.32s | 3.12s | 156ms |
| L2 light | 30.0 | 0.999 | 0/178 | **0** | 5.32s | 4.60s | **65.5ms** |
| U2 ultra | 28.4 | 0.984 | 7/178 | **17** | 7.40s | **1.46s** | 172ms |

⭐ **Both light arms are perfect and neither ultra arm is.** Zero stalled samples and zero rebuffers
in light, against 2 and 7 stalls and 3 and 17 rebuffers in ultra. Nothing was ambiguous and nothing
needed a statistical test.

## The mechanism, in one number

**Median segment transfer roughly doubles: 65.5 and 91ms in light, 156 and 172ms in ultra.**

Everything else follows from it. A player that waits twice as long per segment cannot hold its
buffer, and the buffer is what the whole design rests on: **5.00 and 4.60 seconds in light against
3.12 and 1.46 in ultra.** Once the buffer is gone the rebuffers arrive, and by U2 the frame rate
itself is below what was encoded, 28.4 against 30.0.

Bee's own accounting says why, sampled on the node after each arm:

| | peers | in debt | median balance | **past −9.0e6, bee's refusal territory** |
| --- | ---: | ---: | ---: | ---: |
| L2 light | 264 | 150 | −250,000 | **8** |
| U2 ultra | 265 | 197 | −720,000 | **32** |

**Four times as many peers pushed into refusal territory**, on the same node, minutes apart, with only
the ability to pay changed. A node that cannot settle its debts is served more slowly by the peers it
owes, which is the free-allowance behaviour LAT-10 proposed and could not cleanly demonstrate.

## ⚠️ What LAT-10 got right and what it got wrong

**Right: the direction.** Ultra-light is worse for a viewer, and it is worse for the reason given.

**Wrong: the magnitude, and the instrument.** There are no 30 to 48 second freezes here. The worst
ultra arm lost **1.6% of its media** and rebuffered seventeen times over three minutes. That is a bad
viewing experience and it is two orders of magnitude away from what the broken instrument reported.
The retraction stands: the freezes were the feed lookup. What ultra-light actually costs is smaller,
real, and had never been seen.

## The confound that resolved itself

`deploy.sh` did not recreate the container for L1, because its configuration had not changed, so
**L1 ran on peers warmed over hours while U1, L2 and U2 each had 45 seconds.** That asymmetry favours
L1 and was expected to be the caveat on this result.

It went the other way. **L2, the cold light arm, beat L1, the warm one, on every axis** — 5.32s
behind live against 5.96s, 65.5ms transfer against 91ms. So peer warmth is not what separates these
arms, and if it biased anything it biased against light. The comparison holds without the caveat.

## What this does not say

**Three minutes per arm, two arms each.** Enough to establish a direction this clear, not to put an
interval on it.

**720p/2500k only.** [[Quality at a viewer]](quality-at-a-viewer-2026-08-06.md) showed 1080p/6000k
needs 2.3x the bandwidth, and ultra-light's cost is a bandwidth cost, so the gap would be expected to
widen. Untested.

**One viewer.** A second viewer adds load rather than sharing it, so the ultra arm's margin would be
expected to shrink faster than the light arm's. Untested.

**Nothing here says a funded chequebook is required**, only what running without one costs. An
operator who can accept seventeen rebuffers in three minutes can run ultra-light for free.
