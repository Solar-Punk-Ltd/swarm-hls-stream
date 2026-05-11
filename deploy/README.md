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
deploy.sh [--profile=<name>] [--portSlot=<N>] [service...]
```

```bash
deploy.sh bee-uploader                              # just the bee node (default profile)
deploy.sh srs stream-uploader                       # just the streaming stack (default profile)
deploy.sh                                           # everything enabled in config.json (default profile)
deploy.sh --profile=streamer1                       # full stack as isolated streamer1 instance
deploy.sh --profile=streamer1 --portSlot=1          # ...slot 1: every default port shifted by +10
deploy.sh --profile=streamer2 --portSlot=2          # streamer2 with slot 2 (+20)
```

> Always run with bash: `bash ./deploy/scripts/deploy.sh ...` or `./deploy/scripts/deploy.sh ...`. Invoking it via `sh` (POSIX) breaks bash-only features used in the script.

#### Profiles

A profile is a deployment instance — same topology (from `config.json`), separate identity. Each profile gets its own:

- **Docker compose project name** (`-p <profile>`) — namespaces containers and named volumes (`streamer1-bee-uploader-1`, `streamer1_srs-media`, ...).
- **Env file** at `<repo-root>/.env.<profile>` — required when `--profile` is given (no silent fallback to `.env`).
- **Bee data dir** (set `BEE_UPLOADER_DATA_DIR=./data/bee-uploader-<profile>` etc. in the profile env).
- **Host ports** — see `--portSlot` below for the easy way; or set `BEE_UPLOADER_API_PORT`, `API_PORT`, `SRS_*_PORT`, ... explicitly in `.env.<profile>`.
- **Remote dir** when targets are SSH hosts: `~/swarm-hls-stream-<profile>`.

#### --portSlot

`--portSlot=<N>` (integer 1-999) **shifts** every port var the deploy knows about by `N*10`. Each service occupies a unique last digit in the base table (0-8), so two profiles can never collide on a port. When the flag is given it is **authoritative** — any port values in `.env.<profile>` are ignored, so what you see in the topology block is exactly what compose maps. Drop the flag (or pass `--portSlot=0`) to fall back to env-file values.

| Var                   | Default | `--portSlot=1` | `--portSlot=2` | `--portSlot=999` |
| --------------------- | ------: | -------------: | -------------: | ---------------: |
| API_PORT              |   10000 |          10010 |          10020 |            19990 |
| SRS_SRT_PORT          |   10001 |          10011 |          10021 |            19991 |
| SRS_RTMP_PORT         |   10002 |          10012 |          10022 |            19992 |
| SRS_HTTP_PORT         |   10003 |          10013 |          10023 |            19993 |
| CLIENT_PORT           |   10004 |          10014 |          10024 |            19994 |
| BEE_UPLOADER_API_PORT |   10005 |          10015 |          10025 |            19995 |
| BEE_UPLOADER_P2P_PORT |   10006 |          10016 |          10026 |            19996 |
| BEE_GATEWAY_API_PORT  |   10007 |          10017 |          10027 |            19997 |
| BEE_GATEWAY_P2P_PORT  |   10008 |          10018 |          10028 |            19998 |

`SRS_ADAPTER_PORT` is auto-mirrored to whatever `API_PORT` resolves to, so SRS webhooks always reach the right uploader.

`--portSlot=0` (the default) is a no-op — defaults flow through compose as before.

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

| Service           | Image                            | Description                                          |
| ----------------- | -------------------------------- | ---------------------------------------------------- |
| `bee-uploader`    | `ethersphere/bee:2.7.1`          | Bee node for uploading to Swarm                      |
| `bee-gateway`     | `ethersphere/bee:2.7.1`          | Bee node for reading (paired with `client`)          |
| `stream-uploader` | Built from `Dockerfile.uploader` | Receives segments, uploads to Swarm                  |
| `srs`             | `ossrs/srs:6`                    | SRT/RTMP to HLS transcoding                          |
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
