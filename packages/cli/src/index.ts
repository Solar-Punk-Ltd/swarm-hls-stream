import { nodeAddresses } from './commands/node-addresses.js';
import { nodeStatus } from './commands/node-status.js';
import { nodeWallets } from './commands/node-wallets.js';
import { stampBuy } from './commands/stamp-buy.js';
import { stampCheck } from './commands/stamp-check.js';
import { stampSetup } from './commands/stamp-setup.js';
import { assertRungFlagSupported, parseArgs, ParsedArgs, stampArgs } from './lib/args.js';
import { error } from './lib/output.js';

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<void>> = {
  'node-status': (a) => nodeStatus(a.url),
  'node-addresses': (a) => nodeAddresses(a.url),
  'node-wallets': (a) => nodeWallets(a.url),
  'stamp-check': (a) => stampCheck(a.url),
  'stamp-buy': async (a) => {
    await stampBuy(stampArgs(a));
  },
  'stamp-setup': (a) => stampSetup(stampArgs(a)),
};

function printUsage(): void {
  console.log('Usage: tsx packages/cli/src/index.ts <command> [--url <bee-url>] [args...]');
  console.log('');
  console.log('Commands:');
  console.log('  node-status       Node health + sync status');
  console.log('  node-addresses    Ethereum + overlay addresses');
  console.log('  node-wallets      Wallet balances (BZZ + xDAI)');
  console.log('  stamp-check       List all stamps with status');
  console.log('  stamp-buy         Buy a stamp [--rung <rung>] [amount] [depth] [--immutable] [--yes]');
  console.log('  stamp-setup       Full workflow: wait → buy → write .env [--immutable] [--yes]');
  console.log('');
  console.log('Read-only commands run against every configured Bee node. With BEE_PUBLISHERS set that');
  console.log('is one node per ABR rung, so a stage has four wallets and four batches to keep an eye on.');
  console.log('stamp-buy is the exception: it needs the rung, because a batch can only be spent by the');
  console.log('node that bought it. It prints the batch id and never edits your config.');
  console.log('');
  console.log('Options:');
  console.log('  --url <url>       Act on one node only (matched against the configured nodes)');
  console.log('  --immutable       Create immutable stamp (default: mutable)');
  console.log('  --yes, -y         Skip the confirmation before an on-chain spend');
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (!parsed.command || parsed.command === '--help' || parsed.command === '-h') {
    printUsage();
    process.exit(parsed.command ? 0 : 1);
  }

  const handler = COMMANDS[parsed.command];
  if (!handler) {
    error(`Unknown command: ${parsed.command}`);
    printUsage();
    process.exit(1);
  }

  // A flag the command cannot act on is rejected here rather than parsed and dropped. See
  // `assertRungFlagSupported`: `stamp:setup --rung` used to buy on a different node than the operator
  // named, with no prompt.
  assertRungFlagSupported(parsed);

  await handler(parsed);
}

main().catch((err) => {
  error(err instanceof Error ? err.message : 'Unexpected error');
  process.exit(1);
});
