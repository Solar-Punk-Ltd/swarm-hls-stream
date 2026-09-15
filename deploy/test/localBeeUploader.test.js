import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, runScript, runScriptOk } from './helpers/sandbox.js';

after(removeSandboxes);

/** A Bee node the deployment does not run, which is the only kind an external BEE_URL can name. */
const EXTERNAL_BEE = 'http://bee.example.test:10055';

/** What `resolve_bee_url` computes for a bee-uploader sharing the uploader's host and bridge network. */
const LOCAL_BEE = 'http://bee-uploader:1633';

/**
 * Every service local, which is what the deployment manager writes into `config.json` once per
 * checkout at bootstrap. It names `bee-uploader` whatever the profile deployed on top of it is made
 * of, and that is the whole reason this key exists.
 */
const CONFIG_WITH_BEE = {
  services: {
    srs: 'localhost',
    ome: 'localhost',
    'stream-uploader': 'localhost',
    'bee-uploader': 'localhost',
    'bee-gateway': 'localhost',
    client: 'localhost',
  },
};

/** The same checkout with the node switched off in `config.json`, which is the only thing
 * `is_enabled` has ever been able to see. */
const CONFIG_WITHOUT_BEE = {
  services: { ...CONFIG_WITH_BEE.services, 'bee-uploader': false },
};

function envText(lines) {
  return `${['STAMP=stamp', 'STREAM_KEY=key', `BEE_URL=${EXTERNAL_BEE}`, 'BEE_UPLOADER_API_PORT=1633', ...lines].join(
    '\n',
  )}\n`;
}

/**
 * The BEE_URL the uploader container is actually handed.
 *
 * Compose is given `.env.<profile>` and then the computed override file, in that order, and on a
 * duplicate key the later `--env-file` wins. The docker stub records each file it was pointed at in
 * the order it was passed, so the last BEE_URL line is the value interpolation uses. Reading the
 * last line rather than looking for an override is the difference between stating what the container
 * receives and stating that some file mentioned the key, and the bug this guards against was
 * precisely a correct `.env` value losing to a computed one.
 */
function beeUrlLines(sandbox) {
  return sandbox
    .envFiles()
    .split('\n')
    .filter((line) => line.startsWith('BEE_URL='));
}

function effectiveBeeUrl(sandbox) {
  const lines = beeUrlLines(sandbox);
  return lines.length === 0 ? undefined : lines[lines.length - 1].slice('BEE_URL='.length);
}

async function deployUploader(config, lines) {
  const sandbox = makeSandbox({ config, envFiles: { '.env': envText(lines) } });
  await runScriptOk(sandbox, 'deploy.sh', ['stream-uploader']);
  return sandbox;
}

/**
 * Who decides whether the uploader publishes through a Bee node of its own.
 *
 * `resolve_bee_url` used to ask `config.json`, which answers a different question: it says what the
 * checkout is configured for, and the deployment manager writes it once at bootstrap listing
 * `bee-uploader` as `localhost`. So every profile carrying a stream-uploader had its BEE_URL replaced
 * by `http://bee-uploader:<port>` in the override file, which compose takes as a second `--env-file`
 * and therefore ranks above `.env.<profile>`. A deployment naming an external node was pointed at a
 * compose service that is not running, died on `getaddrinfo ENOTFOUND bee-uploader` and restarted for
 * ever, while the manager reported it up because `deploy.sh` had already exited 0.
 *
 * Only the writer of `.env.<profile>` knows the profile's full service list, so it states it. The
 * service filter cannot stand in for that: the manager holds an uploader back until a batch is bought
 * and then deploys it on its own, for a profile that does own a node and does need the local address.
 */
describe('LOCAL_BEE_UPLOADER deciding whether the uploader gets a local Bee address', () => {
  it('leaves an external BEE_URL alone when the profile says it runs no Bee node', async () => {
    const sandbox = await deployUploader(CONFIG_WITH_BEE, ['LOCAL_BEE_UPLOADER=false']);

    assert.equal(effectiveBeeUrl(sandbox), EXTERNAL_BEE);
    assert.equal(beeUrlLines(sandbox).length, 1, 'a BEE_URL override was written for a profile that owns no node');
  });

  it('computes the local address when the profile says it runs one', async () => {
    const sandbox = await deployUploader(CONFIG_WITH_BEE, ['LOCAL_BEE_UPLOADER=true']);

    assert.equal(effectiveBeeUrl(sandbox), LOCAL_BEE);
  });

  /**
   * ⛔ The decoy. Every case in this file states its intent in the sandbox's own env file, and
   * `load_env_file` treats that file as DEFAULTS: a key the caller already exported wins over it. The
   * sandbox used to hand each script the whole of the suite's environment, so an operator, a login
   * shell or a `.envrc` exporting this key decided the run and the file did not. On a deployment host
   * it is exported, which is where these tests are most likely to be run and least likely to be read.
   *
   * The ambient value here is the opposite of the file's, so a leak cannot look like a pass.
   */
  it('lets the sandbox env file decide even when the machine exports the opposite', async () => {
    const ambient = process.env.LOCAL_BEE_UPLOADER;
    process.env.LOCAL_BEE_UPLOADER = 'true';
    try {
      const sandbox = await deployUploader(CONFIG_WITH_BEE, ['LOCAL_BEE_UPLOADER=false']);

      assert.equal(effectiveBeeUrl(sandbox), EXTERNAL_BEE);
    } finally {
      if (ambient === undefined) {
        delete process.env.LOCAL_BEE_UPLOADER;
      } else {
        process.env.LOCAL_BEE_UPLOADER = ambient;
      }
    }
  });

  /**
   * A bare `deploy.sh` and an older manager write no such key, and neither may change behaviour.
   * Both halves of the old rule are stated, because "absent decides as before" is a claim about
   * `is_enabled` in both directions rather than only about the branch this fix was written for.
   */
  it('falls back to config.json when the key is absent and the node is enabled there', async () => {
    const sandbox = await deployUploader(CONFIG_WITH_BEE, []);

    assert.equal(effectiveBeeUrl(sandbox), LOCAL_BEE);
  });

  it('falls back to config.json when the key is absent and the node is disabled there', async () => {
    const sandbox = await deployUploader(CONFIG_WITHOUT_BEE, []);

    assert.equal(effectiveBeeUrl(sandbox), EXTERNAL_BEE);
    assert.equal(beeUrlLines(sandbox).length, 1, 'a BEE_URL override was written for a disabled node');
  });

  /**
   * ⛔ A typo must not read as "decide as before", because that is indistinguishable from the key
   * working and is the exact deploy this fix exists to stop: `LOCAL_BEE_UPLOADER=flase` on a profile
   * with an external node would silently get the compose service again.
   *
   * The refusal is asserted by what did NOT happen as well as by what was printed. A message beside a
   * deploy that still ran is not a refusal, and this repository has paid for that shape more than
   * once.
   */
  it('refuses a value that is neither true nor false, and deploys nothing', async () => {
    const sandbox = makeSandbox({
      config: CONFIG_WITH_BEE,
      envFiles: { '.env': envText(['LOCAL_BEE_UPLOADER=flase']) },
    });

    const run = await runScript(sandbox, 'deploy.sh', ['stream-uploader']);
    const said = `${run.stdout}${run.stderr}`;

    assert.notEqual(run.exitCode, 0, said);
    assert.match(said, /LOCAL_BEE_UPLOADER/);
    assert.match(said, /true/);
    assert.match(said, /false/);
    assert.match(said, /flase/);
    assert.deepEqual(
      sandbox.calls().filter((call) => call.startsWith('compose')),
      [],
      'a rejected value still reached compose',
    );
  });
});
