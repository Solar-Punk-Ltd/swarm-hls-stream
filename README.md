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

- Node.js 22+ and pnpm
- Docker and Docker Compose
- [jq](https://jqlang.github.io/jq/download/) (for deploy scripts)
- A funded Bee node on Gnosis Chain (xDAI + BZZ)

## Getting Started

See [deploy/README.md](deploy/README.md) for setup, configuration, and deployment scenarios.

## Development

```bash
pnpm install
pnpm build                         # build all packages
pnpm client:start                  # start client dev server (localhost:5173)
pnpm uploader:start                # start stream-uploader locally
pnpm srs:host                      # start SRS on the host network
pnpm ome:host                      # or start OME instead, the stack runs one engine
pnpm verify                        # lint, typecheck, test and format check in one go
```

`pnpm verify` stops at the first failing stage, so a lint error hides later test
results. CI runs the same four checks as separate jobs and reports all of them.

### Agent hook settings

`.claude/settings.json` is committed, so it applies to everyone working in this
repository, not just one machine. It disables a single Claude Code hook,
`pre:edit-write:gateguard-fact-force`, which required a fact recital before the
first edit to each file. Measured over one day it cost a round trip per file and
never changed what was written. The first-Bash-per-session gate and the
destructive-command gate are both still active. Delete the file locally if you
want the hook back.

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

## QoE Overlay

The player supports an in-browser quality-of-experience overlay — see [client/README.md#qoe-overlay](packages/client/README.md#qoe-overlay).

## Configuration

The root `.env` holds the core variables — see [.env.sample](.env.sample). **Engine-specific variables live next to each engine** in `engines/<name>/.env` (copy from [engines/srs/.env.sample](engines/srs/.env.sample) / [engines/ome/.env.sample](engines/ome/.env.sample)); the uploader automatically loads the file for the engine selected via `ENGINE`. `setup.sh` creates these files for engines enabled in `deploy/config.json`. Values in the root `.env` (or injected container env) take precedence over the engine file.

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
