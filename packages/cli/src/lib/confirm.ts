import { createInterface } from 'node:readline/promises';

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
