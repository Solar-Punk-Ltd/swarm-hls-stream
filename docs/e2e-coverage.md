# What the e2e suite covers, and what it does not

**As of 2026-09-02.** A living map from product functionality to the live end-to-end scenarios that
exercise it, and to when each one was last green against a real deployment. It is here so that
"is that tested" has one answer rather than a search, and so that a gap is written down as a gap
instead of being inferred from a suite nobody wrote.

Every status below is a **live** status. The suites under `e2e/suites/` drive a deployed stack, so a
green here means a real broadcast really ran, not that a unit test passed. Nothing under `suites/`
runs in CI.

## Run profiles

A **run profile** is a saved, named set of the environment values that decide what a sitting IS. It
answers "which run is this" and never "where does the stack live". The files are
`e2e/profiles/<name>.env` and the loader is `e2e/src/profiles.ts`.

| Profile        | Where segment bytes come from                | Notes                                                                  |
| -------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `in-browser`   | a Swarm node running in the viewer's own tab | **The default.** The in-tab node is the subject this project measures. |
| `light-client` | a gateway                                    | The control. A viewer with no node of their own.                       |

The byte source is the only condition that differs between the two, and the segment length differs
partly **because** of it. Both declare that the run covers the ABR ladder.

⛔⛔⛔ **Do not reconcile the two segment lengths.** `in-browser` declares `E2E_EXPECT_SEGMENT_S=2`
and `light-client` declares `1.0`, and that is a product trade rather than a drift.

⚠️ **light-client moved from 0.5 to 1.0 on 2026-09-01, and NOT because the byte-source measurement
changed.** SRS announces each closed segment once per rung, so a four-rung ladder asks for
`rungs / HLS_FRAGMENT` announcements a second. At 0.5s that is 8.0/s against the ~6.7/s SRS was
measured sustaining, and the shortfall becomes lag growing 0.46s per second of video until it passes
`HLS_WINDOW`, after which SRS deletes each segment before announcing it and the 1080p rung is
unpublished about two minutes in. At 1.0s the ladder asks 4.0/s and a 600s run held lag flat at 0.0s
with zero segments lost on any rung. `in-browser` at 2.0s asks 2.0/s and was never exposed to it.
**0.5s remains where the gateway path measures best. It is unreachable while four rungs are
announced.** See the block above `HLS_FRAGMENT` in `engines/srs/entrypoint.sh`.

The byte-source trade below still stands on its own terms. Measured
2026-08-16 by the sibling repo `swarm-stream-loadlab`, in
`docs/measurements/2026-08-16-a-stock-tab-holds-realtime-on-two-second-segments.md`, and carried
unresolved as Q23 of its `docs/spec/product-spec.md`: a stock in-tab weeb-3 node holds **1.000x of
realtime on 2s segments** with about 90s of buffer and **0.426x on 0.5s** with 0.5 to 3.5s, because
it admits about one segment per second whatever its peer count. The gateway measures the other way
over 21 funded arms, 0.5s beating 2s at **1.55s against 3.88s** of capture-to-fetchable latency.
So a run of the pair is two sittings against two stages, and equalising the pair would hand one
viewer type a stage it cannot run on while the report went on naming the profile.

That declaration is spelled `E2E_EXPECT_ABR=true`, and **never the word `ladder`**. The variable
takes `ABR_ENABLED`'s own spellings, which are `true`, `1`, `false`, `0` or unset, so that an
operator setting both does not have to remember two vocabularies. A run that is single-rendition on
purpose says `E2E_EXPECT_ABR=false` and is never asked again. Anything else is refused rather than
read as undeclared, because reading a typo as "said nothing" would waive the gate on the exact run
somebody was being careful about.

Pick one with `E2E_RUN_PROFILE=light-client`. An unknown name stops the run and lists the names that
exist.

**Explicit environment beats the profile.** Precedence is explicit, then profile, then unset. A value
the operator exported is a deliberate choice about one run, and the profile stands down on it and
says which keys it stood down on. Presence decides this rather than truthiness, so a value blanked
on purpose stays blank.

**A profile carries no infrastructure.** The host, the ports, the ssh target and the compose profile
name a machine rather than a run, so they stay in the environment and in the deployment's own env
files. `E2E_PROFILE`, `E2E_PORT_SLOT` and `E2E_RUN_PROFILE` are refused inside a profile file.

**Measurement sittings exist to refine the values in these files.** When a sitting settles a number,
the number moves into the profile and the next run inherits it. That is the point of naming them:
the numbers are meant to move, and a run asked for by name picks up the current ones.

`e2e/suites/preflight/profile.test.ts` refuses a run whose declarations contradict themselves, before
anything is asked of the deployment. It checks only what needs no network, which includes a run that
declared no segment length at all.

`e2e/suites/preflight/segment-length.test.ts` refuses a run whose **deployed stage** cuts at the other
viewer type's length. It reads the config the running SRS container was started on, through one
`docker exec cat`, so it costs no broadcast, no stamp and no BZZ, and changes nothing. That makes it
a prediction from the running config rather than an observation of published media: an encoder
missing the cadence its own config asks for is invisible here, and is what
`deploy/scripts/stage-fingerprint.sh` catches from raw `#EXTINF` during a sitting. A run that pins no
length says `E2E_EXPECT_SEGMENT_S=any` once, which is also the answer for OME, whose segmenter config
this cannot read.

⚠️ **A run declaring `any` also reaches V4 without a length, so V4 records a segment-count target instead and asks everything except whether the recording covers the whole broadcast.** VOD playback checks that a recording is the whole
broadcast, and a broadcast length cannot be computed from a segment count when no segment length was
declared. The suite runs everything else and prints, under its observations, that the one question
was not asked, so an `any` run keeps its VOD coverage and the totals show the suite ran.

`e2e/suites/preflight/uploader-log-shape.test.ts` refuses a stage whose **deployed uploader** predates
the log messages this harness parses. Every upload-side assertion is read out of the uploader's own
log, so a message reworded in this checkout and not yet deployed leaves the pattern matching nothing
and the scenario blaming the product for a silence.

That cost a paid sitting on 2026-09-01. The manifest publish line gained a stream id that morning.
`bench-on-host.sh` syncs this repo to the host and runs the harness from it, and does **not** redeploy
the uploader, which ships as a prebuilt `dist/`. `bee-outage-long` and `service/happy-path` both went
red for "manifest publishes never resumed" against a stage that was publishing manifests throughout.

It reads the container's built code rather than a log, because a preflight runs before anything
publishes and an idle stage would look identical to a stale one. One `docker exec`, no BZZ. ⛔ Its
refusal names redeploying as the fix and rewording the patterns as the wrong one, because the wrong
one is tempting and buys a green run against code nobody is shipping.

Since 2026-09-01 it lists every family the harness parses, fifteen in all: the four originals, the
finalize flips and session ends seven scenarios wait on, the four lines that arm a discontinuity
(six suites assert that count is zero, and a line nothing matches passes them vacuously green), the
catalog-lost discriminator, the catalog announce, and the finalize that resumes rather than
republishes after a crash. That last one is the newest, added with `f2e7305`, and it reports whether
scenario H's kill landed inside the window it aims at. A deployment that cannot write it still passes
the scenario, and passes it without anyone being able to say the window was ever exercised. Two of
the fifteen refuse any uploader built
before the messages moved into the shared contract even though no wording changed, one string used
to be assembled across a `+` join and one lived in a file the gate does not read, so the first run
after this checkout lands asks for exactly one redeploy.

`logLevel.ts` and `suites/smoke/attach.test.ts` guard the sibling precondition, whether the
deployment's `LOG_LEVEL` admits these lines at all. Level and shape are separate questions and both
have now been answered the expensive way once.

`e2e/src/harness/stageStamps.ts` gates every suite's `before()` on postage: every Bee node the
uploader publishes through must hold a usable batch with more TTL than the run needs, or the suite
refuses before its publisher starts. The check it replaced read the coordinator alone and spoke for
the stage, so an expired batch on the 1080p node passed it and surfaced mid-broadcast as a rung that
stopped being produced, which reaches a viewer as an ABR fault and gets scored as one. The gateway
node is deliberately not read, it holds no upload batch, and batch utilization stays with
`deploy/scripts/stamp-guard.sh` and the uploader's own `PostageGate`.

## The map

| Functionality                                                                                            | Today                                                                               | Plan                                           |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| Publish, gapless segments, manifest advances                                                             | `happy-path`, green in the 2026-09-01 sittings two, three and four                  | rerun on ladder deploy                         |
| Ladder: 4 rungs publish, one group, gapless                                                              | `abr-ladder`, never green (attempted 2026-08-27, instrument defects since fixed)    | first green pending                            |
| Ladder survives engine restart as one ladder                                                             | `abr-engine-restart`, same status                                                   | first green pending                            |
| One rung dies, others carry on                                                                           | both legs built: the viewer steps down (V3) and the master stops advertising it     | rerun, neither leg has run inside a full suite |
| Uploader crash recovery                                                                                  | F, green 2026-08-03                                                                 | rerun                                          |
| Finalize/recovery family (mid-finalize kill, whole-stack restart, corrupt entry, reconnect during drain) | H I J K, all green in sitting four 2026-09-01, H after `f2e7305`                    | rerun, H's resume path has not run live yet    |
| Writer bee outage short and long                                                                         | A B, green 2026-08-03                                                               | rerun                                          |
| Gateway outage, upload side                                                                              | G, green 2026-08-03                                                                 | rerun                                          |
| Catalog live to VOD, /health lifecycle                                                                   | green 2026-08-03                                                                    | rerun                                          |
| Two simultaneous broadcasts                                                                              | green 2026-08-03, single-rendition only                                             | ladder version planned after viewer scenarios  |
| Viewer: live playback in a real browser                                                                  | V1, built 2026-08-28                                                                | run both profiles                              |
| Viewer: quality switch works                                                                             | V2, built 2026-08-30, green through a gateway                                       | rerun on the 1.0s stage                        |
| Viewer: rung goes quiet, viewer steps down instead of freezing                                           | V3, built 2026-08-30, failover armed 2026-09-01 and green live                      | rerun, it has never run with the failover on   |
| Viewer: VOD playback                                                                                     | V4, built 2026-08-30, green three for three, asks all but broadcast length on `any` | rerun on the 1.0s stage                        |
| Viewer: broadcast ends cleanly on screen                                                                 | V5, built 2026-08-28                                                                | rerun                                          |
| Viewer crash matrix (5 faults at a viewer)                                                               | V6 to V10, promoted 2026-08-29, first green pending                                 | run both profiles                              |
| weeb3 actually served the bytes (arm proof)                                                              | sitting-only assertion                                                              | built into every in-browser viewer test        |

### Reading the letters

The single letters are the scenario labels the suite files carry in their own docblocks.

| Letter | File                                                   |
| ------ | ------------------------------------------------------ |
| A      | `e2e/suites/scenarios/bee-outage-short.test.ts`        |
| B      | `e2e/suites/scenarios/bee-outage-long.test.ts`         |
| F      | `e2e/suites/scenarios/uploader-crash-recovery.test.ts` |
| G      | `e2e/suites/scenarios/gateway-outage-viewer.test.ts`   |
| H      | `e2e/suites/scenarios/finalize-crash.test.ts`          |
| I      | `e2e/suites/scenarios/whole-stack-restart.test.ts`     |
| J      | `e2e/suites/scenarios/recovery-entry-corrupt.test.ts`  |
| K      | `e2e/suites/scenarios/reconnect-during-drain.test.ts`  |

### Reading the V numbers

The V numbers are the viewer scenarios, the ones that open a real browser. V2, V3 and V4 were held
empty when this table was first written and were built on 2026-08-30.

| Number | File                                                | Built |
| ------ | --------------------------------------------------- | ----- |
| V1     | `e2e/suites/viewer/live-playback.test.ts`           | yes   |
| V2     | `e2e/suites/viewer/quality-switch.test.ts`          | yes   |
| V3     | `e2e/suites/viewer/rung-outage.test.ts`             | yes   |
| V4     | `e2e/suites/viewer/vod-playback.test.ts`            | yes   |
| V5     | `e2e/suites/viewer/broadcast-ended.test.ts`         | yes   |
| V6     | `e2e/suites/viewer/crash-gateway-outage.test.ts`    | yes   |
| V7     | `e2e/suites/viewer/crash-uploader-killed.test.ts`   | yes   |
| V8     | `e2e/suites/viewer/crash-writer-bee-pause.test.ts`  | yes   |
| V9     | `e2e/suites/viewer/crash-writer-bee-outage.test.ts` | yes   |
| V10    | `e2e/suites/viewer/crash-engine-restart.test.ts`    | yes   |

V6 to V10 are the 2026-08-27 crash matrix promoted into pass/fail, one file per fault. The matrix ran
six arms over five faults: the gateway outage was measured twice, once with segment bytes from a node
in the tab and once through a gateway, and those are V6 under each of the two run profiles rather
than two files.

⚠️ **V7 and V9 tolerate the overlay saying nothing.** Both pass `mustSpeak: false`, so they refuse
only what is untrue and let silence through, and each prints whether the client explained the freeze
as an observation rather than an assertion. That is issue #100: this client may genuinely not know
what happened, so the day it starts explaining the fault both cases stay green.

⛔ **This paragraph said the opposite until 2026-09-01**, claiming both asserted the defect and would
turn red when #100 was fixed. They were changed to the tolerant form and the doc was not. Read the
`frozenOverlayRefusal` call in the suite, not this table, before predicting what a run will do.

**What made V9 red on 2026-08-31 was `resumeRefusal`, not the overlay**: one rung's node stopped,
three kept publishing, and the viewer never played through the break at all. That is the cost of
having no failover, and the failover was armed on 2026-09-01, so V9 is expected to go **green**.

### What "driver only" means

A driver is a script under `e2e/browser/` that a human runs and reads the output of. It produces a
report. It does not pass or fail, so nothing stops a regression in it. The V-numbered rows are the
plan to turn those drivers into scenarios that have a verdict.

### What "both profiles" means

The scenario runs twice, once under each run profile, so the same assertion is made about a viewer
whose bytes come from their own tab and about a viewer reading through a gateway. A viewer result
that holds in one and not the other is a finding rather than a flake.
