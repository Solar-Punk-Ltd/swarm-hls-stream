# Plan: make the viewer side of ABR a tested property

Written 2026-08-29, after the owner asked where the ABR viewer tests and the per-rung publisher
tests were. The answer was that neither exists. This is the plan to get them.

## The gap, stated once

**Every ABR test reads the uploader's log. None of them opens a browser.** Seven assertions across
two suites prove the encoder produced four rungs, one uploader wrote all four without dropping
anything, they stayed grouped as one catalog entry, and they came back after an engine restart.

That is the plumbing. It says nothing about a viewer receiving more than one quality, and nothing
about ever switching between them.

⚠️ **Recounted 2026-09-02, and the shape of the gap has changed.** `e2e/suites/` holds thirty-six
test files: nine preflight gates, one smoke check, and twenty-six live scenario suites. Ten of the
twenty-six open a real browser, which is every V-numbered file and nothing else. They carry live
playback, the end of a broadcast, five crash faults, and since 2026-08-30 the three ABR viewer tests
this plan was written to get: the quality switch (V2), the rung outage (V3) and VOD (V4). ✅ **So
three of the ten are ABR tests, and VOD is watched.** Concurrent broadcasts are still unwatched, and
deliberately so, for the reason at the end of phase 2.

⚠️ `suites/scenarios/gateway-outage-viewer.test.ts` has "viewer" in its name and opens no browser.
It tests the upload side while a viewer's gateway is down.

## Phase 1 — assert what the watching tests already observe

**Free. No infrastructure, no broadcast, no BZZ.** The data is already captured and printed under
"observations, none of them asserted".

V1 records the rung a viewer actually received (1920x1080 on the last in-browser run) and asserts
nothing about it. The five crash suites capture the same. Promote the ones that are facts about the
product rather than about timing:

- the viewer received a rung that is **in `ABR_LADDER`**, rather than any resolution at all
- the viewer received a **single consistent** rung for the whole watch, or a set of rungs all of
  which are in the ladder
- ⛔ **not** which rung. Which rung a player picks is its own adaptive decision and pinning it would
  be a performance assertion wearing a correctness coat. See
  [owner rule](../..) on correctness over performance.

**Done when:** a viewer silently stuck on a rung outside the configured ladder fails a test.

**What it does not buy:** it cannot catch a failure to _switch_. That is phase 2.

## Phase 2 — the three watching tests that were planned and never built

Run time and harness work. No new infrastructure. Numbers reserved in `docs/e2e-coverage.md`.

> ✅ **ALL FOUR BUILT 2026-08-30, AND ALL THREE VIEWER CASES HAVE NOW RUN LIVE.** V2, V3, V4 and the
> concurrent-ladder case, with 120 new unit tests behind them. Four sittings across 2026-08-31 and
> 2026-09-01 put them on real broadcasts. V4 is green repeatedly, V3 is green three times out of
> four, and V2 is red with a measured cause rather than an unexplained one. V5, which predates this
> phase, is green.
>
> ⚠️ **A green here is a live green.** Each of the four still names, in its own docblock, the one
> thing in it most likely to be wrong, and those warnings are worth reading before a rerun on a stage
> that has changed under them.

### V2, quality switch works — ⛔ BUILT 2026-08-30, RED across four sittings, cause measured

`pnpm browser:quality` and `suites/viewer/quality-switch.test.ts`. 42 unit tests.

⛔ **Red four times, and the fourth sitting's instrument flipped the diagnosis.** Per-fragment
reading from 2026-09-01: 57 requests for the top rung before the cap, then one top-rung request and
six bottom-rung requests **while capped**, then a climb back after the cap lifted. So the player does
ask for the lower rung, and it asks within about four seconds. What never happens is a lower rung
becoming the picture on screen inside the cap, because those capped fetches do not complete. Only
seven requests were made in a sixty-second cap where a healthy player makes about thirty. **The
earlier framing, that the player decides and never executes, is dead and should not be repeated.**
The switch is requested and the fetch starves.

⚠️ The artifact aggregated the raw request list away, so this run cannot say whether those six were
six fragments or one fragment retried six times. A second instrument keeps the raw list and records
how each fetch ended, and that is what the next sitting reads.

⛔ **One thing in it is unverified and could make it red for a reason that is not the product's.**
Chromium applies the network cap itself, and whether it reaches an in-tab node's own peer connections
is the browser's business. So `throttleRefusal` demands the player's own bandwidth estimate be at or
below the cap before any product assertion runs, and refuses the arm otherwise. A run that skipped
that gate and reported "the ladder does not adapt" would be filing a finding about Chromium against
this client.

Throttle the tab's network mid-playback through the debug protocol, assert the player steps **down**
a rung and keeps playing, release the throttle, assert it climbs back.

⛔ **Assert the transition, never the timing of it.** "Moved to a lower rung and never stopped
playing" is correctness. "Moved within N seconds" is a performance threshold and does not belong
here.

⚠️ The in-browser and gateway profiles will behave differently, because their byte sources differ by
an order of magnitude in request count. Run both, expect both to switch, compare nothing.

**Done when:** a client that ignores bandwidth and rides one rung into a stall fails.

### V3, a rung goes quiet and the viewer steps down — ✅ BUILT 2026-08-30, GREEN LIVE, three of four

`pnpm browser:rung-outage` and `suites/viewer/rung-outage.test.ts`. SRS runs one ffmpeg per rung, so
the fault is a SIGSTOP on the transcode producing the rung the viewer settled on, read off the
overlay after the settle rather than hardcoded.

✅ **This section used to predict a red and call the red the finding. The prediction was refuted, by
the fix that answers it.** The reasoning was that hls.js changes level on a fragment load ERROR,
that a Swarm feed which stops advancing does not error but simply stops offering fragments, and that
a player waiting for one it was never offered has nothing to react to. That was exactly the behaviour
the client had, and it is what the rung failover armed in `b1414c0` replaced. Since then V3 has run
four times and gone green three of them, with one red that logged nothing at all and still has no
cause. The freeze the paragraph predicted is the pre-failover behaviour and is no longer what a run
measures.

Stop one rung at the engine while a viewer watches it. Assert the viewer moves to a surviving rung
rather than freezing, and that the overlay does not claim the broadcast ended.

**Done when:** a viewer frozen on a dead rung while three healthy ones sit beside it fails.

### V4, VOD playback in a browser — ✅ BUILT 2026-08-30, GREEN LIVE, every run so far

`suites/viewer/vod-playback.test.ts`, on an extended `pnpm browser:vod`.

⚠️ **It does not run at all on a stage that pins no segment length.** A run declaring
`E2E_EXPECT_SEGMENT_S=any` skips the whole file, because a broadcast length cannot be computed from a
segment count without one, and a skip is the honest answer where the arithmetic has no input. So a
green suite on an `any` run is a suite that never asked this question.

⛔ **The gap it closes.** A ladder recording whose master resolved and whose upper rung playlists did
not plays perfectly at its bottom rung: it starts, the duration is finite, the seeks land, the
picture moves. Every reading the old driver took called that a pass. It now samples the shipped
overlay and reports which rungs the recording offered.

The suite publishes its own broadcast rather than reusing one, because whether a recording is the
WHOLE broadcast cannot be asked of a recording whose length nobody knows.

Play a finished ladder recording end to end. Assert the master and every rung resolve, the picture
advances, and the timeline is the whole broadcast.

**Done when:** a recording that only plays its lowest rung fails.

### Also here, cheaply — ✅ BUILT 2026-08-30

`suites/service/multi-stream-concurrent.test.ts` now asserts that BOTH concurrent streams carry the
whole ladder, per ladder rather than across both, and that every rung-stream stays gapless while
another ladder publishes beside it. Two concurrent ladders are eight transcodes and eight rung
uploads through one bee node, which is a materially different load from the one the ladder has ever
been tested under, and a rung missing from the second stream passed every assertion that file made.

It reads the log the existing case already produces, so it costs no extra broadcast.

⚠️ Not watched by a browser, and deliberately. Concurrent tabs starve each other on the in-tab path:
three tabs measured zero peers, never re-dialling and never erroring. Two watched ladders would be a
measurement of that rather than of concurrency.

## Phase 3 — per-rung bee nodes, the shape we meant to ship

✅ **The split is deployed. `BEE_PUBLISHERS` names one Bee node per rung, and a gate proves it before
every sitting.** This section used to open by saying the variable had never been deployed or tested
live, which was true when it was written on 2026-08-29 and stopped being true on 2026-08-31, when the
four-node stage was funded, wired and ran its first sitting. The gates that read all four nodes
rather than one landed the day after.

⛔⛔ **Every throughput and cost figure taken before 2026-08-31 is still a single-node figure**, and
none of them describes the deployment shape the design intends. That does not change by deploying the
split. It changes by re-measuring on it.

Where the three blockers stand:

1. ✅ **Three more uploading bee nodes, done.** Each carries its own funded chequebook and its own
   postage batch, provisioned by `deploy/scripts/bee-publishers.sh`.
2. ✅ **A preflight that refuses the lie, done.** `e2e/suites/preflight/bee-publishers.test.ts` reads
   the shape the deployment declares and the shape the uploader reports on `/health`, and the sitting
   does not start unless the two agree. It never skips, because an unsplit deployment is the case it
   most needs to report. The postage and chequebook preflights read every node behind that same
   routing rather than the coordinator alone.
3. ⛔ **Still open. The tests that only mean something with four nodes:**
   - each rung's bytes actually leave through its own node, proven from the four nodes' **own**
     counters and not from the uploader's log
   - one node's batch runs dry and only that rung degrades, the other three keep publishing
   - one node is killed and the ladder stays one catalog entry across the survivors
   - a viewer keeps a working ladder throughout

**Done when:** losing one node costs one quality instead of the broadcast, and a test says so.

## Open reds, not part of the phases

- **H, killed inside finalize. ✅ CAUSED AND FIXED 2026-09-01**, and the segment-length story here was
  a coincidence rather than a mechanism. Read off the host log: a rung recovered from the crash
  announces itself before it finalizes, that announcement carries no `index` because it has not
  published its recording yet, and `mergeRendition` replaced the finished rendition wholesale. The
  index went, `renditions.every(r => r.index)` went false, and **the whole finished ladder went back
  to `live` in the catalog** until the recovery timer finalized it a second time. So for about a
  minute an ended recording was advertised as a live broadcast, which is the larger half of the harm.
  Fixed in `StreamCatalog.keepingWhatFinished`.

  **There was a second cause, and it cost money rather than accuracy.** The recovery timer did not
  merely re-flip the catalog, it re-ran the whole finalize: a second VOD manifest was published and
  paid for, and the catalog moved to name the newer one. The discriminator read zero catalog losses,
  so that second finalize was honest against a feed that genuinely still said live. Fixed in
  `f2e7305`: the ladder flip announce now happens after the feed write takes, so the line means the
  entry is already vod, and a finalize on a session rebuilt from a recovery entry first reads its own
  manifest feed head. A finished recording found there is resumed at the catalog write and never
  republished, through a new log line that is deliberately not a flip. An unreadable head defers to
  the next boot rather than guessing, because the guess costs a recording.

  ✅ **Both fixes are deployed**, on the late 2026-09-01 redeploy, and **H ran green on that stack** in
  the fourth sitting: one flip, zero catalog losses, zero resumes, four of four renditions kept, no
  recovery entry left behind. ⚠️ That run's kill landed after finalize had completed, so the green
  proves the clean ordering and not the resume path. The resume path is covered by thirteen unit
  tests and has not yet been exercised live, because moving the announce later also moved it out of
  the window the kill is armed on.

- **E, media-engine restart. ✅ PASSES** in the 2026-09-01 sitting. It was last seen cancelled by a
  timeout rather than failing an assertion, and nothing was changed for it, so treat this as one
  green rather than as a diagnosis.
- **V8's counter is soft.** `discontinuitiesArmed` counts log lines across three different messages,
  one of which repeats the same segment up to four times. It is not a count of discontinuities and
  any figure quoted from it should be treated as an upper bound.

## Order and why

1, then 2, then 3. Phase 1 is free and closes the worst gap in what the current green already
claims. Phase 2 makes ABR a tested feature rather than a described one. Phase 3 is the largest and it
replaces a body of single-node measurements, so it is worth doing after the viewer side is
trustworthy enough to judge it by. ⚠️ Its infrastructure blocker is gone as of 2026-08-31, so what is
left of it is run time on four nodes rather than nodes to run on.
