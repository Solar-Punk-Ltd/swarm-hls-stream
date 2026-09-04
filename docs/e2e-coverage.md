# What the e2e suite covers, and what it does not

**As of 2026-09-05.** A living map from product functionality to the live end-to-end scenarios that
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
and `light-client` declares `1.0`, and that is a product trade rather than a drift. The owner confirmed it on 2026-09-04: a run that switches arms on one stage states the length it accepts, or the stage is redeployed.

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
viewer type's length, and since 2026-09-04 also one whose **uploader dates segments** by a length the
engine does not cut by. `HLS_FRAGMENT` is one value in the profile env reaching two containers: the
engine cuts by it, the uploader steps `#EXT-X-PROGRAM-DATE-TIME` by it. An uploader on 1.0 in front of
an SRS cutting 2.0 passed all ten gates, and only the ABR ladder suite's timeline subtest caught it,
mid-sitting. It reads the config the running SRS container was started on, through one
`docker exec cat`, and both containers' own environment through two `docker inspect` reads, so it
costs no broadcast, no stamp and no BZZ, and changes nothing. That makes it
a prediction from the running config rather than an observation of published media: an encoder
missing the cadence its own config asks for is invisible here, and is what
`deploy/scripts/stage-fingerprint.sh` catches from raw `#EXTINF` during a sitting. A run that pins no
length says `E2E_EXPECT_SEGMENT_S=any` once, which is also the answer for OME, whose segmenter config
this cannot read.

⚠️ **A run declaring `any` reaches V4 without a length, and since 2026-09-03 that costs it nothing.**
V4 asks whether a recording is the whole broadcast by comparing the last segment of each rung's
playlist against the last segment the uploader published on that rung, by reference. An identity
needs no segment length, so an `any` run now asks every question a pinned run asks. All the
declaration still decides is the unit V4 sizes its own recording in, seconds where it was pinned and
segments where it was not.

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

Since 2026-09-01 it lists every family the harness parses, nineteen at this writing and the gate prints its own count rather than trusting this sentence: the four originals, the
finalize flips and session ends seven scenarios wait on, the six lines that arm a discontinuity
(six suites assert that count is zero, and a line nothing matches passes them vacuously green), the
catalog-lost discriminator, the catalog announce, and the finalize that resumes rather than
republishes after a crash. The finalize one reports whether scenario H's kill landed inside the window
it aims at, and a deployment that cannot write it still passes the scenario, and passes it without
anyone being able to say the window was ever exercised.

The newest, added 2026-09-04, is the line naming a postage batch bee refused, and it is the third entry that refuses a deployment built before it, so the next sitting after this checkout lands asks for one uploader redeploy. Before it came the sixth arming line, added on 2026-09-03: a gap the uploader was never told about
and worked out from the engine's own numbering. It is the only kind of loss the shipped SRS path
produces, because SRS posts each closed segment to the webhook once and never retries, so everything
it closed while the uploader was dead is simply absent. Scenario F waits on that family by itself,
which is why `logwatch` counts it separately as well as inside the armed total. The fifth was added
the same day with the re-anchored dating: the segment where the engine's own counter restarted now
carries a break, and that path goes nowhere near `pendingDiscontinuity`. Both leave the uploaded
segment run gapless, so nothing else in the suite can see either of them. Three entries now refuse
any uploader built
before the messages moved into the shared contract even though no wording changed, one string used
to be assembled across a `+` join and one lived in a file the gate does not read, so the first run
after this checkout lands asks for exactly one redeploy.

`logLevel.ts` and `suites/smoke/attach.test.ts` guard the sibling precondition, whether the
deployment's `LOG_LEVEL` admits these lines at all. Level and shape are separate questions and both
have now been answered the expensive way once.

`e2e/suites/preflight/client-shape.test.ts` refuses a stage whose **served client** was not built
from the client sources this harness was checked out with. It is the viewer-side twin of the gate
above, and the gap was open the whole time: `bench-on-host.sh` syncs this repo on every run and never
rebuilds the client image, so the harness can be current while a viewer is served a client that is
weeks old. Everything under `e2e/src/browser/` parses that client, its console lines, the fetch
backend it publishes on `globalThis` and the weeb-3 worker it serves. The harness-side version of the
same staleness was caught three days old under a sitting about to be paid for, and the client-side
version was caught fifteen days old under a browser sitting that had already run. That browser
sitting is the point: the drivers were the one path that ran no gate at all, since the `&&` chain
lives in the suite's own scripts and a driver is launched beside them. Since 2026-09-04
`bench-on-host.sh` runs the whole preflight in the container before every script whose name begins
with `browser:`, this gate included, so a stale client now refuses the arm instead of being measured
by it.

Both held on the stage on 2026-09-04, at 0 BZZ. The client was redeployed through `deploy.sh` at head
`3796e4a`, the served stamp named both trees, and the ten gates passed on the host. At `95458d1` the
gate then ran ahead of a browser driver twice, `browser:selfcheck` through `browser-on-host.sh`, ten
of ten each time with the driver starting only afterwards, and once inside an own-network container,
where the stamp read dialled `host.docker.internal` and passed. The first gated selfcheck itself came
back VOID on a timer drift of 4.15x, and the repeat a minute later read 1.00x and SOUND with the host
at a load of 4.6 on 48 cores: a cold Chrome after the image rebuild, not the gate and not the host.

The client image now records what it was built from and serves it at `/build-stamp.json`:
`git rev-parse HEAD:packages/client`, the same for `packages/shared`, the head commit, whether the
build came from uncommitted sources, and the two Vite knobs that decide what the bundle does.
`deploy.sh` mints those through the compose override file, and `bench-on-host.sh` carries the same
two tree hashes into the container as `E2E_EXPECT_CLIENT_TREE` and `E2E_EXPECT_SHARED_TREE`, because
its rsync excludes `.git` and a harness on the host has no history to ask. A run from a checkout
falls back to reading git itself.

⚠️ **It compares what the client was built from, not what survived the build.** A bundle is minified
and tree-shaken, so grepping it for a symbol the way the uploader gate greps `dist` would answer
about the wrong thing. Tree hashes are content hashes, so a rebuild from an unchanged tree still
matches and only a real source change refuses. The read goes through nginx over one `curl`, because
what a viewer is served is the thing under test, and it costs no broadcast and no BZZ.

Four refusals, each naming its fix: no readable stamp means the client predates it and asks for a
redeploy, a mismatched tree prints both hashes with the head and the build time, a dirty flag on
either side means the hashes describe something other than what is running, and an expectation it
cannot establish is refused rather than passed. ⛔ That last one matters most. A gate that passed
when it could not judge a stage would report green on every run launched outside both paths, which
is the vacuous green this repo has already paid for elsewhere.

`e2e/src/harness/stageStamps.ts` gates every suite's `before()` on postage: every Bee node the
uploader publishes through must hold **the postage batch `BEE_PUBLISHERS` routes its rungs to**, in a
state bee will stamp with, with more TTL than the run needs, or the suite refuses before its
publisher starts. The check it replaced read the coordinator alone and spoke for the stage, so an
expired batch on the 1080p node passed it and surfaced mid-broadcast as a rung that stopped being
produced, which reaches a viewer as an ABR fault and gets scored as one.

Reading every node closed half of that. The other half closed on 2026-09-04, decision 4 of
`docs/e2e-batch-drain-plan.md`: the batch each reading was about was the node's **best** stamp, the
longest-lived usable one it happened to hold, so a node holding one drained batch, the configured
one, beside one fresh unused batch passed cleanly and then refused every upload the rung made. Which
batch a node spends is decided in `BEE_PUBLISHERS` and reported on the uploader's `/health`, which
truncates it to eight hex characters, and the gate finds that row on `/stamps` by that prefix. Three
causes are named apart in the refusal, because they have three different fixes: the node does not
hold the configured batch, it holds it and bee will not stamp with it, or it holds it and the TTL
will not outlast the run. A pair of rows sharing the prefix is refused rather than picked between.

The gateway node is deliberately not read, it holds no upload batch, and batch utilization is
reported for the configured batch and never judged, because that stop line stays with
`deploy/scripts/stamp-guard.sh` and the uploader's own `PostageGate`. ⚠️ On a small batch that
percentage reads alarmingly early: a depth 17 batch has two chunks per bucket, so its first chunk
prints as 50% full, which is the arithmetic being honest rather than a batch half spent.

## The map

| Functionality                                                                                            | Today                                                                                                                                                                                                                                                                                                                                                             | Plan                                                          |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Publish, gapless segments, manifest advances                                                             | `happy-path`, green 2026-09-04 in both byte sources at `bc9df49`, and in the 2026-09-01 sittings two, three and four                                                                                                                                                                                                                                              | in every full sitting                                         |
| Ladder: 4 rungs publish, one group, gapless                                                              | `abr-ladder`, green 2026-09-04 in both byte sources at `bc9df49` (first attempted 2026-08-27, instrument defects since fixed)                                                                                                                                                                                                                                     | in every full sitting                                         |
| Ladder survives engine restart as one ladder                                                             | `abr-engine-restart`, green 2026-09-04 in both byte sources at `bc9df49`                                                                                                                                                                                                                                                                                          | in every full sitting                                         |
| One rung dies, others carry on                                                                           | both legs green 2026-09-04 in both byte sources at `bc9df49`, inside the full suite: the viewer steps down (V3) and the master stops advertising the rung                                                                                                                                                                                                         | in every full sitting                                         |
| Uploader crash recovery                                                                                  | F, green 2026-09-04 in both byte sources at `bc9df49`, and 2026-08-03                                                                                                                                                                                                                                                                                             | in every full sitting                                         |
| Finalize/recovery family (mid-finalize kill, whole-stack restart, corrupt entry, reconnect during drain) | H I J K, green 2026-09-04 in both byte sources at `bc9df49`, H's resume path included                                                                                                                                                                                                                                                                             | in every full sitting                                         |
| Writer bee outage short and long                                                                         | A B, green 2026-09-04 in both byte sources at `bc9df49`, and 2026-08-03                                                                                                                                                                                                                                                                                           | in every full sitting                                         |
| Gateway outage, upload side                                                                              | G, green 2026-09-04 in both byte sources at `bc9df49`, and 2026-08-03                                                                                                                                                                                                                                                                                             | in every full sitting                                         |
| Catalog live to VOD, /health lifecycle                                                                   | green 2026-09-04 in both byte sources at `bc9df49`, and 2026-08-03                                                                                                                                                                                                                                                                                                | in every full sitting                                         |
| Two simultaneous broadcasts                                                                              | `multi-stream-concurrent`, green 2026-09-04 in both byte sources at `bc9df49`, on the ladder stage                                                                                                                                                                                                                                                                | in every full sitting                                         |
| Viewer: live playback in a real browser                                                                  | V1, green 2026-09-04 in both byte sources at `bc9df49`                                                                                                                                                                                                                                                                                                            | in every full sitting                                         |
| Viewer: quality switch works                                                                             | V2, green 2026-09-04 in both byte sources at `bc9df49` (first in-tab green 2026-09-02)                                                                                                                                                                                                                                                                            | in every full sitting, at the length the stage cuts           |
| Viewer: rung goes quiet, viewer steps down instead of freezing                                           | V3, green 2026-09-04 in both byte sources at `bc9df49`, with the failover on                                                                                                                                                                                                                                                                                      | in every full sitting                                         |
| Viewer: VOD playback                                                                                     | V4, green 2026-09-04 in both byte sources at `bc9df49`, judging completeness on each rung's last segment                                                                                                                                                                                                                                                          | in every full sitting, at the length the stage cuts           |
| Viewer: broadcast ends cleanly on screen                                                                 | V5, green 2026-09-04 in both byte sources at `bc9df49`                                                                                                                                                                                                                                                                                                            | in every full sitting                                         |
| Viewer crash matrix (5 faults at a viewer)                                                               | V6 to V10, green 2026-09-04 in both byte sources at `bc9df49`                                                                                                                                                                                                                                                                                                     | in every full sitting                                         |
| weeb3 actually served the bytes (arm proof)                                                              | every one of the eleven in-browser viewer tests refuses an arm that is not the condition it is filed as, eight through `weeb3ArmRefusal` directly and V4, V5 and V11 through `byteSourceArmRefusal`, which applies the whole-run ceiling of nine gateway reads to an in-tab arm and no ceiling to a gateway one. V4 and V5 proven live 2026-09-04, six reads each | in every in-browser sitting                                   |
| Playlist timeline: sequence 0 and a date-time on every segment                                           | asserted live by seven suites since 2026-09-03, green 2026-09-04 in both byte sources at `bc9df49`                                                                                                                                                                                                                                                                | in every full sitting                                         |
| One rung's postage batch runs dry, the broadcast survives                                                | `batch-drain` and `batch-drain-viewer` built 2026-09-04. The first arming ran the same day and returned two findings rather than a verdict, both since fixed: a batch degrades over a minute or two rather than dying at once, and the stage's fragment length lived in a shell export. Neither suite has passed live yet                                         | first proving sitting behind `drain-stage.sh` arm and restore |

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
| L      | `e2e/suites/scenarios/batch-drain.test.ts`             |

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
| V11    | `e2e/suites/viewer/batch-drain-viewer.test.ts`      | yes   |

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

## The playlist timeline: asserted on the playlists a broadcast published

**Added 2026-09-03, wired live the same day.** Every playlist the uploader writes opens at
`#EXT-X-MEDIA-SEQUENCE:0` and carries an `#EXT-X-PROGRAM-DATE-TIME` on every segment, stepping by the
deployment's nominal fragment length. The contract is described in
[the uploader's README](../packages/stream-uploader/README.md#the-manifest-contract-timestamps-and-sequence-zero).

`manifestContractFailures` in `e2e/src/harness/manifestContract.ts` is the rulebook, and
`e2e/test/manifestContract.test.ts` proves it against playlist text: sequence 0 on the first playlist
of a broadcast, a readable wall clock on every segment, strictly rising stamps, and a step of exactly
one fragment between segments that carry no `#EXT-X-DISCONTINUITY` between them. That is free and it
runs in CI.

Across a discontinuity a forward step of any size is legal, decided by the owner on 2026-09-03. An
engine restart inside a broadcast re-anchors the dating on the wall clock the engine came back at, so
the step across that break is the length of the outage and nothing rounds it to fragments. A step
that does not move forwards stays a failure wherever it appears, discontinuity or not, because a date
that repeats or goes backwards is media a viewer is already holding being re-dated.

⛔ **The uploader's log cannot falsify any of it, by design.** The log names the engine's own segment
index and the feed's SOC index, because those are what correlate with the engine's logs and with a
segment reference. The playlist publishes a different number, a media sequence counting from 0 at
this broadcast's first segment, and a date derived from one anchor the whole ladder shares. So a
suite has to read the playlist.

`e2e/src/harness/manifestContractLive.ts` is what reads it, and
`e2e/test/manifestContractLive.test.ts` covers everything in it but the feed read. Seven live suites
call it:

| Suite                                       | What only this one can see                                                                      | Sequence 0 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------- |
| `service/happy-path`                        | the baseline, on a broadcast with no fault in it                                                | asserted   |
| `service/abr-ladder`                        | all four rungs deriving both numbers from one anchor, which is what a level switch lands on     | asserted   |
| H `finalize-crash`, I `whole-stack-restart` | the recording's own numbering, which no catalog entry speaks for                                | asserted   |
| E `engine-restart`, `abr-engine-restart`    | the resumed session dating its media off its own anchor rather than the dead session's          | when shown |
| F `uploader-crash-recovery`                 | the recovered session still writing the playlist a viewer holds, on sequences restored off disk | no         |

Each one prints one line per rung: whether the feed answered a live playlist or a recording, how many
segments it names, the sequence it declares and the span of dates it holds. A refusal names the rung,
the segment and the date it objected to. Everything but the sequence is asserted in all seven: a wall
clock on every segment, strictly rising, stepping by a whole number of fragments, nothing wider
without an `#EXT-X-DISCONTINUITY`, and no date before this project existed.

⚠️ **Where the sequence column says less than "asserted", read the next section for why.** It is never
a promise nobody checked: the sequence is asserted exactly where the playlist can be shown to be the
broadcast's first, and left alone otherwise.

### The two things that were thought to be in the way, and were not

1. **The owner.** This section used to say a ladder announce carries no owner and that either the
   uploader had to log one or the harness had to hold `STREAM_KEY`. Neither is so. **One
   `STREAM_KEY` signs the catalog, every master and every rung's manifest feed**
   (`packages/stream-uploader/src/index.ts` builds all three signers from it), so the address
   `discoverCatalogFeed` already reads out of the `[StreamCatalog]` line is the owner of every rung
   playlist too. **Nothing in the uploader changed, and no redeploy is needed for this.**
2. **A first-playlist reading.** `#EXT-X-MEDIA-SEQUENCE:0` is owed only while the live window still
   starts at the broadcast's first segment, and that window is a byte budget, about 31 segments at
   this stage's line lengths. Reading "early" would make the assertion green on the wall clock rather
   than on the product, so **no suite promises it on the clock.** It is settled two ways that need no
   stopwatch: a playlist declaring itself a recording names every segment of its broadcast, and a
   live playlist naming at least as many segments as its rung has ever published has dropped none.
   The published count is read **after** the playlist, because the other order can call a slid window
   a first playlist and red a correct product.

### What the sequence column is saying

**`asserted`** means the derivation always fires. `happy-path` and `abr-ladder` open their log window
after `waitForIdle`, so every segment line in it is their own broadcast's and the count is exact.
H and I read after the finalize, where the feed head is the recording, and a recording names every
segment of its broadcast whatever the crash did to the engine's counter.

**`when shown`** is E and the ABR engine restart, and the reason is worth writing down. The retired
session drains its queued segments **after** the restart instant and logs them under the same stream
id the recovered session then uses, because a stream id names a rung and not a session. So the count
in the restart's own window can be the recovered playlist's segments plus a few of the dead session's,
and the derivation then declines to claim the playlist is the first. A drain that was empty leaves the
count exact and the sequence is asserted. **Nothing about that can red a correct product**, it only
varies what is covered, and it is recorded here rather than dressed up: separating the two sessions
needs the session-end lines, and that was not built.

**`no`** is F. Its final read comes after the recovery timeout and the gateway catalog's own lag, by
which point the live window holds only post-recovery media and the playlist genuinely no longer starts
at the broadcast's first segment. F is there for the dates and the gaps, which is where a recovered
session's restored numbering shows.

Since 2026-09-03 F reads the timeline **twice**, and the first read is the one the scenario is about.
As soon as segments resume it waits for the uploader to report the gap the engine never posted, then
polls a read until an `#EXT-X-DISCONTINUITY` is inside a published window and judges that read. The
old single read at the end could not see the join at all: the window is about 31 segments and the read
came after a 60 second timeout plus the catalog's lag, so the join had always slid out, and F was
green on 2026-09-03 while saying nothing about it. The break has to be there because the date step
across the join is the length of the outage, and a step wider than one fragment is legal only across
a break.

The fragment length is the run's own declaration, `E2E_EXPECT_SEGMENT_S`, which
`suites/preflight/segment-length.test.ts` has already held the deployed stage to. A run declaring
`any` pins none, and then the timeline is not checked and the suite prints one line saying so.

The wired assertions ran green in the 36 of 36 gateway sitting of 2026-09-03, and F's early read found
the break across the uploader's own downtime on both runs of that night: one `#EXT-X-DISCONTINUITY` per
rung at `MEDIA-SEQUENCE:0`, across a two to three segment gap, with the contract holding, and the same
window a minute later with the join gone. See `docs/bench/sequence-zero-and-timestamps-2026-09-03.md`.
Two things still to read off a sitting's printed summaries: whether the ladder's four rungs really
agree segment for segment, and which of E and the ABR restart actually reached the sequence assertion.
