import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifySpawn, SPAWN_ABSENT, SPAWN_OK, SPAWN_TIMED_OUT } from './helpers/spawnOutcome.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOY_DIR = resolve(HERE, '..');
const ROOT = resolve(DEPLOY_DIR, '..');
const COMPOSE = join(DEPLOY_DIR, 'docker-compose.yml');
const ENV_SAMPLE = join(ROOT, '.env.sample');

/** Same bound and same reasoning as `healthcheck.test.js`: compose parses a file, so it answers or it is broken. */
const COMPOSE_CONFIG_TIMEOUT_MS = 30_000;

/**
 * That the gateway starts in bee's `ultra-light` mode, which is the node this project ships a viewer
 * against and every figure it has published was measured on.
 *
 * ⛔ **`--swap-enable=false` does not make a node ultra-light and never did.** The flag does not
 * enter bee's mode decision at all. The rule, in bee's own words on startup, is the endpoint:
 *
 *     chain backend disabled - starting in ultra-light mode  full_node_mode=false blockchain-rpc-endpoint=""
 *     chain backend enabled - blockchain functionality available  full_node_mode=false blockchain-rpc-endpoint="https://rpc.gnosischain.com"
 *
 * Ultra-light is `--full-node=false` **and an empty `--blockchain-rpc-endpoint`**. The gateway block
 * carried `${RPC_ENDPOINT:-https://rpc.gnosischain.com}`, so it always had an endpoint and was always
 * a light node, and the comment beside `--swap-enable` asserted the opposite.
 *
 * Measured on viewer slot 7, 2026-09-11, bee 2.8.2 on a fresh volume: `/status` reported
 * `beeMode: "light"` and spent **195 seconds** replaying the postage-batch contract to block
 * ~47.7M, answering `503 Node is syncing` on `/status` and `/chequebook/*` throughout, so the
 * client proxying that gateway had no gateway for those three minutes, on every deploy that starts
 * with an empty data directory. It bought nothing for it: `/chequebook/balance` still answered
 * `405 chain disabled` and the wallet held 0 BZZ, so the node could no more pay a peer than an
 * ultra-light one. The slot 6 node beside it, deployed from a compose predating the flag, reported
 * `beeMode: "ultra-light"` and `lastSyncedBlock: 0`.
 *
 * ⚠️ The shared `RPC_ENDPOINT` is not the place to fix it. The uploader and the three rung nodes buy
 * stamps and run chequebooks, so they genuinely need a chain; and `${VAR:-default}` substitutes its
 * default for an empty value as well as an unset one, so clearing that variable changes nothing
 * anywhere. The gateway needs its own name, defaulting to empty.
 */
describe('the gateway is ultra-light', () => {
  const compose = readFileSync(COMPOSE, 'utf8');

  /** The `command:` block of one service, so a flag is read from the service that actually carries it. */
  function commandBlock(service) {
    const from = compose.indexOf(`\n  ${service}:`);
    assert.notEqual(from, -1, `docker-compose.yml has no ${service} service`);
    const rest = compose.slice(from + 1);
    const next = rest.search(/\n {2}[a-z0-9-]+:\n/);
    return next === -1 ? rest : rest.slice(0, next);
  }

  /**
   * Asserted against the text as well as against compose below, because the check that renders the
   * file skips wherever docker is absent, which includes the machine most likely to be editing it.
   */
  it('does not hand the gateway the endpoint the paying nodes share', () => {
    const flag = /--blockchain-rpc-endpoint=(.*)/.exec(commandBlock('bee-gateway'));

    assert.ok(flag, 'the gateway passes no --blockchain-rpc-endpoint at all, so this test reads nothing');
    assert.ok(
      !flag[1].includes('RPC_ENDPOINT:-') && !flag[1].includes('${RPC_ENDPOINT}'),
      `the gateway reads the chain endpoint the uploader and rungs need: ${flag[1]}`,
    );
  });

  /**
   * `:-` is the whole defect in one character. It substitutes its default for an empty value as well
   * as an unset one, so with `:-` there is no value an operator can set that yields an empty endpoint
   * and ultra-light becomes unreachable from an env file. `-` leaves an explicit empty alone.
   */
  it('lets an explicitly empty endpoint stay empty', () => {
    const flag = /--blockchain-rpc-endpoint=\$\{([A-Z0-9_]+)(:?-)/.exec(commandBlock('bee-gateway'));

    assert.ok(flag, 'the gateway endpoint is not a variable with a default, so an operator cannot set it');
    assert.equal(flag[2], '-', `\${${flag[1]}:-...} ignores an empty value, so ultra-light cannot be asked for`);
  });

  it('names the gateway endpoint in .env.sample, so it is a knob an operator can find', () => {
    const flag = /--blockchain-rpc-endpoint=\$\{([A-Z0-9_]+)[:-]/.exec(commandBlock('bee-gateway'));

    assert.ok(flag, 'the gateway endpoint is not a variable at all');
    assert.match(
      readFileSync(ENV_SAMPLE, 'utf8'),
      new RegExp(`^${flag[1]}=`, 'm'),
      `${flag[1]} reaches the gateway but appears nowhere in .env.sample`,
    );
  });

  /**
   * The half of this a fix can quietly break. An uploader or a rung without a chain cannot buy a
   * stamp or write a cheque, and the symptom is a broadcast that fails at the postage gate rather
   * than anything that names an endpoint.
   */
  it('still hands every paying node a chain endpoint', () => {
    for (const service of ['bee-uploader', 'bee-uploader-480p', 'bee-uploader-720p', 'bee-uploader-1080p']) {
      const flag = /--blockchain-rpc-endpoint=(.*)/.exec(commandBlock(service));

      assert.ok(flag, `${service} passes no --blockchain-rpc-endpoint, so it has no chain to pay on`);
      assert.match(flag[1], /RPC_ENDPOINT:-https?:\/\//, `${service} lost its chain endpoint: ${flag[1]}`);
    }
  });
});

/**
 * The same claims through compose itself, because the ones above read a file and this deployment
 * runs a substitution. `${VAR-}` versus `${VAR:-}` is exactly the kind of rule a regex can assert
 * and get wrong, and the defect this file exists for shipped as a rendered value nobody rendered.
 */
describe('the gateway is ultra-light once compose has resolved it', () => {
  /** Renders the file the way a deploy with nothing set would, which is the case that shipped broken. */
  function render() {
    const inherited = { ...process.env };
    for (const name of ['RPC_ENDPOINT', 'BEE_GATEWAY_RPC_ENDPOINT']) {
      delete inherited[name];
    }
    return spawnSync('docker', ['compose', '--profile', 'bee-gateway', 'config'], {
      cwd: DEPLOY_DIR,
      encoding: 'utf-8',
      env: { ...inherited, STAMP: 'x', STREAM_KEY: 'x', API_AUTH_TOKEN: 'x' },
      timeout: COMPOSE_CONFIG_TIMEOUT_MS,
    });
  }

  /** @returns {string[] | null} the rendered command, or null when docker cannot answer. */
  function gatewayCommand(t) {
    const rendered = render();
    const outcome = classifySpawn(rendered);
    if (outcome.kind === SPAWN_ABSENT) {
      t.skip('docker is not available on this host');
      return null;
    }
    // Kept apart for the reason healthcheck.test.js keeps them apart: a refused file is this
    // repository's defect, a docker that never answered says nothing about the file either way.
    assert.notEqual(
      outcome.kind,
      SPAWN_TIMED_OUT,
      `docker compose config did not answer in ${COMPOSE_CONFIG_TIMEOUT_MS}ms, so this says nothing about ` +
        `the compose file: ${outcome.detail}`,
    );
    assert.equal(outcome.kind, SPAWN_OK, `docker compose refused the file: ${outcome.detail}`);

    const block = rendered.stdout.slice(rendered.stdout.indexOf('\n  bee-gateway:'));
    return [...block.matchAll(/^ {6}- (--.*)$/gm)].map((line) => line[1]);
  }

  it('renders an empty endpoint when nothing is set, which is what starts it ultra-light', (t) => {
    const command = gatewayCommand(t);
    if (!command) {
      return;
    }

    assert.ok(command.length > 0, 'nothing was read out of the rendered gateway command');
    assert.ok(
      command.includes('--blockchain-rpc-endpoint='),
      `the gateway renders with a chain backend: ${command.find((f) => f.startsWith('--blockchain-rpc-endpoint'))}`,
    );
    // The other half of the mode decision, which was never the broken one and is asserted so a fix
    // to the endpoint cannot be paid for by losing it.
    assert.ok(command.includes('--full-node=false'), 'the gateway renders as a full node');
  });

  /**
   * A gateway on a chain is a thing someone may genuinely want, and `gateway-funding-arms.sh`
   * measures one, so the variable has to work, not merely be ignorable. A refusal that also refused every
   * real value would pass every test above.
   */
  it('still lets a profile ask for a chain-enabled gateway', (t) => {
    const probe = gatewayCommand(t);
    if (!probe) {
      return;
    }

    const rendered = spawnSync('docker', ['compose', '--profile', 'bee-gateway', 'config'], {
      cwd: DEPLOY_DIR,
      encoding: 'utf-8',
      env: {
        ...process.env,
        STAMP: 'x',
        STREAM_KEY: 'x',
        API_AUTH_TOKEN: 'x',
        BEE_GATEWAY_RPC_ENDPOINT: 'https://rpc.example.test',
      },
      timeout: COMPOSE_CONFIG_TIMEOUT_MS,
    });

    assert.equal(classifySpawn(rendered).kind, SPAWN_OK, 'docker compose refused the file with the variable set');
    const block = rendered.stdout.slice(rendered.stdout.indexOf('\n  bee-gateway:'));
    assert.match(
      block,
      /--blockchain-rpc-endpoint=https:\/\/rpc\.example\.test/,
      'the variable an operator sets does not reach the gateway',
    );
  });
});
