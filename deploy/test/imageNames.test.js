import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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
    if (/^  [^ ]/.test(line)) break;
    const key = /^    ([a-z_]+):/.exec(line);
    if (key) keys.push(key[1]);
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
      assert.ok(!keys.includes('image'), `${service} names an image, so every deployment on the host shares that one tag`);
    });
  }
});
