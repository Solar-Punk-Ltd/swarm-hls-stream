/**
 * `pnpm browser:viewer-order <rounds>` — print the order a gateway-less-versus-hybrid sitting runs
 * its arms.
 *
 * The sibling of `browser:byte-source-order`, and separate from it because these are different
 * VIEWERS rather than two byte sources inside one client. Folding them together would have put
 * `native` into `ByteSource`, whose validators are all about our client's runtime switch and have
 * nothing to say about a page our client is not running in.
 *
 * Prints one line, space separated, for example:
 *   native weeb3 weeb3 native native weeb3 weeb3 native
 */

import { gatewayLessArmOrder } from '../src/browser/viewerConditions.js';

const rounds = Number(process.argv[2]);

if (!Number.isInteger(rounds) || rounds < 1) {
  console.error(`usage: browser:viewer-order <rounds>, a whole number of rounds above zero, got ${process.argv[2]}`);
  process.exit(2);
}

console.log(gatewayLessArmOrder(rounds).join(' '));
