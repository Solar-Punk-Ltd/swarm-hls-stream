# Deploy

Config-driven deployment for the Swarm HLS Stream stack.

## Prerequisites

- Docker and Docker Compose
- Node.js 22+ and pnpm
- [jq](https://jqlang.github.io/jq/download/)
- SSH access for remote targets

## First-time Setup

```bash
./deploy/scripts/setup.sh
```

Creates `config.json`, `.env`, and builds packages. Then edit both files:

- **config.json** — set where each service runs
- **.env** — set `STREAM_KEY`, `BEE_UPLOADER_NAT_ADDR`, ports, etc.

## Configuration

### config.json

Each service maps to a target:

| Value         | Meaning                                                         |
| ------------- | --------------------------------------------------------------- |
| `"localhost"` | Run in Docker on this machine                                   |
| `"user@host"` | Deploy via SSH + rsync to a remote server                       |
| `"native"`    | Service runs as a host process outside Docker — deploy skips it |
| `false`       | Disabled, not deployed                                          |

```json
{
  "services": {
    "srs": "localhost",
    "stream-uploader": "localhost",
    "bee-uploader": "root@your-server-ip",
    "bee-gateway": false
  }
}
```

Targets support SSH aliases (e.g. `"my-server"` if defined in `~/.ssh/config`).

**Constraint:** `srs` and `stream-uploader` must be on the same target (shared media volume).

### Local development / debugging stream-uploader natively

Set `stream-uploader` to `"native"` to run it as a host process (e.g. `pnpm dev`) while SRS still runs in Docker:

```json
{
  "services": {
    "srs": "localhost",
    "stream-uploader": "native",
    "bee-uploader": "localhost",
    "bee-gateway": "localhost"
  }
}
```

The deploy script will skip stream-uploader and configure SRS to reach it via `host.docker.internal`. `"native"` is only valid when `srs` is `"localhost"`.

### .env

Single `.env` in monorepo root for core options, shared by dev and deploy — see [.env.sample](../.env.sample). **Engine-specific options live in `engines/<name>/.env`** (samples: [engines/srs/.env.sample](../engines/srs/.env.sample), [engines/ome/.env.sample](../engines/ome/.env.sample)), loaded at runtime for the engine selected via `ENGINE`. `setup.sh` creates them from the samples for engines enabled in `config.json`. `deploy.sh` loads the enabled engines' env files too (below the root env — root values win on duplicate keys, matching the native uploader's dotenv order) and feeds them into compose interpolation.

### What the broadcaster's encoder must send

Nothing in this stack transcodes. SRS cuts the stream it is given into segments, so **the encoder's
keyframe interval decides the segment length**, and the segment is the largest single hop between a
camera and a viewer.

| Setting                     | Use      | Why                                                                                |
| --------------------------- | -------- | ---------------------------------------------------------------------------------- |
| **Keyframe interval (GOP)** | **0.5s** | Measured on both sides. Larger costs latency and stalls, smaller breaks retrieval. |
| Video bitrate               | 2500k    | 720p30. 1080p at 6000k also ships, and costs ~2.3x the BZZ.                        |
| B-frames                    | off      | `-tune zerolatency` or equivalent.                                                 |

In OBS this is _Settings → Output → Advanced → Keyframe Interval_, which takes **seconds** and
defaults to 0 (meaning "let the encoder decide", usually 2s). In ffmpeg it is `-g <frames>`, so at 30
fps a 0.5s GOP is `-g 15`.

**Why 0.5 and not something else**, from two funded sittings on 2026-08-12:

|      GOP | capture to fetchable | confirmed feed stalls |
| -------: | -------------------: | --------------------: |
|     2.0s |                3.88s |                3 of 3 |
|     1.0s |                2.30s |                1 of 3 |
| **0.5s** |            **1.55s** |            **0 of 3** |
|    0.25s |       not comparable |                0 of 3 |

Going from 2.0s to 0.5s costs **19% more BZZ**, because the extra bytes are keyframes.

⛔⛔⛔ **This whole table is for a SINGLE-RENDITION stage. With the ABR ladder on, none of it decides
the segment length and 0.5s is unreachable.** The transcoders re-GOP every rung from `HLS_FRAGMENT`
(`ABR_GOP = ABR_FPS x HLS_FRAGMENT`), so the broadcaster's own keyframe interval stops mattering, and
a second limit appears that a single rendition never meets: SRS announces each closed segment over
`on_hls` once per rung, so the ladder asks for `rungs / HLS_FRAGMENT` announcements a second.
Measured on the deployment host 2026-08-31, SRS sustains about **6.7 a second** while its own
encoders were producing 8.0. Nothing errors. Announcements fall behind the media at 0.46s per second
of video until the lag passes `HLS_WINDOW`, after which SRS deletes each segment before announcing
it, the tallest rung is unpublished about two minutes in, and the master feed goes on advertising it.

| rungs | fragment |      asks | against ~6.7/s                                     |
| ----: | -------: | --------: | -------------------------------------------------- |
|     1 |     0.5s |     2.0/s | fine, and the table above applies                  |
|     4 |     0.5s | **8.0/s** | **over. Loses the top rung every broadcast**       |
|     4 |     1.0s |     4.0/s | 40% spare. Verified over 600s: lag flat, zero lost |
|     4 |     2.0s |     2.0/s | 70% spare                                          |

So a four-rung ladder runs at `HLS_FRAGMENT=1.0` and pays about one second of capture-to-fetchable
for it (1.96s against 2.94s, 2026-08-03 sweep of 105 samples). ⚠️ The 6.7/s is one measurement on a
co-tenanted host and is not yet a gate. Nothing refuses a ladder that asks for more.

**Why not go below 0.5s**, on the two reasons that survived a replicate:

1. **Shipped config cannot get there.** `HLS_FRAGMENT` is `0.5`, and a segment is
   `ceil(GOP / fragment) * fragment`, so asking an encoder for 0.25s yields 0.5s segments anyway.
   Reaching sub-0.5 takes a second deliberate change that no default leads to.
2. **It buys nothing and costs more.** A 0.25s GOP measured 5.86s behind live against 1.0s's 5.52s
   and wrote 24% more BZZ.

⛔ **This table used to carry a fourth column reporting 18-21% of live-edge reads 404ing at 0.25s,
and that number is withdrawn.** A replicate the same afternoon on the same rig gave 2.9%, 13.1% and
0.0%, and all 19 refusals were retrievable again within 140ms. The cause is a publish race of ours,
not the GOP: the feed slot naming a segment syncs before the segment bytes do, so a bench reader at
the live edge asks too early. A viewer's hls.js retries. **The recommendation did not change, the
reason for it did.**

See [gop-sustain](../docs/bench/gop-sustain-2026-08-12.md),
[gop-floor](../docs/bench/gop-floor-2026-08-12.md) and, for the withdrawal,
[gop-floor-replicate](../docs/bench/gop-floor-replicate-2026-08-12.md).

⚠️ `HLS_FRAGMENT` (default `0.5`) is a **floor** on the segment, not the segment. A GOP below it is
rounded up, so lowering the encoder's keyframe interval without lowering `HLS_FRAGMENT` to match
changes nothing. The pair is a range: a GOP outside `[HLS_FRAGMENT, HLS_FRAGMENT * HLS_AOF_RATIO]`,
shipped as `[0.5, 2.5]`, is either rounded up or force-cut without a keyframe.

⛔ **`HLS_FRAGMENT` now reaches the stream-uploader as well as the engine, and it is what every
segment's `#EXT-X-PROGRAM-DATE-TIME` steps by.** Set it once in the profile's `.env` and both
services read the same value. Set it for the engine alone and the uploader falls back to `0.5`,
which dates a recording against a fragment length nothing produced. Under a ladder the declared
length is also the real one, because each rung is re-GOPed at `ABR_FPS x HLS_FRAGMENT`. On a
single-rendition stream the publisher's own GOP decides the segment, so a broadcaster sending a
longer GOP produces segments longer than the stamps step by. See
[the manifest contract](../packages/stream-uploader/README.md#the-manifest-contract-timestamps-and-sequence-zero).

## Scripts

### deploy.sh

```bash
deploy.sh [--profile=<name>] [--portSlot=<N>] [--host=<target>] [service...]
```

```bash
deploy.sh bee-uploader                              # just the bee node (default profile)
deploy.sh srs stream-uploader                       # just the streaming stack (default profile)
deploy.sh                                           # everything enabled in config.json (default profile)
deploy.sh --profile=streamer1                       # full stack as isolated streamer1 instance
deploy.sh --profile=streamer1 --portSlot=1          # ...slot 1: every default port shifted by +10
deploy.sh --profile=streamer2 --portSlot=2          # streamer2 with slot 2 (+20)
deploy.sh --host=localhost                          # ignore config.json targets, deploy everything locally
deploy.sh --host=user@server                        # ignore config.json targets, deploy everything to user@server
```

> Always run with bash: `bash ./deploy/scripts/deploy.sh ...` or `./deploy/scripts/deploy.sh ...`. Invoking it via `sh` (POSIX) breaks bash-only features used in the script.

#### Profiles

A profile is a deployment instance — same topology (from `config.json`), separate identity. Each profile gets its own:

- **Docker compose project name** (`-p <profile>`) — namespaces containers and named volumes (`streamer1-bee-uploader-1`, `streamer1_srs-media`, ...).
- **Env file** at `<repo-root>/.env.<profile>` — required when `--profile` is given (no silent fallback to `.env`).
- **Engine env files** at `engines/<engine>/.env.<profile>` for each enabled engine — created automatically on first deploy (copied from the engine's `.env`, or its `.env.sample`). Engine ports (`OME_SRT_PORT`, `OME_HLS_PORT`, ...) are **not** shifted by `--portSlot`, so review the generated file when running multiple instances on one host.
- **Bee data dir** (set `BEE_UPLOADER_DATA_DIR=./data/bee-uploader-<profile>` etc. in the profile env).
- **Host ports** — see `--portSlot` below for the easy way; or set `BEE_UPLOADER_API_PORT`, `API_PORT`, `SRS_*_PORT`, ... explicitly in `.env.<profile>`.
- **Remote dir** when targets are SSH hosts: `~/swarm-hls-stream-<profile>`.

#### --portSlot

`--portSlot=<N>` (integer 1-99) **shifts** every port var the deploy knows about by `N*10`. Each service occupies a unique last digit in the base table (0-8), so two profiles can never collide on a port. When the flag is given it is **authoritative** — any port values in `.env.<profile>` are ignored, so what you see in the topology block is exactly what compose maps. Drop the flag (or pass `--portSlot=0`) to fall back to env-file values.

99 is the ceiling because the slot arithmetic owns a second block: the per-rung bee nodes take 11001 to 11006 at slot 0, shifted the same way, and slot 100 would put `API_PORT` at 11000 and the rest of the first block straight on top of them. Anything above 99 is refused with that named as the reason.

| Var                   |  Base | `--portSlot=1` | `--portSlot=2` | `--portSlot=99` |
| --------------------- | ----: | -------------: | -------------: | --------------: |
| API_PORT              | 10000 |          10010 |          10020 |           10990 |
| SRS_SRT_PORT          | 10001 |          10011 |          10021 |           10991 |
| SRS_RTMP_PORT         | 10002 |          10012 |          10022 |           10992 |
| SRS_HTTP_PORT         | 10003 |          10013 |          10023 |           10993 |
| CLIENT_PORT           | 10004 |          10014 |          10024 |           10994 |
| BEE_UPLOADER_API_PORT | 10005 |          10015 |          10025 |           10995 |
| BEE_UPLOADER_P2P_PORT | 10006 |          10016 |          10026 |           10996 |
| BEE_GATEWAY_API_PORT  | 10007 |          10017 |          10027 |           10997 |
| BEE_GATEWAY_P2P_PORT  | 10008 |          10018 |          10028 |           10998 |

The **Base** column is the slot arithmetic's starting point, not what you get with no flag. Without `--portSlot`, values already set in the env files win and only the unset ones fall back to this column, so the SRS ports in a stock local setup are `SRS_SRT_PORT=10080` from `engines/srs/.env.sample` and `SRS_RTMP_PORT=1935` / `SRS_HTTP_PORT=8080` from the compose file's own defaults, not 10001 through 10003.

`SRS_ADAPTER_PORT` is auto-mirrored to whatever `API_PORT` resolves to, so SRS webhooks always reach the right uploader.

`--portSlot=0` (the default) is a no-op — defaults flow through compose as before.

#### --host

`--host=<target>` ignores the per-service targets in `config.json` and sends every **enabled** service to `<target>`. `<target>` can be:

- `localhost` — run everything in Docker on this machine.
- `user@host` or an SSH alias from `~/.ssh/config` — deploy via SSH + rsync to that host.

Services set to `false` in `config.json` stay disabled. The flag is handy for one-shot deploys to a host that isn't your committed topology (e.g. validating a remote server, or moving a profile to localhost without editing `config.json`):

```bash
deploy.sh --host=localhost --profile=streamer1 --portSlot=1
deploy.sh --host=my-staging-box stream-uploader bee-uploader
```

Because every service resolves to the same target under `--host`, the usual co-location constraints (e.g. `srs` + `stream-uploader`) are satisfied automatically.

Setup for a new profile:

```bash
cp .env .env.streamer1
$EDITOR .env.streamer1   # set STAMP + STREAM_KEY + *_DATA_DIR
deploy.sh --profile=streamer1 --portSlot=1
```

Without `--profile` everything works exactly as before — implicit `default` profile, `.env`, unprefixed `~/swarm-hls-stream`, no port shift.

### clean.sh

```bash
clean.sh [--profile=<name>] [--volumes] [--all] [--yes] [service...]
```

```bash
clean.sh                                 # remove all containers (default profile)
clean.sh bee-uploader                    # remove only bee-uploader
clean.sh --volumes                       # remove containers + Docker volumes (data loss!)
clean.sh --all                           # remove everything including remote files
clean.sh --profile=streamer1 --volumes   # remove streamer1 containers + its volumes
clean.sh --yes                           # skip the confirmation prompt (for scripted use)
```

### stop.sh / health.sh

```bash
stop.sh   [--profile=<name>] [service...]   # stop containers; all of them if none is named
health.sh [--profile=<name>]                # check service health across all targets
```

Both commands take the same service names as `clean.sh`, and both spend money is
not involved: `stop.sh` stops, it does not remove volumes.

### drain-stage.sh

```bash
drain-stage.sh --profile=<name> --portSlot=<N> --rung=<name> print-buy [--days=2]
drain-stage.sh --profile=<name> --portSlot=<N> --rung=<name> arm --batch=<64 hex>
drain-stage.sh --profile=<name> --portSlot=<N> --rung=<name> restore
drain-stage.sh --profile=<name> --portSlot=<N> --rung=<name> status
```

Points one ABR rung at a deliberately tiny postage batch so the batch runs dry mid-broadcast, then puts the original back. That is the one failure the per-rung split was asked for and the one nothing tests: the node is up, the encoder is up, and every upload comes back refused. The sitting it arms is `docs/e2e-batch-drain-plan.md`.

**The owner buys the batch. The script wires it in.** `print-buy` reads the chain price off the rung's own node and prints one purchase command, the cost in BZZ, and how many chunks the batch takes before it starts refusing. It never runs that command, and says so. `arm` takes the id the purchase returns, rewrites that one rung's entry of `BEE_PUBLISHERS` in `.env.<profile>`, and redeploys the uploader, which is what adopts the line. `restore` writes the original back the same way.

`arm` refuses a batch that would not run dry when the sitting expects it to: one the node does not hold, one it will not spend, one whose depth is not exactly 17 (the smallest depth Bee allows, and the only one a test broadcast can fill, so a deeper batch is refused rather than accepted as roomier), one with less than 25 hours to live, which is the uploader's own 24 hour startup floor plus an hour of margin so a batch does not cross it while the sitting runs, and one that already holds chunks. It also refuses a second arm on a rung that is already armed, because that is what would overwrite the record of the original batch.

The env file is copied to `.env.<profile>.bak-<timestamp>` before either rewrite, and the rung's original batch id is recorded in `.drain-stage.<profile>.env` beside it. That record is gitignored, is what `restore` reads, and is deleted once the last armed rung has been restored. The `.bak` is the second copy, and nothing reads it automatically: an operator who has lost the record recovers the original batch id from the newest `.bak` written before the arm. No batch id is printed whole, only its first eight characters.

Both subcommands also keep the uploader's container log before they redeploy, at `~/drain-<profile>-<rung>-<utc>.uploader.log` on the deployment host, with `-before-arm` on the arm so both process lives survive. A redeploy replaces the container and `docker logs` goes with it, and the first drain sitting lost exactly that. A dump that fails says so and the arm or restore carries on, because a stage left armed is worse than a lost log.

`bee-publishers.sh` cannot do this job: it asks each node for its **healthiest** batch by design, which is the opposite of a batch meant to run out. There is no spend-ledger gate here, unlike `bench-on-host.sh`, because nothing in this script spends from a chequebook. The one purchase is the owner running the printed command, and the broadcast that follows is launched through `bench-on-host.sh`, behind that gate.

### bench-on-host.sh

```bash
bench-on-host.sh [--profile latbench] [--portSlot 7] [--target manager-host] [--script bench:latency]
bench-on-host.sh --setup-only    # sync, build and install, then stop without running anything
bench-on-host.sh --no-setup      # reuse what is already on the host, which is what a sweep repeats
```

Runs a bench or a browser driver on the deployment host instead of on a workstation, so the capture and the fetch sit on one clock and the operator's uplink stays out of the reading. The checkout is synced, an image is built there, and one script runs inside a container over ssh.

**The container is named `<profile>-harness-slot<N>`**, the shape every compose container on that host already has. Every phase of one launch uses that one name, the dependency install included, so `docker stop <profile>-harness-slot<N>` always stops whatever this script started. It is not derived from the image, because a browser run and a bench run on one profile and slot drive the same stage.

**Every script runs behind the ten preflight gates.** A `test:e2e*` script chains `suites/preflight/*.test.ts` with `&&` in `e2e/package.json` and is launched exactly as it is. Everything else, a `browser:*` driver and a `bench:*` run alike, gets `pnpm e2e:preflight && ` prepended inside the container, so a refusal exits non-zero before the driver starts and before any postage is spent. Which family a script is in is read from `package.json` and `e2e/package.json` at launch rather than from a list in the script, because the first version of this gate carried a list, that list named `browser:*` and not `bench:*`, and both benches published into the stage with nothing in front of them. A script the launcher cannot resolve is treated as ungated. No flag turns any of this off, and `browser:selfcheck` is not exempt, because a stage fault is exactly what the selfcheck would otherwise be blamed for.

**A launch is refused when that container exists on the target at all.** One remote read before the sync, and no flag overrides it. Two harness runs on one stage read each other's broadcasts, and the sync runs with `--delete`, so a second launch would also replace the tree the live container is running from. The read passes `-a`, because a container that has exited still holds its name and docker refuses to create a second one under it, so a launch onto an exited orphan used to pay for the sync and the image build and then die inside `docker run`. A running one is refused with the `docker stop` that clears it and an exited one with the `docker rm`, and the script runs neither for you: removing a container it did not create, on a name an operator may be keeping for its logs, is a destructive act taken on a guess. A read that fails refuses as well, and says which read it was, because a target that could not be read cannot be called free.

**An interrupted launch stops the container it would have left behind.** A trap on INT, TERM and EXIT issues one `docker stop` over ssh, with a connect timeout of its own, no retry, and no change to the exit code the run had. A stop that fails says so and says the container may still be broadcasting. It is best effort: a Ctrl-C reaches the whole process group and sometimes kills the shell before its own handler runs, measured with `/bin/bash` at 4 in 60 for TERM and 1 in 60 for INT. The refusal above is the control that always holds, and it catches an orphan whatever left it, a dropped ssh connection included.

Both faults are from 2026-09-04 and happened within two minutes of each other. A killed launch left its container broadcasting for about a minute on a stage armed for a different test, and a second launch then went out on top of it. Between them they cost a postage batch the owner had paid for and a stage arming.

### Node & stamp CLI

```bash
pnpm stamp:setup [--yes]         # full workflow: wait for node -> buy stamp -> write .env
pnpm stamp:buy [amount] [depth] [--immutable] [--yes]
pnpm stamp:check                 # list all stamps
pnpm node:status                 # health + sync status
pnpm node:addresses              # ethereum + overlay addresses
pnpm node:wallets                # BZZ + xDAI balances
```

All commands auto-detect the bee URL from `config.json` + `.env`. Override with `--url <url>`.

## Deploy Scenarios

### Fresh deploy (new node, no stamp)

```bash
./deploy/scripts/setup.sh                    # 1. create config + .env
# edit config.json and .env                  # 2. set targets, STREAM_KEY, NAT_ADDR
./deploy/scripts/deploy.sh bee-uploader      # 3. start bee node
pnpm node:addresses                          # 4. get address, send xDAI + BZZ
pnpm stamp:setup                             # 5. buy stamp, writes STAMP to .env
./deploy/scripts/deploy.sh srs stream-uploader  # 6. start streaming stack
```

### Redeploy streaming stack (node already running)

```bash
./deploy/scripts/deploy.sh srs stream-uploader
```

### Redeploy everything

```bash
./deploy/scripts/deploy.sh
```

Safe to run — skips bee node init if already initialized, `docker compose up` is idempotent.

### Clean restart

```bash
./deploy/scripts/clean.sh --volumes          # remove containers + volumes
./deploy/scripts/deploy.sh                   # redeploy from scratch
```

### Remove everything from remote

```bash
./deploy/scripts/clean.sh --all
```

## How It Works

- `config.json` determines topology, scripts route services to targets
- Each service has a Docker Compose [profile](https://docs.docker.com/compose/how-tos/profiles/) — only activated profiles start
- Cross-target URLs are resolved automatically (e.g. `BEE_URL=http://<remote-ip>:1633` when bee is on a different host)
- Remote deploy: rsync files + start Docker Compose via SSH
- `COMPOSE_NETWORK=host` activates `docker-compose.host.yml` override for host network mode

## Architecture

```
OBS/FFmpeg ──SRT──> SRS (port 10080)
                      |
                      +-- writes .ts segments to shared volume (srs-media)
                      +-- sends webhooks to stream-uploader
                            |
                            +-- on_publish   -> start stream session
                            +-- on_hls      -> read segment, upload to Swarm
                            +-- on_unpublish -> finalize VOD manifest
```

## Services

| Service           | Image                            | Description                                          |
| ----------------- | -------------------------------- | ---------------------------------------------------- |
| `bee-uploader`    | `ethersphere/bee:2.8.1`          | Bee node for uploading to Swarm                      |
| `bee-gateway`     | `ethersphere/bee:2.8.1`          | Bee node for reading (paired with `client`)          |
| `stream-uploader` | Built from `Dockerfile.uploader` | Receives segments, uploads to Swarm                  |
| `srs`             | `ossrs/srs:6`                    | SRT/RTMP to HLS segmenting (no transcode)            |
| `client`          | Built from `Dockerfile.client`   | React viewer (nginx) — proxies `/bee/` → bee-gateway |

### Viewer stack (`client` + `bee-gateway`)

The React client is bundled into a multi-stage docker image: Node builds `packages/client/dist`, nginx serves it on port `80` and reverse-proxies `/bee/` to the `bee-gateway` service over the compose network. The bundle is built with **per-profile** `VITE_APP_OWNER` / `VITE_APP_RAW_TOPIC` baked in (build args wired through `docker-compose.yml`), so streamer1's image and streamer2's image are different and live under their own compose project namespaces.

`client` and `bee-gateway` must be on the same target (nginx proxies via the docker service name).

```bash
# Spin up two viewer instances side-by-side. Each profile env file sets its own
# VITE_APP_OWNER + STREAM_LIST_TOPIC pointing at a different streamer's feed.
deploy.sh --profile=viewer1 --portSlot=4 client bee-gateway
deploy.sh --profile=viewer2 --portSlot=5 client bee-gateway
```

Effective host ports for viewer1 (slot `4`):

- client → `http://localhost:10044`
- bee-gateway API → `http://localhost:10047` (also reachable via `http://localhost:10044/bee/`)

Health check (`./deploy/scripts/health.sh --profile=viewer1`) hits `/` on the client port and `/health` on the gateway port.
