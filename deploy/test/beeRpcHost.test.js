import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const DEPLOY_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const compose = readFileSync(join(DEPLOY_DIR, 'docker-compose.yml'), 'utf8');

/** One service block, from its own name down to the next key at the same indent. */
function blockOf(service) {
  const lines = compose.split('\n');
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

/** Every service the compose file declares, in file order. */
function services() {
  return compose
    .split('\n')
    .map((line) => /^ {2}([a-z0-9-]+):$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1]);
}

const RPC_FLAG = '--blockchain-rpc-endpoint';
const CONFIGURABLE_RPC = '--blockchain-rpc-endpoint=${';
const HOST_ALIAS = 'host.docker.internal:host-gateway';

describe("a node reaching the chain through an endpoint of the operator's own", () => {
  // The flag alone is not the test. bee-gateway carries it deliberately EMPTY,
  // which is half of what puts it in ultra-light mode, so it reaches no chain
  // and an operator has nowhere to point it. Only a service whose endpoint is a
  // variable is one this is about.
  const chainNodes = services().filter((service) => blockOf(service).includes(CONFIGURABLE_RPC));

  it('names every service that talks to the chain, so this file cannot go stale quietly', () => {
    assert.ok(chainNodes.length >= 4, chainNodes.join(', '));
    assert.ok(!chainNodes.includes('bee-gateway'), 'the gateway reaches no chain');
  });

  // The default endpoint is a public RPC, and on 2026-09-15 it answered one
  // deployment's chain listener with 4,568 HTTP 429s in two hours. The cure is
  // an endpoint of the operator's own, which on a single-host install is a
  // process on that host rather than another machine. A container reaches one
  // only by a name the host gateway answers to, and the manager's own api
  // container already proved the route: host.docker.internal:9000 answered in
  // 118ms where the host's public address was refused by its firewall.
  for (const service of chainNodes) {
    it(`lets ${service} reach an endpoint running on the host`, () => {
      assert.match(
        blockOf(service),
        new RegExp(`extra_hosts:[\\s\\S]*${HOST_ALIAS.replace('.', '\\.')}`),
        `${service} takes ${RPC_FLAG} but cannot resolve ${HOST_ALIAS}`,
      );
    });
  }
});

describe('the node a viewer reads through', () => {
  // Levi, 2026-09-15: a viewer node is always an ultra-light node. Ultra-light
  // is bee's name for a light node with swap off, which owns no chequebook and
  // so can never spend. Both halves are stated here rather than left to a
  // variable, because a variable this file offers is a way for a viewer node to
  // start paying, and no deployment path sets it: it is in neither .env.sample
  // nor the manager's container key spec.
  const block = blockOf('bee-gateway');

  it('is a light node, stated rather than configured', () => {
    assert.match(block, /--full-node=false$/m);
  });

  it('has swap off, stated rather than configured', () => {
    assert.match(block, /--swap-enable=false$/m);
    assert.doesNotMatch(block, /--swap-enable=\$\{/);
  });

  /**
   * The half that actually decides the mode, and the half a commit on
   * 2026-09-15 left out. bee reads pkg/node/node.go isChainEnabled:
   * `chainDisabled := swapEndpoint == ""` and `lightMode := !o.FullNodeMode`,
   * and only those two together give ultra-light. --swap-enable takes no part.
   * An endpoint left set here keeps the chain on whatever the other flags say,
   * so the node comes up plain `light`, replays the postage contract for about
   * three minutes on every empty data dir and answers 503 throughout.
   */
  it('reaches no chain at all, which is what makes it ultra-light rather than light', () => {
    assert.match(block, /--blockchain-rpc-endpoint=$/m);
    assert.doesNotMatch(block, /--blockchain-rpc-endpoint=\$\{/);
    assert.doesNotMatch(block, /--blockchain-rpc-endpoint=https?:/);
  });
});
