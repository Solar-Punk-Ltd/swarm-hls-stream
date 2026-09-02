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

| var                    | default                            | what it is                                                                                 |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `E2E_SSH_TARGET`       | `localhost`                        | ssh target for container control and curl. Must work non-interactively.                    |
| `E2E_PUBLIC_HOST`      | `127.0.0.1`                        | address the SRT publisher and viewer reach the deployment on.                              |
| `E2E_PROFILE`          | `default`                          | the deploy's `--profile`: the compose project, so containers are `<profile>-<service>-1`.  |
| `E2E_PORT_SLOT`        | `0`                                | the deploy's `--portSlot`. `0` means no slot, and the env files decide the ports.          |
| `E2E_ENGINE`           | the deployment's `ENGINE`          | `srs` or `ome`. Overrides what the root env says.                                          |
| `E2E_STREAM_PATH`      | per engine                         | `live/stream` for SRS, `video/stream` for OME.                                             |
| `E2E_OME_SRT_PORT`     | `OME_SRT_PORT` from the engine env | only for a standalone OME that no profile deployed.                                        |
| `E2E_OME_CONTAINER`    | `<profile>-ome-1`                  | same.                                                                                      |
| `E2E_EXPECT_ABR`       | undeclared                         | what this run covers: `true` a ladder, `false` single-rendition. See below.                |
| `E2E_EXPECT_BROWSER`   | undeclared                         | whether a real viewer watches: `true` opens a player, `false` runs without one. See below. |
| `E2E_EXPECT_SEGMENT_S` | undeclared                         | seconds per segment this run needs, or `any` to pin none. See below.                       |
| `E2E_MODE`             | `attach`                           | only `attach` exists. `deploy` refuses and points at `deploy/scripts/deploy.sh`.           |

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

### Saying whether a real browser watches

`suites/viewer/` opens a real Chrome on the deployed client. Every other viewer leg here is an HTTP
poll, so this is the only part of the suite that can say what a viewer actually got rather than what
one could have fetched. Those suites can skip, and a skipped suite is invisible for the same reason
the ABR ones are, so `preflight/viewer-coverage` refuses a run that has not said which it is.

| `E2E_EXPECT_BROWSER` | what happens                                                                  |
| -------------------- | ----------------------------------------------------------------------------- |
| unset                | **refused**, before anything is asked of the deployment                       |
| `false`              | the viewer suites skip, and the preflight prints that they did                |
| `true`               | a real browser watches, and `BROWSER_FETCH_BACKEND` must name which arm it is |

`BROWSER_FETCH_BACKEND` is `weeb3` for a Swarm node in the viewer's own tab, or `gateway` for the
control. It belongs in the environment of the run rather than in a profile, because it is what the
run is a reading of and not what the deployment is. Unset means whatever the client build defaults
to, which would file a verdict against a condition nobody chose, so a browser run is refused without
it.

### Saying how long a segment the run needs

**The two viewer types want opposite segment lengths, so there is no setting that is simply right.**
Measured 2026-08-16 by the sibling repo `swarm-stream-loadlab`, in
`docs/measurements/2026-08-16-a-stock-tab-holds-realtime-on-two-second-segments.md`, and carried
unresolved as Q23 of its `docs/spec/product-spec.md`:

| segment length                | 0.5s     | 2s     |
| ----------------------------- | -------- | ------ |
| in-tab weeb-3 node            | 0.426x   | 1.000x |
| buffer it holds ahead         | 0.5-3.5s | ~90s   |
| gateway, capture to fetchable | 1.55s    | 3.88s  |

An in-tab node admits about one segment per second whatever its peer count, so a 0.5s profile needs
two admissions a second and can never catch up. The gateway's number is publisher-side by
construction, because a segment cannot be uploaded until it is complete, so a shorter one is quicker.
`profiles/in-browser.env` declares `2` and `profiles/light-client.env` declares `1.0`, and **that
difference is deliberate**. Do not reconcile them.

⛔⛔⛔ **A third constraint arrived on 2026-09-01 and it overrides the gateway's optimum.** SRS
announces every closed segment over `on_hls`, once per rung, so a ladder asks for
`rungs / HLS_FRAGMENT` announcements a second. Measured on the deployment host, SRS sustains about
**6.7 a second** while its own encoders were producing 8.0, and the shortfall raises no error. It
shows up as announcements falling behind the media at 0.46s per second of video until the lag passes
`HLS_WINDOW`, after which **SRS deletes each segment before announcing it**: the uploader gets a
callback naming a file that is already gone, and the tallest rung is unpublished mid-broadcast while
the master feed goes on advertising it.

| profile               | segments | ladder asks | against ~6.7/s | outcome                                 |
| --------------------- | -------- | ----------- | -------------- | --------------------------------------- |
| `light-client` before | 0.5s     | **8.0/s**   | over           | 1080p dead at ~2 min, 765 segments lost |
| `light-client` now    | 1.0s     | **4.0/s**   | 40% spare      | 600s run, lag flat at 0.0s, zero lost   |
| `in-browser`          | 2.0s     | 2.0/s       | 70% spare      | never exposed to this                   |

So light-client's `1.0` is **not** where the gateway path measures best. 0.5s is, and that
measurement stands. 0.5s is simply unreachable while four rungs are being announced. If the ladder
loses rungs, or the ceiling is understood and raised, 0.5 is the value to come back to.

`preflight/segment-length` refuses a run pointed at the other one:

| `E2E_EXPECT_SEGMENT_S` | what happens                                                                     |
| ---------------------- | -------------------------------------------------------------------------------- |
| unset                  | **refused**, before anything is asked of the deployment                          |
| a number               | the running SRS config is read, and a stage cutting at another length is refused |
| `any`                  | the check stands down, and the preflight prints that it did                      |

It reads the config the running SRS container was started on, through one `docker exec cat`: **no
broadcast, no stamp, nothing published and nothing changed**. That is a prediction from the config
rather than an observation of published media, so it cannot see an encoder missing the cadence its
own config asks for. `deploy/scripts/stage-fingerprint.sh` reads raw `#EXTINF` off a live playlist
and does catch that, during a sitting where the broadcast is paid for either way.

A refused run names the one knob. With the ladder on, `engines/srs/entrypoint.sh` derives every rung
GOP from `HLS_FRAGMENT`, so the fragment IS the segment:

```bash
echo 'HLS_FRAGMENT=2.0' >> engines/srs/.env.<profile>
deploy/scripts/deploy.sh --profile=<profile> [--portSlot=<N>] srs
```

`any` is for a run that genuinely pins no length, and for OME, whose segmenter config this gate
cannot read. It is a declaration and is never asked again.

Launching a browser also needs the host-side settings the config cannot know:

| var                     | default                    | what it is                                                                                                                         |
| ----------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `E2E_BROWSER_REPO_DIR`  | **required**               | absolute path of the bench checkout **on the host**, mounted into the arm as `/repo`. Same directory `bench-on-host.sh` rsyncs to. |
| `E2E_BROWSER_IMAGE`     | `swarm-hls-browser:latest` | the image `browser-on-host.sh` builds from `e2e/Dockerfile.browser`.                                                               |
| `E2E_BROWSER_CONTAINER` | `e2e-viewer-browser`       | the arm's container name. Reclaimed by exact name before each arm.                                                                 |

`E2E_BROWSER_REPO_DIR` has no default on purpose: the suite runs from inside that bind mount and
cannot work out the host path it came from, and a guessed one that did not exist would have docker
create an empty directory, mount it, and fail minutes later looking like a broken image.

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

Read-only. Proves ssh reaches the host, the uploader is healthy, **every publisher node** holds a
usable stamp with TTL headroom, and the log level can be read. Safe any time, spends nothing.

```bash
pnpm e2e:run
```

The full suite. Publishes real streams, stops real containers, spends real postage. Serial
(`--test-concurrency=1`) because every scenario uses the same live path on the same deployment, and
each one waits for `activeStreams=0` before starting so a previous stream draining cannot collide
with it.

Order is `preflight → scenarios → service`, and the preflight half runs as its own `tsx --test`
invocation chained with `&&`. That `&&` is what makes the preflights gates rather than warnings:
`node --test` runs every file it was given even after one fails, so in a single invocation a
preflight could refuse and the scenarios would spend anyway. Split, a refusal exits non-zero before
any stamp is burned.

One consequence for anyone reading the output: a run now prints **two** TAP documents, so there are
two `# tests` / `# pass` / `# fail` blocks in one log. Sum them. Reading the totals off either block
alone reports part of a run as the whole of it.

## What it covers

Preflight:

| file                           | proves                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight/chequebook-funding` | every publisher node holds ≥ 0.5 BZZ available. Read-only: it reports a shortfall and fails, never spends                                               |
| `preflight/spend-ceiling`      | the run is inside what the owner authorised in `.spend-ledger.env`. Reads one balance per node that can spend, spends nothing                           |
| `preflight/bee-publishers`     | the uploader's live routing is the one `BEE_PUBLISHERS` declares. Reads `/health` only, spends nothing                                                  |
| `preflight/abr-coverage`       | the run is not silently skipping the ABR suites. Reads config only, dials no host                                                                       |
| `preflight/viewer-coverage`    | the run says whether a real browser watched, and which arm it is. Config only, dials no host                                                            |
| `preflight/profile`            | the run profile parses and declared something. Config only, dials no host, refuses while the stack is cold                                              |
| `preflight/segment-length`     | the deployed stage cuts at the length this run declares. One `docker exec cat` of the SRS config, spends nothing                                        |
| `preflight/announcement-rate`  | the ladder does not ask SRS for more announcements a second than it has sustained, which silently kills the top rung. One `docker exec`, spends nothing |
| `preflight/uploader-log-shape` | the deployed uploader writes all fifteen parsed log families. One `docker exec` against its built code, spends nothing                                  |

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

Viewer coverage, in a real browser. These are the only suites here that open a player, so they are
the only ones that can say what a viewer got rather than what one could have fetched. They need the
browser image on the host and the settings under **Saying whether a real browser watches**:

| file                             | proves                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `viewer/live-playback`           | (V1) a real viewer keeps up with a live broadcast, decodes a picture, errors at nothing, and is the byte-source arm it is filed as |
| `viewer/broadcast-ended`         | (V5) the broadcaster stops under a watching viewer and the viewer is told, rather than left on a frozen last frame                 |
| `viewer/crash-gateway-outage`    | (V6) the gateway is taken away for 20s: the picture plays out its buffer, says why it stopped, and comes back on its own           |
| `viewer/crash-uploader-killed`   | (V7) the uploader is killed: the viewer waits **in silence**, which is issue #100, and resumes when it answers again               |
| `viewer/crash-writer-bee-pause`  | (V8) an 8s pause of the writer's node costs a viewer no more than the pause itself, and needs telling nothing                      |
| `viewer/crash-writer-bee-outage` | (V9) a 20s writer outage arms a discontinuity and the viewer plays through it, **in silence**, which is #100 again                 |
| `viewer/crash-engine-restart`    | (V10) the engine restart ends the broadcast, and the reap's terminal message reaches the screen                                    |

⛔ None of them asserts how far behind live the player sat. That figure is printed and filed, and
turning it into a threshold is a product decision about what latency this deployment promises.

⛔ V6 to V10 are the 2026-08-27 crash matrix, `docs/bench/crash-at-an-in-tab-viewer-2026-08-27.md`,
promoted into pass/fail. **Each asserts what that sitting recorded, including where what it recorded
is a defect.** V7 and V9 assert an overlay that says nothing during a freeze, which is issue #100:
they are written so that fixing #100 turns them red, with a message saying so, rather than leaving
two cases that have never passed. Their thresholds and the reasoning behind each one are in the
suites' own constants, and the rules they judge by are covered by the free unit run in
`test/crashArm.test.ts`.

⚠️ **They cost broadcast.** One fault per broadcast, since a fault ends the one it lands in, so a
full viewer run is seven paid broadcasts rather than two. Each crash arm is sized at four minutes by
`crashArmMinutes`, which derives it from the fault rather than letting a suite guess.

## In-browser node first

**The default subject of a viewer measurement is our client reading segment bytes from a Swarm node
running in the tab, not a bee gateway.** A gateway arm is the control, not the baseline. Set it with
`BROWSER_FETCH_BACKEND`. The command matrix below says which drivers honour it:

| value     | what the viewer is                                                          |
| --------- | --------------------------------------------------------------------------- |
| unset     | whatever the client build defaults to. No arm is recorded and no proof runs |
| `gateway` | segment bytes from a bee gateway, the control                               |
| `weeb3`   | segment bytes from the in-tab node, feed and manifest still via a gateway   |

Since run profiles landed, **unset is no longer what a plain run gets**. Importing `src/config.ts`
applies the run profile, and the default profile `in-browser` sets `BROWSER_FETCH_BACKEND=weeb3`.
Reaching the unset row now takes blanking it on purpose with `BROWSER_FETCH_BACKEND=` in the
environment, which beats the profile by design. See `docs/e2e-coverage.md`.

`weeb3` is a **hybrid**, not gateway-less: PR #183 moved segment bytes and nothing else. Fully
gateway-less is weeb-3's own page, run by `pnpm browser:weeb3-native` and swept against the hybrid by
`pnpm browser:viewer-order`. See `src/browser/viewerConditions.ts`.

Which command supports which:

| command                         | in-tab node  | notes                                                                                  |
| ------------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `browser:watch`                 | yes          | the long-run watcher, the workhorse                                                    |
| `browser:crash`                 | yes          | all five fault scenarios                                                               |
| `browser:buffer-sweep`          | yes          | one byte source for the whole sweep                                                    |
| `browser:fetch-backend-check`   | yes          | the A/B itself                                                                         |
| `browser:weeb3-native`          | gateway-less | weeb-3's own page                                                                      |
| `browser:viewer-order`          | both         | native against hybrid, counterbalanced                                                 |
| `browser:vod`                   | yes          | recorded playback, seeks or a squeeze                                                  |
| `browser:selfcheck`             | **no**       | proves the instrument, not a viewer condition                                          |
| `browser:gateway-check`         | n/a          | gateway by definition                                                                  |
| `browser:in-tab-throttle-probe` | in-tab only  | no player at all, it drives the node's retrieval path directly                         |
| `e2e:run`                       | yes          | uploader-side throughout, plus `suites/viewer/`, which launches `browser:watch` itself |

`browser:arm-order` and `browser:byte-source-order` open no viewer: they print the counterbalanced
order a sitting's arms must run in, so the shell driver reads the rule instead of deriving its own.

`browser:vod` plays a finished recording through the shipped client and, by default, seeks around
inside it. Set `BROWSER_VOD_SQUEEZE_KBPS` and it stops seeking and squeezes instead: it plays from the
start, caps the tab's download part way through, lifts the cap and samples the three stretches either
side, sized by `BROWSER_VOD_SETTLE_S` (45), `BROWSER_VOD_SQUEEZE_S` (60) and `BROWSER_VOD_RECOVER_S`
(60). A recording is the control a squeezed live watch never had, because a capped live viewer is also
falling behind an edge that keeps moving and a recording has no edge. Per stretch it reports the
playback advance ratio, the stalls, which level each fragment belonged to with how every attempt
ended, and the inbound WebSocket bytes, which is the only vantage point on an in-tab node's own
traffic. Nothing is asserted. Both modes honour `BROWSER_FETCH_BACKEND` and prove the segment bytes
came from the source the run is filed under, and both bracket the stage's postage and funding either
side. ⚠️ A weeb-3 arm spends `BROWSER_BYTE_SOURCE_SETTLE_SECONDS` (60) of the recording booting its
node before any window opens, so a recording shorter than that plus the three windows ends mid-run
and the driver says so.

`browser:in-tab-throttle-probe` asks why a capped in-tab viewer gets nothing. It opens no player and
watches no broadcast: it boots the node through the client's own switch, then pulls fresh segment
references from an existing recording straight through the client's retrieval path, unthrottled and
under a cap, counting the tab's WebSocket frames either side of each one. Under the emulated cap
three idle windows come first, which is where the cap is shown to reach the transport at all, and
every capped figure is void if it does not. Nothing is asserted, the pre-registered predictions in
`docs/bench/in-tab-throttle-probe-prediction-2026-09-02.md` are restated in the report beside what
was observed, and it costs **0 BZZ**, so it needs no sitting and no gate. Run it on the host with
`deploy/scripts/browser-on-host.sh --script browser:in-tab-throttle-probe`. `PROBE_OWNER`,
`PROBE_TOPIC_360_HEX` and `PROBE_TOPIC_1080_HEX` choose the recording, and `PROBE_CAP_KBPS`,
`PROBE_LOW_CAP_KBPS`, `PROBE_IDLE_SECONDS`, `PROBE_RETRIEVALS_PER_ARM`, `PROBE_BUDGET_SECONDS`,
`PROBE_TAIL_SECONDS` and `PROBE_GAP_SECONDS` size the run, the last being the quiet time after every
row, cap already lifted, so a capped row's late hedged chunks are not counted against the row after it.

`browser:weeb3-native` is that probe's control, and it grows a squeeze mode for it. Setting
`WEEB3_NATIVE_SQUEEZE_KBPS` turns the single counted window into three, settle then capped then
recovered, sized by `WEEB3_NATIVE_SETTLE_S` (45), `WEEB3_NATIVE_SQUEEZE_S` (60) and
`WEEB3_NATIVE_RECOVER_S` (60). The report gains a per-phase table of realtime ratio, stalls added and
the tab's own inbound WebSocket bytes, beside what the cap allows in the same units, and the run json
gains the phase windows while the frame log replaces the request log beside it. **Nothing in it is
asserted.** Unset, the driver behaves exactly as it did before the mode existed. It is for a
**finished recording** only and refuses one too short to hold the three windows plus 20 s of
headroom, because a run that outlasts its recording measures the media running out and that reads
exactly like a delivery failure. `WEEB3_NATIVE_HARNESS_BRACKET=1` reads the nodes' own postage and
chequebook counters through the harness instead of over ssh, which is the only way to satisfy the
node-metrics gate from inside the browser container on the deployment host, and zero spend there is
the gateway-less claim proved from the nodes' side.

### The shaped mode: a real slow link instead of Chrome's

Every "slow connection" this repository has ever measured was Chrome's
`Network.emulateNetworkConditions` applied over CDP (`src/browser/throttle.ts`). That is one
aggregate budget the browser schedules across every transport itself, and an in-tab Swarm node holds
about two hundred WebSocket connections, so how Chromium divides such a budget across two hundred
sockets is not a fact about a 2.8 Mbps link. The owner ruled on 2026-09-02 that the emulation, not
the node, is a prime suspect for what the probe found. Read the owner's-correction banner at the top
of `docs/bench/in-tab-throttle-probe-result-2026-09-02.md` before quoting any figure from that run.

**Arm 2 repeats the probe under a real shaped link.** Run it on the deployment host with:

```bash
deploy/scripts/browser-on-host.sh --own-network --shape-kbps 2800 \
  --script browser:in-tab-throttle-probe \
  -- PROBE_CAP_MODE=external PROBE_CAP_KBPS=2800
```

`--shape-kbps` implies `--own-network`, which gives the browser container a network namespace of its
own instead of the host's. That part is not optional and it is not tidiness: with `--network host`
the container shares one namespace with all four bee nodes, the uploader, the gateway and every
co-tenant on the machine, so a shaper installed inside it would throttle all of them. The cost is
loopback, so `E2E_LOCAL_HOST_ADDRESS`, `E2E_PUBLIC_HOST` and `BROWSER_CLIENT_URL` all move to
`host.docker.internal`, and the run gains one bridge hop to the host that a host-networked run does
not have.

`deploy/scripts/shape-container-ingress.sh` then installs a `tc` ingress policer on the container's
own interface, download only, the same shape `squeezeDownload` has. **It refuses the whole run rather
than let an unshaped link be measured**, and it refuses four ways: the deployment's client answering
on the container's own loopback (which proves the namespace is still shared), the client unreachable
across the bridge unshaped, `tc` missing or denied, and a measured rate more than 25% under or 15%
over the cap. The rate is measured by downloading the largest asset the client serves, which it
discovers rather than names because the filename is a build hash. `PROBE_EXTERNAL_CAP_MEASURED_BPS`
carries the proved rate into the driver, which refuses if it disagrees with `PROBE_CAP_KBPS`.

`PROBE_CAP_MODE=external` changes what the probe does: no CDP squeeze anywhere, **one** idle window
rather than three, and Part B's "free" arms omitted, because the policer holds for the life of the
container and cannot be lifted for one window or one row. There is therefore no uncapped condition
inside the run, the uncapped comparison is the CDP run of the same day, and the report says so. H0
asks whether the emulation reached the transport, so it does not apply here and the report replaces
it with the rate the preflight proved. Every row, window and the run carry `capSource`, so no figure
from either arm can be read without knowing which cap it was taken under.

⚠️ `--cap-add=NET_ADMIN` puts the capability in the container's sets, and the container runs as the
invoking user rather than as root, which on some runc versions leaves it permitted but not
effective. The shaper names that as the cause when `tc` is denied, so the arrangement either works
or says why it did not.

Paid crash and buffer-sweep sittings run through their gated wrappers on the deployment host,
`deploy/scripts/crash-arms.sh` and `deploy/scripts/buffer-sweep-sitting.sh`: same afford, capacity
and spend-ceiling gates as every other sitting, one broadcast per fault (or one sized to the whole
sweep), and an arm that does not name its byte source is refused before anything is published.

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
- A deployed stack where every publisher node holds a usable stamp (the smoke test checks TTL on all
  of them first).
- Every publisher node's chequebook funded to ≥ 0.5 BZZ, not just the coordinator's. Fund them
  yourself. The preflight only reads, and prints the exact `curl` to deposit each shortfall.
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
