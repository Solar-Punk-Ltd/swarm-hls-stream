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

Each service maps to a target: `"localhost"`, `"user@host"`, or `false` (disabled).

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

### .env

Single `.env` in monorepo root, shared by dev and deploy. See [.env.sample](../.env.sample) for all options.

## Scripts

### deploy.sh

```bash
deploy.sh [service...]           # deploy specified services (or all if none given)
```

```bash
deploy.sh bee-uploader           # just the bee node
deploy.sh srs stream-uploader    # just the streaming stack
deploy.sh                        # everything enabled in config.json
```

### clean.sh

```bash
clean.sh [--volumes] [--all] [service...]
```

```bash
clean.sh                         # remove all containers
clean.sh bee-uploader            # remove only bee-uploader
clean.sh --volumes               # remove containers + Docker volumes (data loss!)
clean.sh --all                   # remove everything including remote files
```

### stop.sh / health.sh

```bash
stop.sh                          # stop all containers across all targets
health.sh                        # check service health across all targets
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
