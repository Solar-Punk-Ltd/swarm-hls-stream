import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifySpawn, SPAWN_ABSENT, SPAWN_OK, SPAWN_TIMED_OUT } from './helpers/spawnOutcome.js';

const DEPLOY_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const compose = readFileSync(join(DEPLOY_DIR, 'docker-compose.yml'), 'utf8');

/**
 * One service block, from its own name down to the first line that is not part of its body.
 *
 * Takes the text because the same reader is pointed at the tracked file and at what
 * `docker compose config` renders, and the render has no service after the gateway to stop at.
 */
function blockOf(text, service) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  assert.notEqual(start, -1, `service ${service} is not in the compose file`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('    ')) {
      break;
    }
    body.push(line);
  }
  return body.join('\n');
}

/** Every service a compose text declares, in file order. */
function services(text) {
  return text
    .split('\n')
    .map((line) => /^ {2}([a-z0-9-]+):$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1]);
}

const RPC_FLAG = '--blockchain-rpc-endpoint';
/** An endpoint flag whose default is an endpoint, so the node reaches a chain unless told otherwise. */
const CHAIN_BY_DEFAULT = /--blockchain-rpc-endpoint=\$\{[A-Z0-9_]+:-\S+\}/;
const HOST_ALIAS = 'host.docker.internal:host-gateway';

describe("a node reaching the chain through an endpoint of the operator's own", () => {
  // The flag is not the test, and since T27 neither is the variable: bee-gateway reads a variable
  // too. What separates the two is the default. These four default to an endpoint and are on the
  // chain unless a deployment says otherwise, while the gateway defaults to nothing and reaches a
  // chain only when it is given one.
  const chainNodes = services(compose).filter((service) => CHAIN_BY_DEFAULT.test(blockOf(compose, service)));

  it('names every service that talks to the chain, so this file cannot go stale quietly', () => {
    assert.ok(chainNodes.length >= 4, chainNodes.join(', '));
    assert.ok(!chainNodes.includes('bee-gateway'), 'the gateway reaches no chain unless it is given an endpoint');
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
        blockOf(compose, service),
        new RegExp(`extra_hosts:[\\s\\S]*${HOST_ALIAS.replace('.', '\\.')}`),
        `${service} takes ${RPC_FLAG} but cannot resolve ${HOST_ALIAS}`,
      );
    });
  }
});

describe('the node a viewer reads through', () => {
  // Levi, 2026-09-17 (T27): a node's mode is chosen when it is created, and the gateway's default
  // is ultra-light. Ultra-light is bee's name for a light node with no chain behind it, which owns
  // no chequebook and so can never spend. What holds that now is the defaults rather than three
  // literals, and the purpose of the ruling of 2026-09-15 is held with them: a deployment that sets
  // neither key gets exactly the node this file has always started, and only the manager writing
  // both keys for a gateway an operator created on the chain makes it anything else.
  const block = blockOf(compose, 'bee-gateway');

  it('is a light node, stated rather than configured, because a full node is never what this is', () => {
    assert.match(block, /--full-node=false$/m);
    assert.doesNotMatch(block, /--full-node=\$\{/);
  });

  it('has swap off, and on only for a deployment that asked for it', () => {
    assert.match(block, /--swap-enable=\$\{BEE_GATEWAY_SWAP_ENABLE:-false\}$/m);
  });

  /**
   * The half that actually decides the mode, and the half a commit on
   * 2026-09-15 left out. bee reads pkg/node/node.go isChainEnabled:
   * `chainDisabled := swapEndpoint == ""` and `lightMode := !o.FullNodeMode`,
   * and only those two together give ultra-light. --swap-enable takes no part.
   * An endpoint left set here keeps the chain on whatever the other flags say,
   * so the node comes up plain `light`, replays the postage contract for about
   * three minutes on every empty data dir and answers 503 throughout. Which is
   * why the default is empty rather than an endpoint: a deployment that names
   * no endpoint cannot become light by accident.
   */
  it('reaches no chain by default, which is what keeps it ultra-light rather than light', () => {
    assert.match(block, /--blockchain-rpc-endpoint=\$\{BEE_GATEWAY_RPC_ENDPOINT:-\}$/m);
    assert.doesNotMatch(block, CHAIN_BY_DEFAULT);
    assert.doesNotMatch(block, /--blockchain-rpc-endpoint=https?:/);
  });

  // The endpoint an operator points it at is most often a process on this host rather than another
  // machine, and a container reaches one only through this name. The loop above no longer covers
  // the gateway, because the gateway is no longer on the chain by default.
  it('can resolve an endpoint running on the host, now that it can be given one', () => {
    assert.ok(block.includes(HOST_ALIAS), `the gateway takes ${RPC_FLAG} but cannot resolve ${HOST_ALIAS}`);
  });
});

/**
 * The same two defaults as compose resolves them, rather than as this file writes them.
 *
 * Everything above reads the file's text, which is where a `${NAME:-default}` can be right and
 * still render wrong. The arm that matters is the one nobody sets, because a viewer's node coming
 * up light is not visible as an error anywhere: it is a node that answers 503 for three minutes on
 * every empty data dir and then a feed that freezes.
 */
describe('the gateway command compose renders', () => {
  /** An endpoint of the shape an operator on a single host actually has. */
  const AN_ENDPOINT = 'http://host.docker.internal:8545';
  /**
   * Generous against a command that parses one file, and finite, for the reason `healthcheck.test.js`
   * gives at length: an unresponsive docker with no bound on it cost that suite 742 seconds on
   * 2026-08-03. See OPS-28.
   */
  const COMPOSE_CONFIG_TIMEOUT_MS = 30_000;

  function render(overrides) {
    // Both keys are dropped rather than left to the ambient environment. A shell that exports either
    // one would render the other arm and every assertion below would still pass.
    const env = { ...process.env };
    delete env.BEE_GATEWAY_RPC_ENDPOINT;
    delete env.BEE_GATEWAY_SWAP_ENABLE;

    return spawnSync('docker', ['compose', '--profile', 'bee-gateway', 'config'], {
      cwd: DEPLOY_DIR,
      encoding: 'utf-8',
      env: { ...env, ...overrides },
      timeout: COMPOSE_CONFIG_TIMEOUT_MS,
    });
  }

  /** The rendered gateway service, or null where this machine has no docker to ask. */
  function gatewayService(t, overrides) {
    const rendered = render(overrides);
    const outcome = classifySpawn(rendered);
    if (outcome.kind === SPAWN_ABSENT) {
      t.skip('docker is not available on this host');
      return null;
    }
    // Named separately from refusal because they call for opposite responses. A refused file is this
    // repository's defect, and a docker that never answered says nothing at all about it.
    assert.notEqual(
      outcome.kind,
      SPAWN_TIMED_OUT,
      `docker compose config did not answer in ${COMPOSE_CONFIG_TIMEOUT_MS}ms, so this says nothing ` +
        `about the compose file: ${outcome.detail}`,
    );
    assert.equal(outcome.kind, SPAWN_OK, `docker compose refused the file: ${outcome.detail}`);
    return blockOf(rendered.stdout, 'bee-gateway');
  }

  it('is the ultra-light node it always was when a deployment sets neither key', (t) => {
    const service = gatewayService(t, {});
    if (service === null) {
      return;
    }

    assert.match(service, /- --blockchain-rpc-endpoint=$/m);
    assert.match(service, /- --full-node=false$/m);
    assert.match(service, /- --swap-enable=false$/m);
  });

  it('is on the chain when the deployment carries both keys', (t) => {
    const service = gatewayService(t, { BEE_GATEWAY_RPC_ENDPOINT: AN_ENDPOINT, BEE_GATEWAY_SWAP_ENABLE: 'true' });
    if (service === null) {
      return;
    }

    assert.ok(
      service.includes(`--blockchain-rpc-endpoint=${AN_ENDPOINT}`),
      `the endpoint the deployment set did not reach the command: ${service}`,
    );
    assert.match(service, /- --swap-enable=true$/m);
    assert.match(service, /- --full-node=false$/m);
  });
});
