import { StampCommandArgs } from './stamp.js';

export interface ParsedArgs {
  command: string;
  url?: string;
  /**
   * Which ABR rung to act on, as a flag rather than a leading positional.
   *
   * A positional whose meaning depends on whether BEE_PUBLISHERS is set would give `stamp-buy` and
   * `stamp-setup` different argument orders and give a single-node operator's amount to the rung
   * lookup. This file already carries one instance of a positional silently becoming the wrong
   * number, below.
   */
  rung?: string;
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
  let rung: string | undefined;
  let immutable: boolean | undefined;
  let assumeYes = false;
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (args[i] === '--rung' && args[i + 1]) {
      rung = args[i + 1];
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

  return { command, url, rung, immutable, assumeYes, positional };
}

export function stampArgs(a: ParsedArgs): StampCommandArgs {
  return {
    url: a.url,
    rung: a.rung,
    amount: a.positional[0],
    depth: a.positional[1] ? parseInt(a.positional[1], 10) : undefined,
    immutable: a.immutable,
    assumeYes: a.assumeYes,
  };
}

/** The only command that acts on a rung. Every other one parses `--rung` and would drop it. */
const RUNG_COMMANDS = new Set(['stamp-buy']);

/**
 * Refuse `--rung` on a command that does not act on one, rather than parsing and silently dropping
 * it.
 *
 * The rung is a global flag so it can be a flag rather than a leading positional, but only
 * `stamp-buy` spends per rung. `pnpm stamp:setup -- --rung 1080p` was otherwise accepted and
 * ignored, then bought on the single-node uploader with no prompt: the operator named one node and
 * funded another. A flag the command cannot honour is a mistake to stop on, not to carry past.
 */
export function assertRungFlagSupported(a: ParsedArgs): void {
  if (a.rung !== undefined && !RUNG_COMMANDS.has(a.command)) {
    throw new Error(
      `${a.command} does not take --rung. Only stamp-buy acts on a rung, because a postage batch ` +
        'can only be spent by the node that bought it. Drop the flag, or run stamp-buy.',
    );
  }
}
