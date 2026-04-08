# Swarm HLS Stream

Live and on-demand video streaming over [Swarm](https://www.ethswarm.org/) decentralized storage.

Takes HLS segments from any media server, uploads them to Swarm in real-time, and maintains a feed-based manifest that clients can play back — no centralized CDN required.

The stream-uploader has a pluggable engine architecture. [SRS](https://github.com/ossrs/srs) is included as the default engine, but any server that produces HLS segments can integrate via the HTTP API.

```
OBS/FFmpeg ──SRT──> SRS ──HLS segments──> Stream Uploader ──> Swarm Network
                                                                    |
                                              Client <── feed lookup + segment fetch
```

## Packages

| Package                                      | Description                                             |
| -------------------------------------------- | ------------------------------------------------------- |
| [stream-uploader](packages/stream-uploader/) | Receives HLS segments, uploads to Swarm, manages feeds  |
| [client](packages/client/)                   | React app for browsing and playing Swarm-backed streams |
| [cli](packages/cli/)                         | Bee node and postage stamp management                   |

## Prerequisites

- Node.js 20+ and pnpm
- Docker and Docker Compose
- [jq](https://jqlang.github.io/jq/download/) (for deploy scripts)
- A funded Bee node on Gnosis Chain (xDAI + BZZ)

## Getting Started

See [deploy/README.md](deploy/README.md) for setup, configuration, and deployment scenarios.

## Development

```bash
pnpm install
pnpm build                         # build all packages
pnpm dev                           # start client dev server (localhost:5173)
pnpm start:uploader                # start stream-uploader locally
pnpm srs:up                        # start SRS standalone (host network)
```

## CLI

```bash
pnpm stamp:setup                   # full workflow: wait for node, buy stamp, write .env
pnpm stamp:buy [amount] [depth] [--immutable]
pnpm stamp:check                   # list all stamps
pnpm node:status                   # health + sync status
pnpm node:addresses                # ethereum + overlay addresses
pnpm node:wallets                  # BZZ + xDAI balances
```

All commands auto-detect the bee URL from `deploy/config.json`. Override with `--url <url>`.

## Configuration

A single `.env` file in the monorepo root configures everything. See [.env.sample](.env.sample).

## Project Structure

```
packages/
  stream-uploader/     # HLS segment uploader service
  client/              # React stream player
  cli/                 # Bee node + stamp CLI
engines/
  srs/                 # SRS media server config + entrypoint
deploy/
  scripts/             # setup, deploy, stop, health, clean
  docker-compose.yml   # All services with profiles
  config.sample.json   # Deployment topology template
```

## License

MIT
