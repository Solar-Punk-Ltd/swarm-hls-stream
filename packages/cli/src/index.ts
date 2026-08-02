import { nodeAddresses } from './commands/node-addresses.js';
import { nodeStatus } from './commands/node-status.js';
import { nodeWallets } from './commands/node-wallets.js';
import { stampBuy } from './commands/stamp-buy.js';
import { stampCheck } from './commands/stamp-check.js';
import { stampSetup } from './commands/stamp-setup.js';
import { parseArgs, ParsedArgs, stampArgs } from './lib/args.js';
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
  console.log('  stamp-buy         Buy a stamp [amount] [depth] [--immutable] [--yes]');
  console.log('  stamp-setup       Full workflow: wait → buy → write .env [--immutable] [--yes]');
  console.log('');
  console.log('Options:');
  console.log('  --url <url>       Override bee node URL (auto-detected from config.json)');
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

  await handler(parsed);
}

main().catch((err) => {
  error(err instanceof Error ? err.message : 'Unexpected error');
  process.exit(1);
});
