# Plan: one rung's postage batch runs dry, and the broadcast survives

Written 2026-09-04 at the owner's word ("okay you can do this"). Its sibling is
`docs/e2e-viewer-coverage-plan.md`. Where this page says a reading was taken on a date, the reading
itself is in the session record kept outside the repository, and every claim about the code is meant
to be checkable against the code.

## The promise, and what nothing tests

Each of the four qualities is uploaded through its own bee node with its own postage batch, a prepaid
stamp allowance. The split was asked for at the start so that one batch running dry costs one quality
and not the broadcast: the other three keep publishing, the master playlist stops offering the dead
one, and a viewer steps down and keeps watching. Every live suite proves a rung dying because its node
or its encoder stopped. None proves a rung dying because bee refused its stamps. That is a different
death: the node is up, the encoder is up, and every upload comes back with an error.

## What the code did when a batch was refused, read 2026-09-04 before any of this was built

⛔ Kept as the reading that decided the plan, not as a description of the code now. Items 1 to 4 of
"What is built, in order" have all shipped since, so the three gaps this section ends on are closed:
the named line is `rungBatchRefused`, the per-rung count is `swarm_hls_rung_segments_dropped_total`,
and the proof is scenario L and V11. The stamp gate now judges the batch a rung is configured with
rather than the healthiest one its node holds.

- An upload error with HTTP status 400 or 402 is **not retried at all**. The segment is dropped on the
  first attempt, a discontinuity is armed for the next one that lands, the line
  `Failed to upload segment N for stream S within the retry window; marking a discontinuity` is logged
  at error level, `/health` turns degraded, and the process carries on. A 5xx or a network error is
  retried for 15 seconds first. Which family bee answers for a full batch is not recorded anywhere in
  this repo. The tests assume 402. ⛔ The first drain did not settle it: its uploader log went with the
  container the restore recreated, and the message the line carried was the HTTP client's own words
  rather than bee's, which is fixed since. So the answer is still open and the next drain sitting is
  what closes it.
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
   entry of `BEE_PUBLISHERS` in the profile env, records the rung's original batch id in
   `.drain-stage.<profile>.env`, which is the file `restore` reads, copies the whole env file to a
   `.bak-<timestamp>` beside it as a second copy nothing reads automatically, and redeploys the
   uploader container only. The script never buys anything. `bee-publishers.sh --write` cannot be used
   for this, it picks the node's healthiest batch by design.
2. **Run** the suite through the launch script behind the ten gates. Scenario L opens no browser, so
   it has one condition and not two. V11 is the half that runs on both byte sources. The
   suite starts a broadcast, waits for four rungs to publish, then watches the target rung fill its
   batch and go quiet. A viewer variant reuses the V3 machinery with the drain as its fault.
3. **Restore** (the same script). The original batch id is written back and the uploader redeployed.
   The small batch is spent and stays on the node as a dead entry.

What the suite asserts, all correctness, no timings:

- The three surviving rungs publish gapless through the drain, read from the uploader's own log per
  stream id, the way the ABR ladder suite already reads it.
- The drained rung logs the named line saying which batch was refused and with what answer, once per
  answer bee gives. Its dropped segments show up under its own rung label in the metrics. ⛔ That it
  then publishes nothing is NOT asserted: the refusal is the start of a ramp rather than the end of
  anything, and what the suite waits for instead is the master dropping the rung.
- The uploader process stays up, no restart, `/health` degraded with the segment-failure reason.
- The master playlist stops offering the drained rung and offers the other three, and the catalog
  line `Ladder ... now produces 3 rung(s), master rewritten` is logged.
- A real viewer keeps playing and is never told the broadcast ended, in both byte sources. ⛔ The
  step-down is recorded and not asserted, because the fill lands while the player is still settling
  and which rung a player rides at that moment is its own decision. V3 owns that question, with a
  fault whose instant it controls.
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
   assert, that a viewer who was watching keeps three. **Recommend: as written.** ⛔ OUTSTANDING as of
   2026-09-05: the post-restore step is `e2e:abr-ladder`, which asserts that all four rungs publish,
   read from the uploader's log, and says in its own docblock that it does not judge the master. So
   the publishing half is covered and the master half of this decision is not built yet.
6. **Where it lives.** Its own scripts, `e2e:batch-drain` for the uploader side and
   `e2e:batch-drain-viewer` for the viewer, each run as a sitting with its own arm and restore around
   it because one small batch serves one suite, and kept out of `e2e:run`, because the ordinary full suite must never depend on a
   deliberately broken stage. **Recommend: yes.**

## What the first sitting found, 2026-09-04

The first arming ran at 14:22Z on the 1080p rung with a fresh depth 17 batch, and it returned two facts
this page had wrong.

**A batch does not run dry, it degrades.** It fills bucket by bucket. At the first overflow, about 2954
chunks in, roughly one bucket in a thousand is full, so a segment of about 300 chunks is refused with a
chance of about a quarter, rising to about seven in ten by 6000 chunks and nearly all by 10000. Bee
refused the rung four times in fifty seconds with segments landing in between, and the rung falls silent
only a minute or two later. The uploader behaved as designed throughout, one dropped segment and one
discontinuity per refusal, the other three rungs untouched. What assumed a cliff was the named line,
which re-armed on every landed segment, and the suite, which asserted one refusal and then silence. The
line is now written once per stream per process, since the batch cannot change without a restart, and
the suite waits for the master to drop the rung by the product's own rule and records the ramp as
observations. The restore step also saves the uploader's log before it recreates the container, because
that first run's evidence of bee's exact answer went with the container.

**An open tension in the arithmetic, worth resolving before the next sitting.** The ramp above
predicts more refusals than the sitting saw. Fifty seconds of 1080p at the shipped rate is about
twenty five segments and roughly seven thousand chunks offered, and applying the same probabilities
forward across that window predicts on the order of eighteen refusals rather than four. The uncertain
input is whether the chunks of a refused segment consume slots at all: if bee rejects the whole upload
without storing any of it, the batch fills far more slowly than the offered count suggests and four is
the honest number. The observation is the fact and the model is the part that has to give, so the next
drain sitting should record the batch's own utilization alongside each refusal rather than inferring
it. Until then treat the ramp figures as a shape and not as a schedule.

**The stage's fragment length lived in a shell export.** The uploader redeploys around the sitting ran
without it and put the uploader on 1.0 s dating while SRS kept cutting 2.0 s, which the ten gates could
not see and the ladder suite's timeline check caught after the restore. The segment-length gate now
compares the uploader container's value with the engine's, and the durable value belongs in the
profile's engine env file, the owner's.

## What is built, in order

1. The named log line and the per-rung dropped count in the uploader, in the log contract, unit tested.
2. The stamp gate comparing configured and held batch.
3. `deploy/scripts/drain-stage.sh arm|restore` with the printed buy command, tested in the deploy
   sandbox the other scripts use.
4. The scenario suite and the viewer variant, behind the ten gates, with the new script wired into
   `bench-on-host.sh` like the others.
5. One proving sitting for scenario L, then one for V11 on each byte source, each with its own arming
   because a small batch is drained once. Then the coverage map row.
