/**
 * `pnpm browser:arm-order <rounds>` — print the order a funded-versus-unfunded sitting runs its arms.
 *
 * ⛔ It exists so the shell driver does not derive the order itself. `burn-rates.sh` was written
 * because one constant lived in three scripts at four different values, corrected only where somebody
 * happened to be looking, and an ordering rule is the same kind of thing: I have already had this one
 * wrong here once, carried from sitting to sitting as a slogan rather than as its arithmetic.
 *
 * Prints one line, space separated, for example:
 *   funded unfunded funded unfunded unfunded funded unfunded funded
 */

import { gatewayArmOrder } from '../src/browser/gatewaySweep.js';

const rounds = Number(process.argv[2]);

if (!Number.isInteger(rounds) || rounds < 1) {
  console.error(`usage: browser:arm-order <rounds>, a whole number of rounds above zero, got ${process.argv[2]}`);
  process.exit(2);
}

console.log(gatewayArmOrder(rounds).join(' '));
