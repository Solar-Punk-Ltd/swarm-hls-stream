import { StampCommandArgs } from './stamp.js';

export interface ParsedArgs {
  command: string;
  url?: string;
  immutable?: boolean;
  assumeYes: boolean;
  positional: string[];
}

/**
 * Parse argv for every command. Lives here rather than in `index.ts` so it can be tested: importing
 * the entry point runs `main()`, and the argv that decides whether an on-chain spend is confirmed is
 * not something to leave untested for that reason.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0];
  let url: string | undefined;
  let immutable: boolean | undefined;
  let assumeYes = false;
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (args[i] === '--immutable') {
      immutable = true;
    } else if (args[i] === '--yes' || args[i] === '-y') {
      assumeYes = true;
    } else if (args[i] === '--') {
      // pnpm requires `--` before forwarding arguments to a script, and forwards the separator
      // itself. Left in, it became the amount: `pnpm stamp:setup -- 6000000000 23`, the command the
      // CLI README documents, priced a batch of depth 6000000000.
      continue;
    } else {
      positional.push(args[i]);
    }
  }

  return { command, url, immutable, assumeYes, positional };
}

export function stampArgs(a: ParsedArgs): StampCommandArgs {
  return {
    url: a.url,
    amount: a.positional[0],
    depth: a.positional[1] ? parseInt(a.positional[1], 10) : undefined,
    immutable: a.immutable,
    assumeYes: true,
  };
}
