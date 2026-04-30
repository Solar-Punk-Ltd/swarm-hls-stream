# Deploy

Config-driven deployment for the Swarm HLS Stream stack.

## Prerequisites

- Docker and Docker Compose
- Node.js 20+ and pnpm
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

| Value | Meaning |
| --- | --- |
| `"localhost"` | Run in Docker on this machine |
| `"user@host"` | Deploy via SSH + rsync to a remote server |
| `"native"` | Service runs as a host process outside Docker — deploy skips it |
| `false` | Disabled, not deployed |

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

Single `.env` in monorepo root, shared by dev and deploy. See [.env.sample](../.env.sample) for all options.

## Scripts

### deploy.sh

```bash
deploy.sh [--profile=<name>] [--portPrefix=<N>] [service...]
```

```bash
deploy.sh bee-uploader                              # just the bee node (default profile)
deploy.sh srs stream-uploader                       # just the streaming stack (default profile)
deploy.sh                                           # everything enabled in config.json (default profile)
deploy.sh --profile=streamer1                       # full stack as isolated streamer1 instance
deploy.sh --profile=streamer1 --portPrefix=1        # ...prefix '1' on missing default ports
deploy.sh --profile=streamer2 --portPrefix=2        # streamer2 with prefix '2'
```

> Always run with bash: `bash ./deploy/scripts/deploy.sh ...` or `./deploy/scripts/deploy.sh ...`. Invoking it via `sh` (POSIX) breaks bash-only features used in the script.

#### Profiles

A profile is a deployment instance — same topology (from `config.json`), separate identity. Each profile gets its own:

- **Docker compose project name** (`-p <profile>`) — namespaces containers and named volumes (`streamer1-bee-uploader-1`, `streamer1_srs-media`, ...).
- **Env file** at `<repo-root>/.env.<profile>` — required when `--profile` is given (no silent fallback to `.env`).
- **Bee data dir** (set `BEE_UPLOADER_DATA_DIR=./data/bee-uploader-<profile>` etc. in the profile env).
- **Host ports** — see `--portPrefix` below for the easy way; or set `BEE_UPLOADER_API_PORT`, `API_PORT`, `SRS_*_PORT`, ... explicitly in `.env.<profile>`.
- **Remote dir** when targets are SSH hosts: `~/swarm-hls-stream-<profile>`.

#### --portPrefix

`--portPrefix=<digit>` (single digit, 1-9) **prepends** that digit to the default value of every port var the deploy knows about. Explicit values in `.env.<profile>` always win — the prefix only fills in *missing* ports, so a profile env can mix a few hand-picked ports with prefixed defaults.

| Var                   | Default | `--portPrefix=1` | `--portPrefix=2` | `--portPrefix=3` |
| --------------------- | ------: | ---------------: | ---------------: | ---------------: |
| BEE_UPLOADER_API_PORT |    1633 |            11633 |            21633 |            31633 |
| BEE_UPLOADER_P2P_PORT |    1634 |            11634 |            21634 |            31634 |
| BEE_GATEWAY_API_PORT  |    1733 |            11733 |            21733 |            31733 |
| BEE_GATEWAY_P2P_PORT  |    1734 |            11734 |            21734 |            31734 |
| API_PORT              |    3000 |            13000 |            23000 |            33000 |
| SRS_SRT_PORT          |   10080 |          110080* |          210080* |          310080* |
| SRS_RTMP_PORT         |    1935 |            11935 |            21935 |            31935 |
| SRS_HTTP_PORT         |    8080 |            18080 |            28080 |            38080 |

*`SRS_SRT_PORT`'s default is already 5 digits, so prepending pushes it past 65535. Set `SRS_SRT_PORT` explicitly in `.env.<profile>` (e.g. `10080`, `20080`, ...) — the script will use that value instead of trying to prefix the default.

`SRS_ADAPTER_PORT` is auto-mirrored to whatever `API_PORT` resolves to, so SRS webhooks always reach the right uploader.

`--portPrefix=0` (the default) is a no-op — defaults flow through compose as before.

Setup for a new profile:

```bash
cp .env .env.streamer1
$EDITOR .env.streamer1   # set STAMP + STREAM_KEY + *_DATA_DIR (+ SRS_SRT_PORT if needed)
deploy.sh --profile=streamer1 --portPrefix=1
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
stop.sh   [--profile=<name>]    # stop all containers across all targets
health.sh [--profile=<name>]    # check service health across all targets
```

### Node & stamp CLI

```bash
pnpm stamp:setup                 # full workflow: wait for node -> buy stamp -> write .env
pnpm stamp:buy [amount] [depth] [--immutable]
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

| Service           | Image                            | Description                         |
| ----------------- | -------------------------------- | ----------------------------------- |
| `bee-uploader`    | `ethersphere/bee:2.7.1`          | Bee node for uploading to Swarm     |
| `bee-gateway`     | `ethersphere/bee:2.7.1`          | Bee node for reading (optional)     |
| `stream-uploader` | Built from `Dockerfile.uploader` | Receives segments, uploads to Swarm |
| `srs`             | `ossrs/srs:6`                    | SRT/RTMP to HLS transcoding         |
