import { createInterface } from 'node:readline/promises';

import { warn } from './output.js';

/**
 * Ask the operator to approve something irreversible. Anything but an explicit `y` is a refusal, so
 * a stray newline, a piped empty stdin or a closed terminal all decline rather than approve.
 *
 * Without a TTY there is nobody to ask. Returning false there is the only safe answer: a CI job or a
 * `pnpm stamp:buy < /dev/null` would otherwise be approving an on-chain spend by default. `--yes` is
 * how automation says yes, and it has to be said deliberately.
 */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Said out loud rather than returned silently. The caller's abort message is the same one a
    // human refusal produces, so an unattended run otherwise reads as though somebody declined.
    warn('There is no terminal to ask on, so this is declined. Pass --yes to approve it without a prompt.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}
