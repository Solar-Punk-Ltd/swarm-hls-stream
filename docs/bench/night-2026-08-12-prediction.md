# What three sittings are expected to find, written before any of them was paid for

**2026-08-12 evening, registered before launch.** Three sittings, 7.9 broadcast hours, about 7.7 BZZ
on the uploader and 4.5 on the gateway. Plan at `deploy/plans/night-2026-08-12.tsv`, driven by
`overnight-chain.sh`.

The point of writing this first is that a prediction made after the numbers arrive is not a
prediction. Two claims were withdrawn on 2026-08-12 alone, and both would have been caught earlier by
saying in advance what the result had to look like.

## ⭐ What is new about this night, and why it is worth saying

This is the **first unattended night here that can spend**. Every previous one ran unfunded arms, so
the node itself was the proof that nothing could be bought. What replaces that proof is a set of
gates: funding priced and refused per sitting and per arm, the postage batch checked the same way,
and both bee nodes sampled **through** every arm with a stop file written the moment either
chequebook reaches its reserve or the batch reaches its bucket line.

It is also the first night where **the nodes' own metrics are attached to the result**. Every sitting
before this was scored on what the harness saw from outside while both nodes kept a complete account
of the same events that nothing read.

## Sitting 1: what an OBS-default broadcaster gets (#91)

Two arms, `obs-default:2.0` against `shipped:0.5`, four rounds, first discarded, direction reversed
each round. 56 broadcast minutes.

| | predicted | why |
| --- | --- | --- |
| `#EXT-X-TARGETDURATION` at 2.0s GOP | **3** | segment peaks at 2.133s, `ceil()` of that is 3 |
| `#EXT-X-TARGETDURATION` at 0.5s GOP | **1** | held at 1 for all 17 arms of the buffer sweep |
| latency gap, 2.0s minus 0.5s | **2.0 to 2.7s** | measured 2.34s on 2026-08-11, decomposed on 2026-08-12 into 1.50s of segment duration and 0.83s of bytes moving |
| stalls at 2.0s | **more than at 0.5s** | the stall penalty caps at `targetduration`, so 3.0s against 1.0s |
| uploader BZZ | **0.5s costs ~19% more** | measured 2026-08-11, more segments means more synchronous feed writes |

⚠️ **The prediction that would most usefully fail** is the stall count. If a 2.0s GOP stalls no more
often than a 0.5s one over seven-minute arms, then the ratchet is a property of *how long you watch*
rather than of the GOP, and sitting 3 is where it would show up instead.

## Sitting 2: four hours at the shipping profile (#89)

One continuous broadcast, 0.5s GOP, 720p, 240 minutes, browser watching throughout, both nodes
sampled every 120s. **The longest thing this project has ever run is ten minutes**, so every number
below is an extrapolation being tested rather than a belief.

| | predicted | why, and what would refute it |
| --- | --- | --- |
| segments produced | **~28,800** | 4h at 0.5s. A shortfall is the uploader dropping segments and `segmentsSkipped` will say so |
| manifest parse cost at 4h | **~3ms, ~3MB** | interpolating the synthetic fill's 0.76ms/774KB at 1h and 13.9ms/7.6MB at 10h. ⚠️ our figure is a FLOOR: hls.js re-parses the whole playlist every refresh and that half has never been measured |
| `#EXT-X-TARGETDURATION` | **starts 1, may ratchet to 2 or 3** | one force-closed segment raises it permanently. ⭐ Whether that happens at all over four hours is the single most valuable thing here |
| the fourteen-minute collapse | **~17 chances, expect 1** | seen once in 15 runs at t=822s. A four-hour run makes a repro free rather than something to buy |
| advance ratio | **holds above 0.99 throughout** | 0.9996 over ten minutes. ⛔ If it decays with elapsed time this is the run that shows it and it is the most important negative result available tonight |
| uploader BZZ | **~3.9** | 0.97/hr measured over 17.4 min. ⚠️ n=1, and this sitting is its own best test |
| postage | **~26 buckets**, 199 to ~225 | 6.4/broadcast hour |

## Sitting 3: three hours at the OBS default (#89 at 2.0s)

Same length regime, different GOP, so this is a second question and not a replicate of sitting 2.

**Predicted: the ratchet bites here and not in sitting 2.** At a 2.0s GOP the force-close ceiling is
`fragment * aof_ratio`, segments overshoot by a roughly constant 0.135s, and `targetduration` never
falls once raised. Over three hours a 2.0s publisher gets far more chances to produce one long
segment than a seven-minute arm does.

⚠️ **If sitting 3 shows no ratchet either**, then `ceil(longest segment)` is stable in practice and
the stall-penalty mechanism, which is derived from source and arithmetic rather than observed, is
carrying more weight in this project's recommendations than the evidence supports.

## What is deliberately not being measured

- **1080p.** The burn constants in the drivers are 720p figures and 1080p costs about 2.2x. Three
  1080p sittings have already failed their controls for three different reasons.
- **#52, cold-node playback.** It needs the in-browser node's localStorage cleared between arms and a
  peer-count floor, and `viewer-arms.sh` restarts the gateway rather than the browser node. Running it
  tonight would produce arms that look clean and measure the wrong cold thing.
- **#84 and #90's re-gather.** Both need `sweep-interleaved.sh`, which has the funding gate but not
  yet the capacity gate or the node sampler.

## The stop conditions, in advance

The night stops itself, and these are the reasons it is allowed to:

1. Either chequebook under **0.5 BZZ** available. Not a budget: it is the distance from where peers
   refuse service to a node that cannot pay, which looks from outside like the network being slow.
2. The batch at **75% of its 512 buckets**. `utilization` is the fullest bucket, not the average.
3. Host load over **32 of 48 cores** at a sitting boundary. The box carries about forty other bee
   nodes and eight unrelated stacks.
4. A sitting past its deadline: 95, 270 and 210 minutes.

⭐ **A stopped sitting is a good outcome, not a failure.** Two of four sittings were cut short on
2026-08-08 and both still answered their question. A three-hour soak beats every ten-minute run in
this corpus.

⛔ **Sitting 3 will refuse to start unless the uploader chequebook is topped up**, because the funding
gate prices 180 minutes at 5.39 BZZ and the projected balance at that point is about 4.94. The command
is in the handover and moves the uploader's own idle wallet money. If it is not run, the night
delivers sittings 1 and 2 and records a named refusal for 3.
