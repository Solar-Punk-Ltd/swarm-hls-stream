# How to compare a gateway viewer with an in-browser one, given that today we cannot

**2026-08-13.** The overnight soaks measured the shipped client through a funded light gateway and
produced a rich viewer report. The in-browser node has never been measured that way, and this says
what it would take, why the obvious shortcut is the mistake that was already made once, and what the
sitting costs.

## ⛔ The problem, stated exactly

There are two harnesses and they do not measure the same thing.

|                     | fetch path                                          | instrument                               | what comes out                                                                                     |
| ------------------- | --------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **shipped client**  | Chrome → client nginx → `bee-gateway:10077` → Swarm | `e2e/browser/watch.ts`                   | latency, stalls, target ratchet, advance ratio, rebuffers, per-5-min windows, instrument soundness |
| **in-browser node** | Chrome → weeb-3 in the page → Swarm over wss        | `deploy/scripts/in-browser-*.js` via CDP | throughput, service time, concurrency                                                              |

⛔ **`packages/client` contains no weeb-3, no libp2p, no p2p of any kind**, and its only Swarm
dependency is `@ethersphere/bee-js`, an HTTP client for a gateway. So the in-browser path has **never
had a player in it**, which is why it has no latency, no stall count and no advance ratio, and why
nothing from it can be set beside last night's tables.

⛔⛔ **The first version of this document cited `client/src`, which does not exist.** The path is
`packages/client/src`. The grep returned nothing because it was pointed at nothing, and the
conclusion happened to be right for a reason that had not been checked. Re-run against the real path
it holds, and the dependency list above is the positive evidence rather than an absence. **"I could
not find X" and "there is no X" are the same return value from a grep**, which is the same defect
that produced the videoless-opening finding.

⭐⭐⭐ **This is the whole reason #44's headline was withdrawn.** "A gateway-less in-browser node does
not sustain 2.7 Mbps" was true of a throughput probe and said nothing about the product, because a
throughput probe is not a viewer. Running the two harnesses again and putting their numbers in one
table would repeat that mistake with more decimals.

## The design: one player, one report, one variable

**Do not build a second measurement. Make weeb-3 a fetch backend for the one that already works.**

A shim in the client that routes manifest and segment requests to weeb-3's in-page API instead of the
nginx gateway proxy, selected by `BROWSER_FETCH_BACKEND=gateway|weeb3`. Then `browser:watch` runs
completely unchanged and emits **the identical report** for both arms, `viewer-arms.sh` drives it,
and every gate, sampler and refusal built last night applies without modification.

⭐⭐ **And the backend is switchable under a running stream**, the way the buffer target is in
`browser:buffer-sweep`. It is a page reload, not an encoder setting. So **one continuous broadcast
serves every arm**, which removes the between-sitting confound that weakens last night's 0.5s-vs-2.0s
comparison and cuts the cost to a single broadcast.

⛔ Arms stay sequential regardless: the image serves one Xvfb display, and one weeb-3 node per machine
is a hard limit, not a preference.

## The common instrument surface

**Reported side by side, because both paths produce them identically:**

- every row of the viewer report: instrument soundness, latency (joining, median, best, worst), the
  player's own target and whether it ratcheted, advance ratio whole-session and typical, frozen
  samples, rebuffers and their milliseconds, fatal errors, buffered ahead, dropped frames, fps,
  resolution, and the per-5-minute window table
- segment fetches from the browser's own network log: count, median transfer, failure rate
- **the uploader's node metrics**, which are shared: the write path does not know who is reading
- postage, uploader chequebook, host load

**Reported separately and never in the same table, because only one side has them:**

| gateway arm only                                                     | in-browser arm only                    |
| -------------------------------------------------------------------- | -------------------------------------- |
| `bee_retrieval_request_duration_time`, `_attempts`, `_failure_count` | connected peer count, per sample       |
| gateway chequebook spend                                             | browser CPU, and it is single-threaded |
| retrieval cache hit behaviour                                        | wss entry points actually reached      |

⭐ **The gateway's spend column being empty for the in-browser arm is a finding, not a gap.** An
in-browser viewer costs the operator nothing on the read side. Last night the gateway spent 2.35 BZZ
serving one viewer for four hours.

## ⛔⛔ Preconditions that must be gates, not notes

Each of these has already produced a wrong or wasted result once.

1. **ONE tab.** One weeb-3 node gets ~200 peers, two get 82, three get **0** and never re-dial, with
   no error shown. The arm loop is already sequential; the gate is that a second one refuses.
2. **Log peers every sample and discard any run under ~40.** A peerless node is indistinguishable
   from a broken player from the outside: traced at 0/160 peers at t=8s, 0/0 at t=12s, still 0/0 at
   t=29s, while the page looked merely slow.
3. **The entry-point ceiling is the confound that matters most.** 319 wss entry points against 3,979
   nodes, and **our own gateway advertises no `ws`**. The gateway arm talks to the whole network and
   the in-browser arm talks to about 8% of it. ⭐ Partly controllable: bee's `--p2p-wss-enable` with
   autotls is **off by default** and turning it on for our own nodes lets weeb-3 reach them at all.
   Whatever is done, the reached-peer count is reported beside every in-browser row.
4. **Segment size dominates the in-browser path.** 90 KB segments filled 4.5% of what the node could
   carry; 4.14 MB segments gave a 0.9962 ratio. The shipping profile's segment size must be held
   identical across arms or the comparison measures size, not backend.
5. **An in-browser node serves nothing back.** Inbound is for pricing and gossip only, never
   retrieval, so a browser audience caches and supplies nothing for the next viewer. Any scaling
   claim built on the opposite is wrong.
6. **CPU numbers are not portable.** 0.79-1.05 cores at 8.34 Mbps were Apple Silicon cores on a
   laptop. A figure from the deployment host is a different unit and must not be tabled beside them.

## What it costs

| phase  | what                                                                                     |              cost |
| ------ | ---------------------------------------------------------------------------------------- | ----------------: |
| **A**  | the fetch-backend shim and the `BROWSER_FETCH_BACKEND` switch                            | free, engineering |
| **A2** | prove it on **recorded content**, which needs no broadcast: same report, both backends   |          **free** |
| **B**  | peer-count sampler shaped like `node-metrics.sh`, and a gate that refuses under 40 peers |              free |
| **C**  | the sitting: 8 arms x 8 min alternating backends against **one** continuous broadcast    |          ~1.0 BZZ |

⭐ **A2 is the checkpoint that decides whether C is worth booking.** If the shim produces a sound
report on recorded content for both backends, the paid arm is a formality. If it does not, nothing
has been spent finding out. This is the free-canary-before-the-paid-arm rule that cost four faults to
learn last night.

At 0.78 BZZ per broadcast hour plus ~0.15 per broadcast started, phase C is about **1.0 BZZ against
the 3.44 available**, and it needs no funding.

## What this will not answer

- **Scale.** One viewer on one machine. Whether an in-browser audience helps or hurts at 128 viewers
  is the separate repo's question, and point 5 above says the answer is probably "neither".
- **A real network position.** Both arms run on a deployment host with a fat pipe. A viewer on a
  domestic connection behind NAT is a third case and is not covered by either arm.
- **Whether the gateway arm's advantage is the gateway or the funding.** Last night's gateway was
  funded and light. The ultra-light and unfunded comparison is its own sitting and should be run
  first, because it is cheaper and it bounds how much of the gap the backend can even explain.
