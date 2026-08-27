# e2e: fault-injection suite against a deployed stack

Drives the **real** pipeline (media engine → stream-uploader → bee → Swarm → gateway → viewer) and
injects real failures: stops containers, freezes bee, hard-kills the uploader. Unit tests live in
each package, this is the layer above them.

Three things live here, and they run at different times:

|           | what                                      | needs a deployment |
| --------- | ----------------------------------------- | ------------------ |
| `test/`   | unit tests of the harness itself          | no                 |
| `suites/` | the fault scenarios and service checks    | yes                |
| `bench/`  | the latency instrument (LAT-1), see below | yes                |

`pnpm test` runs only the first, so the repo-wide `pnpm test` never tries to reach a host. The
suites and the bench are opt-in, and they publish a real stream and spend real postage.

## Pointing it at a deployment

The suite resolves a deployment the same way `deploy/scripts/deploy.sh` does, from the same files.
Give it the `--profile` and `--portSlot` the deploy was given and it finds the same containers on
the same ports. Nothing is restated.

```bash
E2E_SSH_TARGET=streamhost E2E_PUBLIC_HOST=203.0.113.10 pnpm e2e:smoke        # a default deploy
E2E_PROFILE=streamer1 E2E_PORT_SLOT=2 … pnpm e2e:smoke                        # a profile deploy
```

| var                 | default                            | what it is                                                                                |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `E2E_SSH_TARGET`    | `localhost`                        | ssh target for container control and curl. Must work non-interactively.                   |
| `E2E_PUBLIC_HOST`   | `127.0.0.1`                        | address the SRT publisher and viewer reach the deployment on.                             |
| `E2E_PROFILE`       | `default`                          | the deploy's `--profile`: the compose project, so containers are `<profile>-<service>-1`. |
| `E2E_PORT_SLOT`     | `0`                                | the deploy's `--portSlot`. `0` means no slot, and the env files decide the ports.         |
| `E2E_ENGINE`        | the deployment's `ENGINE`          | `srs` or `ome`. Overrides what the root env says.                                         |
| `E2E_STREAM_PATH`   | per engine                         | `live/stream` for SRS, `video/stream` for OME.                                            |
| `E2E_OME_SRT_PORT`  | `OME_SRT_PORT` from the engine env | only for a standalone OME that no profile deployed.                                       |
| `E2E_OME_CONTAINER` | `<profile>-ome-1`                  | same.                                                                                     |
| `E2E_EXPECT_ABR`    | undeclared                         | what this run covers: `true` a ladder, `false` single-rendition. See below.               |
| `E2E_MODE`          | `attach`                           | only `attach` exists. `deploy` refuses and points at `deploy/scripts/deploy.sh`.          |

Ports come from `.env` / `.env.<profile>` and `engines/<engine>/.env[.<profile>]`, layered under the
process environment exactly as `load_env` then `load_engine_envs` layer them. **OME's ports are not
slot-shifted**. `apply_port_slot` leaves them alone and so does this.

### Saying whether the run covers ABR

The two ABR suites only apply to a deployment running a ladder, so they are gated on `ABR_ENABLED`,
which is off by default. A skipped suite is invisible: `node --test` reports it as `# tests 0`,
`# fail 0`, `# skipped 0` and exits 0, so the summary of a run that never transcoded a rung is
identical to one that exercised all four.

`preflight/abr-coverage` closes that. It refuses a run whose coverage is ambiguous, before anything
is asked of the deployment:

| `E2E_EXPECT_ABR` | `ABR_ENABLED` off                 | `ABR_ENABLED` on                           |
| ---------------- | --------------------------------- | ------------------------------------------ |
| unset            | **refused**, the silent gap       | runs, the ladder is covered either way     |
| `true`           | **refused**, ABR was asked for    | runs                                       |
| `false`          | runs, single-rendition on purpose | **refused**, a ladder under a single label |

A single-rendition deployment sets `E2E_EXPECT_ABR=false` once in its profile env, next to
`E2E_SSH_TARGET`, and is never asked again. `ABR_ENABLED` on with fewer than two rungs is refused
whatever was declared, because a one-rung ladder cannot show a rung going missing.

## The deployment has to log at `debug`

Every upload-side assertion is parsed out of the uploader's log, so the deployment's `LOG_LEVEL`
decides whether the suite can measure anything at all. At `log` the catalog feed location is gone
and two tests cannot start. At `info`, which `.env.sample` recommends to drop the per-segment line,
the segment counter never moves, and every scenario waits out its full timeout before failing with a
label that blames the publisher.

The smoke test reads the container's actual level and says so. `LOG_FORMAT` does not matter: both
formats are parsed.

## Running

```bash
pnpm e2e:smoke
```

Read-only. Proves ssh reaches the host, the uploader is healthy, a usable stamp exists with TTL
headroom, and the log level can be read. Safe any time, spends nothing.

```bash
pnpm e2e:run
```

The full suite. Publishes real streams, stops real containers, spends real postage. Serial
(`--test-concurrency=1`) because every scenario uses the same live path on the same deployment, and
each one waits for `activeStreams=0` before starting so a previous stream draining cannot collide
with it.

Order is `preflight → scenarios → service`, so the chequebook gate fails before any stamp is burned.

## What it covers

Preflight:

| file                           | proves                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `preflight/chequebook-funding` | the uploader node holds ≥ 0.5 BZZ. Read-only: it reports a shortfall and fails, never spends |
| `preflight/abr-coverage`       | the run is not silently skipping the ABR suites. Reads config only, dials no host            |

Fault scenarios:

| file                                    | proves                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `scenarios/bee-outage-short` (A)        | bee frozen under the 15s retry window → buffers, zero loss, **no** discontinuity   |
| `scenarios/bee-outage-long` (B)         | bee down past the window → **arms** a discontinuity, gap, clean resume             |
| `scenarios/publish-stop-to-vod` (D)     | clean broadcaster stop → immediate VOD finalize                                    |
| `scenarios/gateway-outage-viewer` (G)   | viewer gateway down → uploads unaffected                                           |
| `scenarios/engine-restart` (E)          | media engine restart → orchestrator re-announces, a fresh `live` topic resumes     |
| `scenarios/uploader-crash-recovery` (F) | uploader SIGKILL → same stream recovers and is not VOD-ed by the 60s timer         |
| `scenarios/finalize-crash` (H)          | killed inside `finalize` → after restart exactly one VOD, and the catalog names it |
| `scenarios/whole-stack-restart` (I)     | host reboot: finalize races a cold bee → one VOD, no recovery entry left behind    |
| `scenarios/recovery-entry-corrupt` (J)  | a bad recovery entry quarantines loudly, never silently deleted, health degrades   |
| `scenarios/reconnect-during-drain` (K)  | reconnect mid-drain → two VODs on two topics, the live session keeps its entry     |
| `scenarios/abr-engine-restart`          | engine restart under a ladder → every rung returns, as **one** ladder not four     |

Service coverage, no faults:

| file                              | proves                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- |
| `service/happy-path`              | gapless segments and an advancing manifest, no discontinuity              |
| `service/health-endpoint`         | `/health` across live → idle                                              |
| `service/catalog-via-gateway`     | player-visible: a `live` entry through the bee-gateway, flipping to `vod` |
| `service/multi-stream-concurrent` | two concurrent streams, distinct topics, each finalizing to its own VOD   |
| `service/abr-ladder`              | every configured rung publishes, under one ladder, gapless                |

## In-browser node first

**The default subject of a viewer measurement is our client reading segment bytes from a Swarm node
running in the tab, not a bee gateway.** A gateway arm is the control, not the baseline. Set it with
`BROWSER_FETCH_BACKEND`. The command matrix below says which drivers honour it:

| value     | what the viewer is                                                          |
| --------- | --------------------------------------------------------------------------- |
| unset     | whatever the client build defaults to. No arm is recorded and no proof runs |
| `gateway` | segment bytes from a bee gateway, the control                               |
| `weeb3`   | segment bytes from the in-tab node, feed and manifest still via a gateway   |

`weeb3` is a **hybrid**, not gateway-less: PR #183 moved segment bytes and nothing else. Fully
gateway-less is weeb-3's own page, run by `pnpm browser:weeb3-native` and swept against the hybrid by
`pnpm browser:viewer-order`. See `src/browser/viewerConditions.ts`.

Which command supports which:

| command                       | in-tab node  | notes                                              |
| ----------------------------- | ------------ | -------------------------------------------------- |
| `browser:watch`               | yes          | the long-run watcher, the workhorse                |
| `browser:crash`               | yes          | all five fault scenarios                           |
| `browser:buffer-sweep`        | yes          | one byte source for the whole sweep                |
| `browser:fetch-backend-check` | yes          | the A/B itself                                     |
| `browser:weeb3-native`        | gateway-less | weeb-3's own page                                  |
| `browser:viewer-order`        | both         | native against hybrid, counterbalanced             |
| `browser:vod`                 | **no**       | recorded playback, still gateway only              |
| `browser:selfcheck`           | **no**       | proves the instrument, not a viewer condition      |
| `browser:gateway-check`       | n/a          | gateway by definition                              |
| `e2e:run`                     | n/a          | uploader-side, asserts on uploader logs, no viewer |

`browser:arm-order` and `browser:byte-source-order` open no viewer: they print the counterbalanced
order a sitting's arms must run in, so the shell driver reads the rule instead of deriving its own.

The in-tab node needs time to boot: 4.5 MB of wasm and several seconds of dialling. Every driver
holds it for `BROWSER_BYTE_SOURCE_SETTLE_SECONDS` (default 60) before opening its window, so the join
is never inside a counted stretch. `watch.ts` reads that window from `BROWSER_SETTLE_SECONDS`
instead, because that is the knob the existing corpus was run with.

⛔⛔⛔ **An arm is proved, never believed.** A weeb-3 arm's headline is a _zero_ gateway read, and a
client that never loaded the node produces the same zero. `openByteSourceArmSession` hands back the
proof along with the arm so a driver cannot hold one without the other, and the proof requires the
wasm in the request log as a witness. This is why `crash.ts` and `buffer-sweep.ts` could not simply
have the variable added to them: before 2026-08-27 they read it nowhere, ran on the gateway, and
looked exactly like runs configured for the gateway.

## The latency bench (LAT-1)

```bash
pnpm bench:latency
```

Publishes a real stream, follows it through the feed a viewer reads, and reports how far behind live
that viewer is — split across segment duration, upload, feed write, propagation and fetch, plus the
player's own configured buffer. Writes a markdown report and its JSON to `docs/bench/`.

Nothing else in this repository can measure that, which is why `liveSyncDuration` is still 10: every
other LAT row asks for an improvement, and Sprint 5 grades them against a baseline that has to exist
first.

**How the picture is timed.** ffmpeg publishes with `-use_wallclock_as_timestamps 1 -copyts`, so each
frame carries the bench machine's clock, and the segment fetched at the far end is handed to ffprobe
for the timestamps of every video packet in it. No OCR, no burnt-in clock, nothing to read off a
picture. MPEG-TS stores those timestamps in 33 bits at 90kHz and wraps every ~26.5 hours, which
`src/bench/wallclock.ts` folds back.

**How much media a segment holds is measured, not read.** The earliest of those timestamps anchors
the capture instant. The span between the widest and the narrowest, plus one median inter-packet gap
for the final frame that no timestamp measures, is what the segment actually holds. That figure used
to come from the manifest's `#EXTINF`, which is the engine's claim about a segment rather than the
segment, and it reaches three places: the `segment` hop, the start of `upload`, and the viewer figure.
See LAT-9. The report prints the declared duration beside the measured one, so a run still says
whether the engine reports itself correctly, it just no longer depends on the answer.

**Both ends are timed by this machine.** The publisher runs here and the gateway is fetched from here,
over HTTP rather than through ssh, so no clock skew enters the total. That is also the path a real
viewer takes. It does mean the gateway has to be reachable from wherever you run this: set
`BENCH_GATEWAY_URL`, or forward the port with `ssh -L`. The run refuses to start otherwise rather than
publishing first and failing after.

**It checks itself before it spends anything.** The first thing a run does is publish to a local file,
probe it, and recover the capture instants — the whole chain, offline, in about fifteen seconds. If
the recipe has stopped carrying the clock, or ffprobe has changed what it prints, that fails there,
for free, instead of producing a number that becomes a baseline. It also checks the spans against
something the spans never touched: consecutive segments are contiguous, so each one's measured media
has to reach exactly as far as the next one's first frame. Checking them against the segment duration
the check was configured with would compare the instrument to its own input.

**What it refuses to guess.** A media engine may rebase timestamps when it repackages. If it does, the
arithmetic still yields a plausible-looking number, so the reading is bounded by the two things that
are true by construction: a frame cannot be captured before the publisher started, and cannot be
fetched before it was captured. Outside those, the run says the timestamps did not survive rather than
reporting the number. The per-hop split from the uploader's log still works in that case.

| var                  | default                             | what it is                                         |
| -------------------- | ----------------------------------- | -------------------------------------------------- |
| `BENCH_GATEWAY_URL`  | `http://<publicHost>:<gatewayPort>` | viewer gateway, as reachable from **this** machine |
| `BENCH_SAMPLES`      | `5`                                 | segments carried end to end                        |
| `BENCH_FPS`          | `30`                                |                                                    |
| `BENCH_GOP_SECONDS`  | `2`                                 | keyframe interval, which bounds segment duration   |
| `BENCH_BITRATE_KBPS` | `2500`                              |                                                    |
| `BENCH_SIZE`         | `1280x720`                          |                                                    |

The deployment has to log at `debug`, for the same reason the suites do, and the run reads the level
and refuses before publishing rather than timing out.

**Not yet a matrix.** The knobs above are read one run at a time. Sweeping them is a loop over this,
and it is deliberately not written until one run has been validated against a real deployment: each
cell costs a real broadcast and real postage, and a matrix built on an unvalidated measurement spends
that money on numbers nobody should trust.

## Prerequisites

- `ssh <target>` works non-interactively.
- `ffmpeg` on PATH, standing in for OBS.
- A deployed stack with a usable stamp (the smoke test checks TTL first).
- The uploader node's chequebook funded to ≥ 0.5 BZZ. Fund it yourself. The preflight only reads,
  and prints the exact `curl` to deposit the shortfall if it is short.
- `PUBLISH_KEY_SECRET` resolves from the same env files, so a deployment that authenticates
  publishers (SEC-28) needs nothing extra: the harness derives the same per-stream key. Left empty,
  the harness publishes bare, which such a deployment refuses.

## Not covered

Seeking, viewer scale, mid-stream join, soak, and audio quality beyond "a tone is present". If it is
not a row above, this suite does not verify it.

## Why the unit tests exist

The harness decides what every scenario concludes, and it fails in one direction: a regex that stops
matching does not go red, it reports zero segments, and the scenario blames the publisher. So the
parts that can be wrong silently are pinned:

- `test/ports.test.ts` and `test/envFile.test.ts` run the **real** `_lib.sh` functions over the same
  inputs and compare. A deploy rule that changes fails a unit test here.
- `test/logLevel.test.ts` reads the uploader's own call sites, so a log line moving to a different
  level fails here rather than during a live run.
- `test/logwatch.test.ts` drives the parsers with the formats `Logger` actually writes, both of them.
