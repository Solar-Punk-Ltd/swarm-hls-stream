# CLI

TypeScript CLI for managing Bee nodes and postage stamps. Part of the [swarm-hls-stream](../../) monorepo.

Uses [@ethersphere/bee-js](https://github.com/ethersphere/bee-js) for all Bee API interactions. Runs via `tsx` — no build step needed.

## Commands

### Stamp management

| Command            | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `pnpm stamp:setup` | Full workflow: wait for node → buy stamp → write .env |
| `pnpm stamp:buy`   | Buy a stamp: `[--rung <rung>] [amount] [depth]`       |
| `pnpm stamp:check` | List all stamps with status                           |

`--rung` picks which publisher buys, and is required once `BEE_PUBLISHERS` is set:
a batch can only be spent by the node that bought it. Without it the single-node
path is used, which is `BEE_URL` and `STAMP`.

Both commands that spend show the batch cost and how long it will last, then ask
to confirm. `--yes` approves without a prompt, and is required for any run with
no terminal: without one the confirmation is declined rather than assumed.

### Node info

| Command               | Description                   |
| --------------------- | ----------------------------- |
| `pnpm node:status`    | Node health + connected peers |
| `pnpm node:addresses` | Ethereum + overlay addresses  |
| `pnpm node:wallets`   | Wallet balances (BZZ + xDAI)  |

All commands run from the **monorepo root**.

## Target Resolution

**The read-only commands run against every configured Bee node.** Which nodes those are depends on whether the deployment has been split per ABR rung.

`stamp:buy` is the exception — it takes a rung and acts on exactly one node. See below.

### With `BEE_PUBLISHERS` set — one node per rung

The publishers are read straight out of `BEE_PUBLISHERS` (see [.env.sample](../../.env.sample)), so there is one source of truth and it is the same variable the uploader reads. A node per rung means **four wallets to fund and four batches to watch per stage**, and a command that only looked at one of them would hide three quarters of that.

The URLs are used as written. In a Docker deployment the host's `.env` holds host-reachable URLs while compose overrides the uploader container's copy with compose service names — the same split `BEE_URL` already has.

`stamp:check` looks at the publishers only. The gateway runs with swap disabled and buys nothing, so it appears in the node info commands and not there.

### Without it — the single-node deployment

Falls back to the previous behaviour: the bee-uploader URL, auto-detected from

1. `deploy/config.json` — deployment target for `bee-uploader`
2. `.env` — `BEE_UPLOADER_API_PORT` (default: 1633)

| Config target    | Resolved URL                      |
| ---------------- | --------------------------------- |
| `"localhost"`    | `http://localhost:1633`           |
| `"root@1.2.3.4"` | `http://1.2.3.4:1633`             |
| `false`          | Falls back to `BEE_URL` from .env |

### `--url`

Narrows to a single node:

```bash
pnpm stamp:check --url http://localhost:1663
```

A URL that matches a configured publisher **keeps that node's identity** — its rung and its configured batch — so `stamp:check --url` can still tell you which of that node's batches is the one in use. A URL that matches nothing is reached anyway, as an anonymous node.

## stamp:buy takes a rung

A postage batch is held by the node that bought it and can only be spent by that node, so which node is not something to leave implicit:

```bash
pnpm stamp:buy --rung 360p
pnpm stamp:buy --rung 1080p 6000000000 23
```

The rung is a flag, not a leading positional: a positional whose meaning changed with `BEE_PUBLISHERS`
would hand a single-node operator's amount to the rung lookup. The rung is required and validated
against `BEE_PUBLISHERS`. An unknown rung, a missing rung, or an unsplit config all fail before any network call, listing the rungs that _are_ configured:

```
✗ No node configured for rung "1080p". Configured rungs: 360p, 720p
```

Falling back to some default node would put the batch somewhere that cannot spend it, and nothing would fail at that point — it would fail later, as a rung that stops publishing while a healthy batch sits on the wrong node.

Validation is against `BEE_PUBLISHERS` rather than `ABR_LADDER`, which lives in the engine's own `.env` and is not loaded here. In a working config the two agree: the uploader refuses to start unless the publisher list covers the ladder exactly.

**`STAMP=<batchId>` is written to the root `.env`**, the same way `stamp:setup` does it and for the
same reason: a batch you paid for must never live only in terminal scrollback (OPS-1). It replaces any
previous `STAMP` value, and the old batch still exists on chain. On a split deployment `STAMP` is not
the variable that pays for the rung — `BEE_PUBLISHERS` is — and that one is not edited in place because
it holds an entry per rung, so the line to paste in is printed for you:

```
  Batch ID: 88fb1a…5628

  Put it in BEE_PUBLISHERS, replacing this rung's entry:
    360p@http://localhost:1633<88fb1a…5628>

  Written STAMP=88fb1a…5628 to .env
```

Amount and depth are the same for every rung. Sizing a batch to the rung it pays for is a real concern — 1080p exhausts a given depth roughly 7× sooner than 360p — and is deliberately left out.

## stamp:setup Workflow

The main command for first-time deployment. Automates the full stamp acquisition:

```bash
pnpm stamp:setup
```

1. Polls the bee node until it's healthy
2. Checks wallet balance. If the node has no BZZ or xDAI, prints the node's ethereum address and stops so you can fund it
3. Checks for existing usable stamps, and uses one if found
4. Checks the root `.env` can be written, and **refuses to buy anything if it cannot**. A batch id that cannot be recorded is worth nothing, and this is the last moment refusing is free
5. Buys a new stamp via `createPostageBatch` (default: amount `10000000000`, depth `20`)
6. Writes `STAMP=<batchId>` to the root `.env` **immediately**, before anything else that can fail
7. Waits for the stamp to become usable (~5 minutes)

Steps 6 and 7 are in that order deliberately. The wait routinely times out on a slow chain, and it
used to sit between the purchase and the only write, so a timeout meant a batch you had paid for
whose id existed only in terminal scrollback.

If the write fails after the purchase, the command writes the id to a recovery file, prints it, and
exits non-zero. It never reports success for a batch it could not record. `pnpm stamp:buy` behaves
the same way.

> This is the **single-node** workflow and it is unchanged. It writes `STAMP`, which a deployment
> using `BEE_PUBLISHERS` does not read — with the publishers split, buy per rung with `stamp:buy`
> and put each batch in `BEE_PUBLISHERS` yourself.

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
pnpm stamp:setup -- 6000000000 23 --yes
```

## Project Structure

```
src/
  index.ts                     # CLI entry — command routing, --url parsing
  commands/
    stamp-setup.ts             # Full stamp workflow, single node
    stamp-buy.ts               # Buy a batch for one rung, by name
    stamp-check.ts             # List all stamps, flagging the configured one
    node-status.ts             # Health + peers
    node-addresses.ts          # Ethereum + overlay addresses
    node-wallets.ts            # BZZ + xDAI balances, warning on unfunded publishers
  lib/
    bee-client.ts              # Bee instance factory
    config-reader.ts           # Read config.json + .env, resolve node targets
    publishers.ts              # Parse BEE_PUBLISHERS (read-only)
    nodes.ts                   # Iterate nodes, apply --url, select a publisher by rung
    env-writer.ts              # Update a key in .env (line-level replace)
    wait.ts                    # Poll with timeout (node health, stamp usability)
    output.ts                  # Colored console output helpers
test/
  publishers.test.ts           # BEE_PUBLISHERS parsing
  targets.test.ts              # Node target resolution, --url narrowing, rung selection
```
