import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

/**
 * The started-services watch, driven fast enough that the cases which are meant to PASS do not spend
 * its real window waiting on a stub. Same values and same reason as `deployStarted.test.js`.
 */
const FAST_WATCH = {
  DEPLOY_SETTLE_SECONDS: '0',
  DEPLOY_WATCH_INTERVAL_SECONDS: '0.05',
  DEPLOY_READY_TIMEOUT_SECONDS: '0.5',
};

/** A sandbox whose `.env` carries the two gateway keys under test, on top of what every deploy needs. */
const withEnv = (lines) => makeSandbox({ envFiles: { '.env': `STAMP=stamp\nSTREAM_KEY=key\n${lines}\n` } });

/** Whether the deploy reached compose, which is the point a refusal has to come before. */
const ranCompose = (sandbox) => sandbox.calls().some((call) => call.startsWith('compose '));

/**
 * That a gateway asked to run a chequebook is also given a chain to run it on.
 *
 * Bee decides its mode on the endpoint: `--full-node=false` plus an empty `--blockchain-rpc-endpoint`
 * is ultra-light, which is what this project ships a viewer against and what the gateway block
 * defaults to. `--swap-enable=true` is a separate decision, and it deploys a chequebook, which is an
 * on-chain contract. Asking for one with no chain to deploy it on is not a node that runs badly, it
 * is a node that does not start, so the pair leaves a crash-looping container behind a deploy that
 * has otherwise done everything right.
 *
 * The compose file states the rule in a comment beside the two flags. A sentence in a comment refuses
 * nothing, and the operator who sets one variable without the other is reading their own `.env` rather
 * than the compose file, so the refusal belongs where the two values first meet.
 *
 * Scoped the way `check_stamp` scopes itself to the uploader, because a deploy that names other
 * services never brings the gateway up and must not be refused for its settings.
 */
describe('the gateway swap guard', () => {
  it('refuses swap with no chain endpoint, before anything is deployed', async () => {
    const sandbox = withEnv('BEE_GATEWAY_SWAP_ENABLE=true\nBEE_GATEWAY_RPC_ENDPOINT=');

    const run = await runScript(sandbox, 'deploy.sh', ['bee-gateway'], FAST_WATCH);

    assert.notEqual(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.match(`${run.stdout}${run.stderr}`, /BEE_GATEWAY_RPC_ENDPOINT/);
    assert.equal(ranCompose(sandbox), false, `the gateway was deployed anyway: ${sandbox.calls().join(' | ')}`);
  });

  it('refuses the same pair when the variable is absent rather than empty', async () => {
    const sandbox = withEnv('BEE_GATEWAY_SWAP_ENABLE=true');

    const run = await runScript(sandbox, 'deploy.sh', ['bee-gateway'], FAST_WATCH);

    assert.notEqual(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.equal(ranCompose(sandbox), false, `the gateway was deployed anyway: ${sandbox.calls().join(' | ')}`);
  });

  it('deploys a gateway whose swap has a chain to run on', async () => {
    const sandbox = withEnv('BEE_GATEWAY_SWAP_ENABLE=true\nBEE_GATEWAY_RPC_ENDPOINT=https://rpc.example.test');

    const run = await runScript(sandbox, 'deploy.sh', ['bee-gateway'], FAST_WATCH);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.equal(ranCompose(sandbox), true, 'nothing was deployed, so this says nothing about the guard');
  });

  it('deploys the ultra-light gateway the project ships, which is swap off and no endpoint at all', async () => {
    const sandbox = withEnv('BEE_GATEWAY_SWAP_ENABLE=false\nBEE_GATEWAY_RPC_ENDPOINT=');

    const run = await runScript(sandbox, 'deploy.sh', ['bee-gateway'], FAST_WATCH);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.equal(ranCompose(sandbox), true, 'nothing was deployed, so this says nothing about the guard');
  });

  it('says nothing about a deploy that does not bring the gateway up', async () => {
    const sandbox = withEnv('BEE_GATEWAY_SWAP_ENABLE=true\nBEE_GATEWAY_RPC_ENDPOINT=');

    const run = await runScript(sandbox, 'deploy.sh', ['client'], FAST_WATCH);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
  });
});
