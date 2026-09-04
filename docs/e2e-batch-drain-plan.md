# Plan: one rung's postage batch runs dry, and the broadcast survives

Written 2026-09-04 at the owner's word ("okay you can do this"). Its sibling is
`docs/e2e-viewer-coverage-plan.md`. The position marker for this plan is the e2e-state record.

## The promise, and what nothing tests

Each of the four qualities is uploaded through its own bee node with its own postage batch, a prepaid
stamp allowance. The split was asked for at the start so that one batch running dry costs one quality
and not the broadcast: the other three keep publishing, the master playlist stops offering the dead
one, and a viewer steps down and keeps watching. Every live suite proves a rung dying because its node
or its encoder stopped. None proves a rung dying because bee refused its stamps. That is a different
death: the node is up, the encoder is up, and every upload comes back with an error.

## What the code does today when a batch is refused

Read on 2026-09-04, file and line in the e2e-state record.

- An upload error with HTTP status 400 or 402 is **not retried at all**. The segment is dropped on the
  first attempt, a discontinuity is armed for the next one that lands, the line
  `Failed to upload segment N for stream S within the retry window; marking a discontinuity` is logged
  at error level, `/health` turns degraded, and the process carries on. A 5xx or a network error is
  retried for 15 seconds first. Which family bee answers for a full batch is not recorded anywhere in
  this repo. The tests assume 402. The first drain settles it.
- Each rung has its own upload queue and its own bee client, so a drained rung cannot block the other
  three. One coupling remains: the catalog and every master playlist are written through the
  **360p node's batch**, the coordinator. If that one batch dies, the master cannot be rewritten for
  anyone and the recording cannot be announced at the end. Coordinator failover is not implemented and
  the code says so.
- The master drops a rung by the shipped rule: once the ladder has delivered four segments past the
  rung's last delivery, at most one rung at a time. Nothing about the drop is a clock. It is triggered
  by the next segment another rung lands, so a drained rung disappears from the master within a few
  segments of the surviving rungs. The rung comes back on its next delivered segment. A viewer already
  watching never gets a removed level back, that is an hls.js limit the repo documents.
- The batch id per rung is read once at process start from `BEE_PUBLISHERS`. Changing it means
  rewriting the profile's env file and redeploying the uploader container. The harness can only stop,
  start, kill, pause or restart containers as they are.
- The stamp gate in front of every live suite reads each node's **best** stamp, not the one
  `BEE_PUBLISHERS` names, and it judges only that a usable stamp exists with more than ten minutes
  to live. It never reads how full a batch is. The CLI's `stamp-check` does compare the two, the gate
  does not.

So the expected product behaviour already exists by accident of the dead-rung rule. What does not
exist is a line that says why the rung went quiet, a per-rung count of dropped segments, and any proof.

## How the test forces it

Bee refuses to create a batch that would live under 24 hours: the stage's chain state reports
`minimumValidityBlocks` 17280, which is 24 hours of 5 second blocks. Expiry is therefore not a lever
inside a test. Filling is. The smallest batch bee allows, depth 17, has two stamp slots per bucket
across 65536 buckets and stops accepting chunks when any bucket gets a third. That happens after
roughly 3000 chunks, about 12 MB, which the 1080p rung produces in about 20 seconds. Buying that batch
with two days of life, so the uploader's own 24 hour startup floor is cleared with margin, costs at
today's chain price 84370 PLUR per chunk per block:

| Item                               | Figure          |
| ---------------------------------- | --------------- |
| Depth 17 batch, 2 days, 1080p node | about 0.04 BZZ  |
| Fill time at 1080p                 | about 20 s      |
| Gas on Gnosis for the purchase     | negligible xDAI |

The stage's batches are immutable, so a full batch is refused rather than overwritten, which is why the
failure mode is real for this deployment at all.

## The sitting, step by step

1. **Arm** (operator, outside the harness). The owner buys the small batch on the target rung's node,
   one command handed over by the script. A repo script then writes that batch id into the rung's
   entry of `BEE_PUBLISHERS` in the profile env, keeps the original in a `.bak`, and redeploys the
   uploader container only. The script never buys anything. `bee-publishers.sh --write` cannot be used
   for this, it picks the node's healthiest batch by design.
2. **Run** the new suite through the launch script behind the ten gates, on both byte sources. The
   suite starts a broadcast, waits for four rungs to publish, then watches the target rung fill its
   batch and go quiet. A viewer variant reuses the V3 machinery with the drain as its fault.
3. **Restore** (the same script). The original batch id is written back and the uploader redeployed.
   The small batch is spent and stays on the node as a dead entry.

What the suite asserts, all correctness, no timings:

- The three surviving rungs publish gapless through the drain, read from the uploader's own log per
  stream id, the way the ABR ladder suite already reads it.
- The drained rung logs one named line, once, saying which batch was refused and with what answer,
  then publishes nothing. Its dropped segments show up under its own rung label in the metrics.
- The uploader process stays up, no restart, `/health` degraded with the segment-failure reason.
- The master playlist stops offering the drained rung and offers the other three, and the catalog
  line `Ladder ... now produces 3 rung(s), master rewritten` is logged.
- A real viewer keeps playing, steps down at most once, overlay stays `live`, in both byte sources.
- After restore, the master offers four rungs again. A viewer who watched through the drain is not
  expected to regain the level, and the suite records that rather than asserting it.

Durations of the drop, the step-down and the restore are printed as observations, none of them
asserted.

## What it costs

| Item                                                | BZZ        |
| --------------------------------------------------- | ---------- |
| The small batch, per arming                         | about 0.04 |
| Uploader scenario, about 5 min of four rungs        | about 0.15 |
| Viewer variant, both byte sources, about 5 min each | about 0.30 |
| First proving sitting, everything above             | under 0.6  |

The build is one Opus agent working from this page, tests first, roughly a day. Two uploader
redeploys per sitting, free.

## Decisions for the owner

**Ruled 2026-09-04 by the owner: all six as recommended** ("1-6 go as recommended on each").
The recommendations below are therefore the decisions.

1. **What a drained rung should do.** Keep the behaviour the code already has, the rung goes quiet
   and the dead-rung rule removes it, and add the one named log line and the per-rung dropped count so
   the harness and an operator can tell a drained batch from a dead encoder. The alternative is the
   uploader buying itself a new batch from the node's wallet, which needs a spend policy and wallet
   funds on every node and turns a test into a money question. **Recommend: keep, add the line.**
2. **Which rung first.** 1080p is the isolated case and the one the dead-rung rule was designed
   around. 360p is the coordinator, and its batch dying takes the master rewrite and the recording
   announce down with it for all four rungs, which no rule handles today. **Recommend: 1080p now,
   and file the coordinator case as a known product gap with its own decision, priced separately if
   you want coordinator failover built.**
3. **How the stage is armed.** The owner buys the small batch, one printed command, and a repo script
   does the env rewrite and the redeploy both ways. The alternative, teaching the harness to change a
   container's environment, is a bigger change for one test. **Recommend: the script.**
4. **Make the stamp gate honest.** It should compare the node's stamp with the batch `BEE_PUBLISHERS`
   names, as the CLI already does, and refuse a mismatch. Without that, a rung configured onto a dead
   batch passes the gate on a healthy batch it is not using. **Recommend: yes, it is small and it
   protects every other suite too.**
5. **Recovery scope.** Assert that the master offers four rungs again after restore. Record, do not
   assert, that a viewer who was watching keeps three. **Recommend: as written.**
6. **Where it lives.** Its own scripts, `e2e:batch-drain` for the uploader side and
   `e2e:batch-drain-viewer` for the viewer, each run as a sitting with its own arm and restore around
   it because one small batch serves one suite, and kept out of `e2e:run`, because the ordinary full suite must never depend on a
   deliberately broken stage. **Recommend: yes.**

## What is built, in order

1. The named log line and the per-rung dropped count in the uploader, in the log contract, unit tested.
2. The stamp gate comparing configured and held batch.
3. `deploy/scripts/drain-stage.sh arm|restore` with the printed buy command, tested in the deploy
   sandbox the other scripts use.
4. The scenario suite and the viewer variant, behind the ten gates, with the new script wired into
   `bench-on-host.sh` like the others.
5. One proving sitting on both byte sources, then the coverage map row.
