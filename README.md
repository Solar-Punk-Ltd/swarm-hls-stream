# Swarm HLS Stream

Live and on-demand video streaming over [Swarm](https://www.ethswarm.org/) decentralized storage.

Takes HLS segments from a media server, uploads them to Swarm in real time, and maintains a feed-based manifest that clients can play back without a centralized CDN.

The stream-uploader supports [SRS](https://github.com/ossrs/srs) and OvenMediaEngine (OME). A deployment selects one engine. In standalone mode, other HLS producers can also integrate through the HTTP API.

Standalone uploaders maintain the stream catalogue on Swarm. With `ADMIN_API_URL` set, the admin service owns that catalogue and declares streams before they publish. The uploader authenticates engine publishes against those declarations, writes their media and playlist feeds, and reports stream state back to the admin. The viewer supports both catalogues, including admin-provided thumbnails and scheduled streams.

```
OBS/FFmpeg ──> SRS or OME ──HLS segments──> Stream Uploader ──> Swarm Network
                                                                    |
                                              Client <── feed lookup + segment fetch
```

## Packages

| Package                                      | Description                                              |
| -------------------------------------------- | -------------------------------------------------------- |
| [stream-uploader](packages/stream-uploader/) | Receives HLS segments, uploads to Swarm, manages feeds   |
| [client](packages/client/)                   | React app for browsing and playing Swarm-backed streams  |
| [cli](packages/cli/)                         | Bee node and postage stamp management                    |
| [shared](packages/shared/)                   | Shared stream, playlist and publish-key contracts        |
| [audit-gate](packages/audit-gate/)           | Dependency advisory checks and their recorded exceptions |
| [gate-facts](packages/gate-facts/)           | Collects change, test and dependency provenance evidence |
| [deploy](deploy/)                            | Deployment scripts, service profiles and their tests     |
| [e2e](e2e/)                                  | Deployed-stream scenarios and tests of the test harness  |

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
pnpm verify                        # lint, typecheck, build, test and format check in one go
```

`pnpm verify` stops at the first failing stage, so a lint error hides later test
results. CI does the same: its `verify` job runs typecheck, lint, build and test
as four steps of one job, and a failing step ends the job. Only the format check
runs as a job of its own, so it reports whatever the other four did.

Two CI jobs are deliberately outside `pnpm verify`, so the local loop needs
neither a registry nor a docker daemon: `pnpm audit:check` for dependency
advisories, and `pnpm shellcheck` for the deploy and node shell scripts. Run
either directly before touching what it covers.

### Agent hook settings

`.claude/settings.json` is committed, so it applies to everyone working in this
repository, not just one machine. Its `ECC_DISABLED_HOOKS` setting names both
`pre:edit-write:gateguard-fact-force` and `pre:bash:gateguard-fact-force`, disabling
the fact-recital hooks for file edits and shell commands in a harness that reads
that setting. The file does not establish which other hooks are installed or
enforced by a particular tool.

## CLI

```bash
pnpm stamp:setup [--yes]           # full workflow: wait for node, buy stamp, write .env
pnpm stamp:buy [amount] [depth] [--immutable] [--yes]
pnpm stamp:check                   # list all stamps
pnpm node:status                   # health + sync status
pnpm node:addresses                # ethereum + overlay addresses
pnpm node:wallets                  # BZZ + xDAI balances
```

All commands auto-detect the bee URL from `deploy/config.json`. Override with `--url <url>`.

## QoE Overlay

The player supports an in-browser quality-of-experience overlay. See [client/README.md#qoe-overlay](packages/client/README.md#qoe-overlay).

## Configuration

The root `.env` holds the core variables. See [.env.sample](.env.sample). **Engine-specific variables live next to each engine** in `engines/<name>/.env` (copy from [engines/srs/.env.sample](engines/srs/.env.sample) / [engines/ome/.env.sample](engines/ome/.env.sample)). The uploader automatically loads the file for the engine selected via `ENGINE`. `setup.sh` creates these files for engines enabled in `deploy/config.json`. Values in the root `.env` (or injected container env) take precedence over the engine file.

## Project Structure

```
packages/
  stream-uploader/     # HLS segment uploader service
  client/              # React stream player
  cli/                 # Bee node + stamp CLI
  shared/              # Shared stream and playlist contracts
  audit-gate/          # Dependency advisory checker
  gate-facts/          # Change, test and dependency evidence collector
engines/
  srs/                 # SRS media server config + entrypoint
  ome/                 # OME media server config + entrypoint
deploy/
  scripts/             # setup, deploy, stop, health, clean
  docker-compose.yml   # All services with profiles
  config.sample.json   # Deployment topology template
e2e/                   # Live scenarios, browser drivers and harness unit tests
```

## License

MIT
