# Eliminating the periodic freeze (LAT-10)

Written 2026-08-04, after the owner said the decisive thing: **earlier versions of this setup streamed
without this freeze.**

## The reframe, and why it matters more than anything measured so far

Every experiment to date treated the freeze as a property of Bee to be characterised. If a previous
version of this setup did not freeze, it is a **regression**, and a regression is a diff rather than a
mystery. That converts an unbounded search into a bisect.

It also means the current conclusion, "the residual is Bee's single-owner-chunk retrieval", is at best
incomplete. Bee may well be slow at this, but something on our side changed to expose it.

**Latency is negotiable, the freeze is not.** The target is a stream that does not stop, and periodic
30 to 45 second stalls are disqualifying against a web2 competitor regardless of how good the median
looks.

## What is needed from the owner to make this cheap

The single highest-value input is what "before" was. Even approximately:

- **roughly when** it worked, and for how long
- **what the viewer read from**: a public gateway, a full node, or a dedicated light gateway like now
- **which bee version**, or just which month
- **same host** or somewhere else

The most valuable of these is the second. If viewers previously read from a public gateway or a full
node, and today read from a dedicated light node, that difference alone could be the whole finding.

## The loop

Every cycle is: **one variable, one paired measurement against the standing baseline, keep or revert.**

The harness for this exists as of today and is calibrated, which is what makes the loop cheap:

- `bench:longrun` reports `feedPolls`, every poll including the ones that found nothing
- `meanStalenessMs` as the headline, because it needs no cutoff
- the **null control**: mislabel quarters of past unchanged runs and see what the metric does anyway.
  It moves up to 1.95x. Anything smaller than that from a four-level design is noise
- the **paired alternating design**, validated at zero false positives across seven unchanged runs,
  resolution about ±15%
- **phase alignment on the transition**, never a population comparison. A distribution test is
  structurally blind to an effect sharing the period of the symptom, and it has already refuted one
  true claim and one false one in this project

**The standing baseline is eight 30-minute runs at 720p 2500kbps, 2.0s GOP**, all with the nodes
unreachable inbound and both in light mode. Any change is measured against that, at that setting.

## Ranked hypotheses, each with its experiment

Ranked by how much they would explain, times how cheap they are to test.

### H1 — Inbound reachability. IN FLIGHT

Both nodes reported `isReachable: false` / `Private` for the whole project. The owner opened p2p 10076
and 10078 on 2026-08-04 and both flipped to `isReachable: true` immediately, without a restart.

A node nothing can dial builds its Kademlia table only from its own outbound dials, so its bins toward
distant prefixes can be thin. That affects push routing and retrieval routing, not just inbound serving,
which is the reasoning error that kept this at the bottom of the list for two days.

**Experiment**: 30-minute run at the baseline setting, compared against the eight-run baseline.
**Started 2026-08-04.** Cost: one run.

### ⛔ NOT A HYPOTHESIS: light nodes are a constraint, not a choice to test

`deploy/docker-compose.yml` hardcodes `--full-node=false` on `bee-gateway`, and both nodes run with
`reserveSize: 0`, `storageRadius: 0`, `pullsyncRate: 0`. A light node stores nothing and syncs nothing,
so every chunk it serves is fetched on demand at the moment it is asked for.

**Owner decision, 2026-08-04: no full nodes.** So this is not an experiment, it is a boundary on every
other one.

What it implies, and it is worth being explicit because it narrows the whole problem: **on-demand
single-owner-chunk retrieval latency is the entire game.** There is no reserve to serve the
announcement from and no pullsync to have fetched it in advance. Every remaining lever must either
make that one retrieval faster or stop the product depending on it. That is why the architecture
section below is not a last resort here, it is a serious candidate.

### H3 — Bee version

Currently 2.8.1 on both nodes. If the working setup ran an older bee, this is a one-line test.

**Experiment**: pin the previous minor in compose, redeploy the gateway only, re-measure.
**Cost**: one run. Blocked on knowing which version to try, so it needs the owner's input above.

### ~~H4 — The feed write carries no redundancy~~ ELIMINATED 2026-08-04, without a run

`FeedUploadOptions extends UploadOptions, FeedUpdateOptions`, and `UploadOptions` is
`{ act?, pin?, encrypt?, deferred? }`. **bee-js cannot put `redundancyLevel` on a feed write at all.**

The reason is principled rather than an oversight, and it is worth recording because it closes the
question permanently: **a single-owner chunk is one chunk.** Erasure coding spreads data across
chunks, so a single chunk has nothing to encode. Replication of one chunk is exactly what the storage
neighbourhood provides by design. The asymmetry against the segment write is real but it is a category
difference, not a missing option.

`deferred` was the only knob on that call that mattered, and it is already flipped.

### H4 (original text, kept for the reasoning)

`uploadDataAsSoc` writes with `{ index, deferred: false }`. The segment write alongside it uses
`{ redundancyLevel: 1, deferred: true }`. So the announcement, which is the thing that is slow, is the
one written without redundancy, and the bulk data that arrives in 0.8s has it.

That asymmetry was never deliberate about redundancy. It was about `deferred`.

**Experiment**: add `redundancyLevel` to the SOC write, measure. If erasure coding places additional
copies, a reader has more places to find it.
**Cost**: a one-line code change plus a run. Cheapest code change on the list.

### H5 — Postage batch shape

Depth 22, mutable, and it fills to 64/64 within about two days at this write rate, after which a
mutable batch silently overwrites. The freeze was first seen at 9.4% utilization so a full batch is not
the cause, but depth and immutability affect where chunks land and how peers treat their stamps.

**Experiment**: a fresh immutable batch at a different depth, measured at the baseline setting.
**Cost**: an on-chain purchase, so the owner's. Low priority until H1 to H4 are done.

### H6 — bee-js feed semantics

We use `makeFeedWriter(...).uploadPayload`. Worth a read against the current bee-js docs for whether a
different feed type or write path produces chunks that propagate differently. This is a code review
rather than an experiment, and it belongs in the same pass as H4.

## Code review, scoped

Not a general review. Three questions only, all about the announcement path:

1. **Is the SOC written the best way bee-js offers?** Feed type, redundancy, stamp handling,
   index management. H4 and H6 come out of this.
2. **Does anything in the write path have a period near 63 seconds?** Already checked and the answer is
   no: the manifest is windowed at 10 segments so it stays one chunk, there is no `setInterval` in the
   uploader, and `RECOVERY_TIMEOUT`/`SEGMENT_STALL_MS` are one-shot and health-only. **Closed.**
3. **What happens when an upload fails?** Mutation testing showed both upload catch blocks survive
   being emptied, so nothing tests the path that runs when the network misbehaves. Filed separately.

## If it turns out to be genuinely Bee: the architecture that sidesteps it

Worth stating now so it is a decision rather than a retreat.

**The video is already on the viewer's machine.** Segments reach a viewer's gateway in 0.8s. Only the
single-owner chunk announcing them is slow. So **any faster route for segment references restores
liveness without touching how the bytes travel.**

The concrete version: the client subscribes to the uploader for "segment N exists at ref X", and still
fetches every byte from Swarm. The control plane becomes centralised, the data plane stays
decentralised, and the freeze disappears because the announcement no longer waits on SOC retrieval.

That is a real trade and should not be made casually, but against a web2 competitor a 30 second stall
is disqualifying and a centralised notification channel is not. Keep the SOC feed as the durable,
verifiable record and as the fallback when the channel is unavailable.

## Order of work

1. **H1** result, in flight
2. ~~H4~~ **eliminated without a run**: bee-js cannot carry redundancy on a feed write, and a single
   chunk has nothing to erasure code. This removed the last configuration lever that could have made
   the single retrieval itself faster
3. **H3**, which now means a **downgrade**, since 2.8.1 released 2026-07-07 is the newest bee that
   exists and this repo has pinned it since the initial commit. Options are 2.7.0 (2026-02-10) and
   2.6.0 (2025-07-22). Safe form: back up the gateway data dir, **preserve `keys/` and wipe the
   rest**, so the overlay identity and the on-chain chequebook survive and no new spend is needed
4. **H5** only if the above are exhausted
5. **The announcement side-channel**, promoted from fallback to a live candidate by the no-full-node
   constraint, because with light nodes only there is no way to have the announcement waiting locally

**The configuration space is nearly exhausted, and that is the real finding of this pass.** `deferred`
is fixed, funding is fixed, cache was tested and made it worse, redundancy is not available and not
applicable, full nodes are ruled out, and the only bee versions available are older ones. After H1
reports, what remains is a downgrade and the architecture.

**The realistic expectation, stated in advance so it is not a disappointment later:** H1, H3 and H5
each move one retrieval's latency at the margin. None of them changes the fact that a light node must
fetch the announcement on demand from a network that currently takes 30 to 45 seconds to serve it. If
the regression turns out to be one of them, excellent. If not, **the side-channel is the thing that
makes this competitive**, and the sooner that is decided the less time goes into config archaeology.
