# e2e: fault-injection suite against a deployed stack

Drives the **real** pipeline (media engine → stream-uploader → bee → Swarm → gateway → viewer) and
injects real failures: stops containers, freezes bee, hard-kills the uploader. Unit tests live in
each package, this is the layer above them.

Two things live here, and they run at different times:

|           | what                                   | needs a deployment |
| --------- | -------------------------------------- | ------------------ |
| `test/`   | unit tests of the harness itself       | no                 |
| `suites/` | the fault scenarios and service checks | yes                |

`pnpm test` runs only the first, so the repo-wide `pnpm test` never tries to reach a host. The
suites are opt-in, and they publish a real stream and spend real postage.

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

Ports come from `.env` / `.env.<profile>` and `engines/<engine>/.env[.<profile>]`, layered under the
process environment exactly as `load_env` then `load_engine_envs` layer them. **OME's ports are not
slot-shifted**. `apply_port_slot` leaves them alone and so does this.

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
| `preflight/chequebook-funding` | the uploader node holds ≥ 0.5 BZZ, topping up from its wallet if short, failing if it cannot |

Fault scenarios:

| file                                    | proves                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `scenarios/bee-outage-short` (A)        | bee frozen under the 15s retry window → buffers, zero loss, **no** discontinuity |
| `scenarios/bee-outage-long` (B)         | bee down past the window → **arms** a discontinuity, gap, clean resume           |
| `scenarios/publish-stop-to-vod` (D)     | clean broadcaster stop → immediate VOD finalize                                  |
| `scenarios/gateway-outage-viewer` (G)   | viewer gateway down → uploads unaffected                                         |
| `scenarios/engine-restart` (E)          | media engine restart → orchestrator re-announces, a fresh `live` topic resumes   |
| `scenarios/uploader-crash-recovery` (F) | uploader SIGKILL → same stream recovers and is not VOD-ed by the 60s timer       |

Service coverage, no faults:

| file                              | proves                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- |
| `service/happy-path`              | gapless segments and an advancing manifest, no discontinuity              |
| `service/health-endpoint`         | `/health` across live → idle                                              |
| `service/catalog-via-gateway`     | player-visible: a `live` entry through the bee-gateway, flipping to `vod` |
| `service/multi-stream-concurrent` | two concurrent streams, distinct topics, each finalizing to its own VOD   |

## Prerequisites

- `ssh <target>` works non-interactively.
- `ffmpeg` on PATH, standing in for OBS.
- A deployed stack with a usable stamp (the smoke test checks TTL first).
- The uploader node's chequebook funded to ≥ 0.5 BZZ (the preflight gate tops up if it can).

## Not covered

Seeking, adaptive bitrate, viewer scale, mid-stream join, soak, and audio quality beyond "a tone is
present". If it is not a row above, this suite does not verify it.

## Why the unit tests exist

The harness decides what every scenario concludes, and it fails in one direction: a regex that stops
matching does not go red, it reports zero segments, and the scenario blames the publisher. So the
parts that can be wrong silently are pinned:

- `test/ports.test.ts` and `test/envFile.test.ts` run the **real** `_lib.sh` functions over the same
  inputs and compare. A deploy rule that changes fails a unit test here.
- `test/logLevel.test.ts` reads the uploader's own call sites, so a log line moving to a different
  level fails here rather than during a live run.
- `test/logwatch.test.ts` drives the parsers with the formats `Logger` actually writes, both of them.
