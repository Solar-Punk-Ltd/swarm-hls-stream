import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { makeSandbox, removeSandboxes } from './helpers/sandbox.js';

const execFileAsync = promisify(execFile);

const DEPLOY_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The services this repo builds an image for, as opposed to pulling one. */
const BUILT_SERVICES = ['stream-uploader', 'client'];

/** The top-level keys of one service block in the compose file, read by indentation. */
function serviceKeys(compose, service) {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  assert.notEqual(start, -1, `service ${service} is not in the compose file`);
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[^ ]/.test(line)) {
      break;
    }
    const key = /^ {4}([a-z_]+):/.exec(line);
    if (key) {
      keys.push(key[1]);
    }
  }
  return keys;
}

describe('the images this repo builds are named after the deployment', () => {
  // Two deployments of this stack on one host build the same Dockerfiles. An `image:` name on a
  // built service makes both deployments write one tag, so the second build retags what the first
  // deployment's containers were created from, and a recreate on either side can pick up the other's
  // bytes. Without the name Compose calls the image `<project>-<service>`, and each deployment is
  // one project, so the tags never meet. The manager that runs several deployments reads exactly
  // this: a version whose built services still carry an `image:` name is one it has to serialise.
  const compose = readFileSync(join(DEPLOY_DIR, 'docker-compose.yml'), 'utf8');

  for (const service of BUILT_SERVICES) {
    it(`builds ${service} without an image name, so its tag belongs to one project`, () => {
      const keys = serviceKeys(compose, service);
      assert.ok(keys.includes('build'), `${service} is expected to be built from a Dockerfile`);
      assert.ok(
        !keys.includes('image'),
        `${service} names an image, so every deployment on the host shares that one tag`,
      );
    });
  }
});

after(removeSandboxes);

/** Runs the real `clean.sh` against the sandbox's stubbed docker, the way clean.test.js does. */
async function runClean(sandbox, args) {
  await execFileAsync('bash', [sandbox.scriptPath('clean.sh'), '--yes', ...args], {
    env: { ...process.env, PATH: `${sandbox.binDir}:${process.env.PATH ?? ''}` },
  });
  return sandbox.calls().filter((call) => call.startsWith('compose '));
}

describe('clean.sh removes the images a whole-project clean built', () => {
  // With the images named after the project, a removed deployment would leave
  // `<project>-stream-uploader` and `<project>-client` behind on the host, one pair per deployment
  // that ever existed there. `--rmi local` removes exactly the images Compose built for the project
  // and nothing pulled by name, so bee, SRS and OME stay shared and the deployment's own tags go.
  it('asks compose down to remove the images it built for the project', async () => {
    const calls = await runClean(makeSandbox(), []);

    const down = calls.find((call) => call.includes(' down'));
    assert.ok(down, `no compose down was issued: ${calls.join(' | ')}`);
    assert.match(down, /--rmi local/, 'the images built for this project were left behind');
  });

  it('removes them when the volumes go as well', async () => {
    const calls = await runClean(makeSandbox(), ['--volumes']);

    const down = calls.find((call) => call.includes(' down'));
    assert.ok(down, `no compose down was issued: ${calls.join(' | ')}`);
    assert.match(down, /--rmi local/);
    assert.match(down, /(^|\s)-v(\s|$)/, 'the volumes the operator asked to remove stayed');
  });

  it('touches no image when one service is named, because that path never reaches down', async () => {
    const calls = await runClean(makeSandbox(), ['srs']);

    assert.ok(calls.length > 0, 'no compose call at all was issued');
    for (const call of calls) {
      assert.doesNotMatch(call, /--rmi/, `a service clean removed images: ${call}`);
    }
  });
});
