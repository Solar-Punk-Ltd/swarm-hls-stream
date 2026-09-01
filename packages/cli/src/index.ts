import { nodeAddresses } from './commands/node-addresses.js';
import { nodeStatus } from './commands/node-status.js';
import { nodeWallets } from './commands/node-wallets.js';
import { stampBuy } from './commands/stamp-buy.js';
import { stampCheck } from './commands/stamp-check.js';
import { stampSetup } from './commands/stamp-setup.js';
import { error } from './lib/output.js';

interface ParsedArgs {
  command: string;
  url?: string;
  immutable?: boolean;
  positional: string[];
}

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<void>> = {
  'node-status': (a) => nodeStatus(a.url),
  'node-addresses': (a) => nodeAddresses(a.url),
  'node-wallets': (a) => nodeWallets(a.url),
  'stamp-check': (a) => stampCheck(a.url),
  'stamp-buy': async (a) => {
    // Rung first: a batch can only be spent by the node that bought it, so which node is not a
    // detail to leave implicit.
    await stampBuy(
      a.url,
      a.positional[0],
      a.positional[1],
      a.positional[2] ? parseInt(a.positional[2], 10) : undefined,
      a.immutable,
    );
  },
  'stamp-setup': (a) =>
    stampSetup(
      a.url,
      a.positional[0],
      a.positional[1] ? parseInt(a.positional[1], 10) : undefined,
      a.immutable,
    ),
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0];
  let url: string | undefined;
  let immutable: boolean | undefined;
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (args[i] === '--immutable') {
      immutable = true;
    } else {
      positional.push(args[i]);
    }
  }

  return { command, url, immutable, positional };
}

function printUsage(): void {
  console.log('Usage: tsx packages/cli/src/index.ts <command> [--url <bee-url>] [args...]');
  console.log('');
  console.log('Commands:');
  console.log('  node-status       Node health + sync status');
  console.log('  node-addresses    Ethereum + overlay addresses');
  console.log('  node-wallets      Wallet balances (BZZ + xDAI)');
  console.log('  stamp-check       List all stamps with status');
  console.log('  stamp-buy         Buy a stamp for one rung: <rung> [amount] [depth] [--immutable]');
  console.log('  stamp-setup       Full workflow: wait → buy → write .env [--immutable]');
  console.log('');
  console.log('Read-only commands run against every configured Bee node. With BEE_PUBLISHERS set that');
  console.log('is one node per ABR rung, so a stage has four wallets and four batches to keep an eye on.');
  console.log('stamp-buy is the exception: it needs the rung, because a batch can only be spent by the');
  console.log('node that bought it. It prints the batch id and never edits your config.');
  console.log('');
  console.log('Options:');
  console.log('  --url <url>       Act on one node only (matched against the configured nodes)');
  console.log('  --immutable       Create immutable stamp (default: mutable)');
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

  await handler(parsed);
}

main().catch((err) => {
  error(err instanceof Error ? err.message : 'Unexpected error');
  process.exit(1);
});
