# What the e2e suite covers, and what it does not

**As of 2026-08-29.** A living map from product functionality to the live end-to-end scenarios that
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

The byte source is the **only** thing that differs between the two, so a reading taken across the
pair carries one difference and not two. Both declare that the run covers the ABR ladder.

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
anything is asked of the deployment. It checks only what needs no network.

## The map

| Functionality                                                                                            | Today                                                                            | Plan                                           |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- |
| Publish, gapless segments, manifest advances                                                             | `happy-path`, green 2026-08-03                                                   | rerun on ladder deploy                         |
| Ladder: 4 rungs publish, one group, gapless                                                              | `abr-ladder`, never green (attempted 2026-08-27, instrument defects since fixed) | first green pending                            |
| Ladder survives engine restart as one ladder                                                             | `abr-engine-restart`, same status                                                | first green pending                            |
| One rung dies, others carry on                                                                           | gap, recorded in `abr-engine-restart` docblock                                   | new scenario planned, uploader and viewer legs |
| Uploader crash recovery                                                                                  | F, green 2026-08-03                                                              | rerun                                          |
| Finalize/recovery family (mid-finalize kill, whole-stack restart, corrupt entry, reconnect during drain) | H I J K, ran 2026-08-09 only, never in a full green                              | rerun                                          |
| Writer bee outage short and long                                                                         | A B, green 2026-08-03                                                            | rerun                                          |
| Gateway outage, upload side                                                                              | G, green 2026-08-03                                                              | rerun                                          |
| Catalog live to VOD, /health lifecycle                                                                   | green 2026-08-03                                                                 | rerun                                          |
| Two simultaneous broadcasts                                                                              | green 2026-08-03, single-rendition only                                          | ladder version planned after viewer scenarios  |
| Viewer: live playback in a real browser                                                                  | V1, built 2026-08-28                                                             | run both profiles                              |
| Viewer: quality switch works                                                                             | nothing                                                                          | new V2, both profiles                          |
| Viewer: rung goes quiet, viewer steps down instead of freezing                                           | nothing                                                                          | new V3                                         |
| Viewer: VOD playback                                                                                     | driver only                                                                      | new V4, both profiles                          |
| Viewer: broadcast ends cleanly on screen                                                                 | V5, built 2026-08-28                                                             | rerun                                          |
| Viewer crash matrix (5 faults at a viewer)                                                               | V6 to V10, promoted 2026-08-29, first green pending                              | run both profiles                              |
| weeb3 actually served the bytes (arm proof)                                                              | sitting-only assertion                                                           | built into every in-browser viewer test        |

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

The V numbers are the viewer scenarios, the ones that open a real browser. V2, V3 and V4 are rows in
the map above that nothing implements yet, and their numbers are held for them.

| Number | File                                                | Built   |
| ------ | --------------------------------------------------- | ------- |
| V1     | `e2e/suites/viewer/live-playback.test.ts`           | yes     |
| V2     | viewer: quality switch works                        | not yet |
| V3     | viewer: a rung goes quiet and the viewer steps down | not yet |
| V4     | viewer: VOD playback                                | not yet |
| V5     | `e2e/suites/viewer/broadcast-ended.test.ts`         | yes     |
| V6     | `e2e/suites/viewer/crash-gateway-outage.test.ts`    | yes     |
| V7     | `e2e/suites/viewer/crash-uploader-killed.test.ts`   | yes     |
| V8     | `e2e/suites/viewer/crash-writer-bee-pause.test.ts`  | yes     |
| V9     | `e2e/suites/viewer/crash-writer-bee-outage.test.ts` | yes     |
| V10    | `e2e/suites/viewer/crash-engine-restart.test.ts`    | yes     |

V6 to V10 are the 2026-08-27 crash matrix promoted into pass/fail, one file per fault. The matrix ran
six arms over five faults: the gateway outage was measured twice, once with segment bytes from a node
in the tab and once through a gateway, and those are V6 under each of the two run profiles rather
than two files.

⚠️ **Two of them assert a defect, on purpose.** V7 and V9 assert that the overlay says nothing while
the picture is frozen, which is issue #100 and is what the deployment does. They are written so that
fixing #100 turns them red with a message saying exactly that. The alternative, asserting the
behaviour we want, is a case that has never passed and tells nobody anything.

### What "driver only" means

A driver is a script under `e2e/browser/` that a human runs and reads the output of. It produces a
report. It does not pass or fail, so nothing stops a regression in it. The V-numbered rows are the
plan to turn those drivers into scenarios that have a verdict.

### What "both profiles" means

The scenario runs twice, once under each run profile, so the same assertion is made about a viewer
whose bytes come from their own tab and about a viewer reading through a gateway. A viewer result
that holds in one and not the other is a finding rather than a flake.
