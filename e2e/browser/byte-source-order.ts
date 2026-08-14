/**
 * `pnpm browser:byte-source-order <rounds>` — print the order a gateway-versus-in-tab-node sitting
 * runs its arms.
 *
 * ⛔ It exists so the shell driver does not derive the order itself, for the reason `browser:arm-order`
 * does: one constant once lived in three scripts at four different values, corrected only where
 * somebody happened to be looking, and an ordering rule is the same kind of thing.
 *
 * Prints one line, space separated, for example:
 *   gateway weeb3 gateway weeb3 weeb3 gateway weeb3 gateway
 */

import { byteSourceArmOrder } from '../src/browser/fetchBackendSweep.js';

const rounds = Number(process.argv[2]);

if (!Number.isInteger(rounds) || rounds < 1) {
  console.error(
    `usage: browser:byte-source-order <rounds>, a whole number of rounds above zero, got ${process.argv[2]}`,
  );
  process.exit(2);
}

console.log(byteSourceArmOrder(rounds).join(' '));
