# CLI

TypeScript CLI for managing Bee nodes and postage stamps. Part of the [swarm-hls-stream](../../) monorepo.

Uses [@ethersphere/bee-js](https://github.com/ethersphere/bee-js) for all Bee API interactions. Runs via `tsx` — no build step needed.

## Commands

### Stamp management

| Command              | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `pnpm stamp:setup`   | Full workflow: wait for node → buy stamp → write .env |
| `pnpm stamp:buy`     | Buy a stamp (amount/depth args)                       |
| `pnpm stamp:check`   | List all stamps with status                           |

### Node info

| Command              | Description                    |
| -------------------- | ------------------------------ |
| `pnpm node:status`   | Node health + connected peers  |
| `pnpm node:addresses`| Ethereum + overlay addresses   |
| `pnpm node:wallets`  | Wallet balances (BZZ + xDAI)   |

All commands run from the **monorepo root**.

## Target Resolution

Commands auto-detect the bee-uploader URL by reading:

1. `deploy/config.json` — deployment target for `bee-uploader`
2. `.env` — `BEE_UPLOADER_API_PORT` (default: 1633)

| Config target        | Resolved URL                      |
| -------------------- | --------------------------------- |
| `"localhost"`        | `http://localhost:1633`            |
| `"root@1.2.3.4"`    | `http://1.2.3.4:1633`             |
| `false`              | Falls back to `BEE_URL` from .env |

Override with `--url`:

```bash
pnpm stamp:check --url http://some-other-node:1633
```

Node info commands (`node:status`, `node:addresses`, `node:wallets`) check both bee-uploader and bee-gateway when no `--url` override is given.

## stamp:setup Workflow

The main command for first-time deployment. Automates the full stamp acquisition:

```bash
pnpm stamp:setup
```

1. Polls the bee node until it's healthy
2. Checks wallet balance — if the node has no BZZ or xDAI, prints the node's ethereum address and stops so you can fund it
3. Checks for existing usable stamps — uses one if found
4. Buys a new stamp via `createPostageBatch` (default: amount `10000000000`, depth `20`)
5. Waits for the stamp to become usable (~5 minutes)
6. Writes `STAMP=<batchId>` to the root `.env`

### Node funding

A Bee node needs two tokens on Gnosis Chain to operate:

- **xDAI** — gas fees for transactions
- **BZZ** — payment for postage stamps (storage on Swarm)

`stamp:setup` checks balances and tells you the node's address if funding is needed. Send tokens to that address, then run `stamp:setup` again.

You can also check balances and addresses at any time:

```bash
pnpm node:wallets      # shows BZZ + xDAI balances
pnpm node:addresses    # shows the ethereum address to fund
```

Custom amount and depth:

```bash
pnpm stamp:setup -- 6000000000 23
```

## Project Structure

```
src/
  index.ts                     # CLI entry — command routing, --url parsing
  commands/
    stamp-setup.ts             # Full stamp workflow
    stamp-buy.ts               # Buy a single stamp
    stamp-check.ts             # List all stamps
    node-status.ts             # Health + peers
    node-addresses.ts          # Ethereum + overlay addresses
    node-wallets.ts            # BZZ + xDAI balances
  lib/
    bee-client.ts              # Bee instance factory
    config-reader.ts           # Read config.json + .env, resolve URLs
    env-writer.ts              # Update a key in .env (line-level replace)
    wait.ts                    # Poll with timeout (node health, stamp usability)
    output.ts                  # Colored console output helpers
```
