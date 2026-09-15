import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * What the compose files hand to a browser and to the network, read off the file text.
 *
 * ⛔ The file text is the lever here because there is nothing else to ask. A Bee CORS flag and a
 * published port's host-side address are both arguments to a container this repository never starts
 * in a test: no module reads them, no script derives them, and the only other place either one shows
 * up is a running deployment, where reading it costs a host with a public address and a second
 * machine to dial it from. So this file parses compose the way an operator reads it.
 *
 * It is written to go stale loudly rather than quietly. The service list is computed from the file
 * rather than listed here, so a node added tomorrow is checked without anybody remembering to come
 * back.
 */

/** The Bee flag that lets a page on any other origin read a node's answers. */
const CORS_FLAG = '--cors-allowed-origins';

/**
 * The one Bee node a browser is meant to talk to.
 *
 * The viewer fetches segments from it, so without the flag every retrieval fails at the preflight.
 * The other four hold the postage batches and the wallets this project spends, and nothing in a
 * browser has any business reaching them: the deployed viewer is forced onto the same-origin nginx
 * proxy by `deploy.sh`, and in local development vite proxies the same path.
 */
const BROWSER_FACING = 'bee-gateway';

/** Every compose file that starts a Bee node. */
const BEE_COMPOSE_FILES = ['deploy/docker-compose.yml', 'nodes/docker-compose.yml'];

function composeText(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

/** Every service a compose file declares, in file order. */
function servicesOf(text) {
  return text
    .split('\n')
    .map((line) => /^ {2}([a-z0-9-]+):$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1]);
}

/** One service block, from its own name down to the next key at the same indent. */
function blockOf(text, service) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  assert.notEqual(start, -1, `service ${service} is not in the compose file`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[^ ]/.test(line)) {
      break;
    }
    body.push(line);
  }
  return body.join('\n');
}

/**
 * That only the viewer's node answers a web page.
 *
 * A funded node carrying this flag is a page on any origin reading `/stamps` and getting the full
 * batch ids back, which `/health` truncates precisely because a batch id is the whole of what
 * authorises spending. The same page can then upload its own bytes against one of them, and the
 * first sign of it is a broadcast refused by the postage gate for a batch nobody here filled.
 */
describe('the Bee nodes a web page can talk to', () => {
  for (const file of BEE_COMPOSE_FILES) {
    it(`lets a browser reach ${BROWSER_FACING} and no other node in ${file}`, () => {
      const text = composeText(file);
      const answering = servicesOf(text).filter((service) => blockOf(text, service).includes(CORS_FLAG));

      assert.deepEqual(
        answering,
        [BROWSER_FACING],
        `${CORS_FLAG} belongs to the node a viewer's browser reads through and to no other. On a ` +
          `funded node it lets any page that can route to this host read its full postage batch ids ` +
          `and spend them. Carrying it in ${file}: ${answering.join(', ') || 'nothing'}`,
      );
    });
  }
});
