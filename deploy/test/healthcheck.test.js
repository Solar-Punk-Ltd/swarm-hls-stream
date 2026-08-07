import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifySpawn, SPAWN_ABSENT, SPAWN_OK, SPAWN_TIMED_OUT } from './helpers/spawnOutcome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * Generous against a command that parses one file, and finite, which is the whole point. Sized so a
 * cold docker CLI on a loaded machine still answers, and so a docker that is not going to answer
 * costs this suite half a minute rather than twelve.
 */
const COMPOSE_CONFIG_TIMEOUT_MS = 30_000;
const COMPOSE_PATH = path.join(here, '..', 'docker-compose.yml');
const UPLOADER_DOCKERFILE = path.join(here, '..', 'Dockerfile.uploader');

/**
 * The healthcheck command as compose will run it, read out of the file rather than restated here.
 * A copy would let the two drift, and a probe that is wrong in the file and right in the test is the
 * shape this row exists to prevent.
 */
function readHealthcheckProbe() {
  const compose = fs.readFileSync(COMPOSE_PATH, 'utf-8');
  const service = compose.slice(compose.indexOf('\n  stream-uploader:'));
  const block = service.slice(service.indexOf('healthcheck:'));
  const probe = /"(fetch\(.*)",?\n/.exec(block);
  assert.ok(probe, 'the stream-uploader healthcheck has no node probe in it');
  return probe[1];
}

/** Runs the probe exactly as the container would, with API_PORT the only thing it is told. */
function runProbe(apiPort) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['-e', readHealthcheckProbe()],
      { env: { ...process.env, API_PORT: String(apiPort) } },
      (error) => resolve(error ? error.code ?? -1 : 0),
    );
  });
}

/** A server answering `/health` with the given status, on an ephemeral port. */
async function serveHealth(status) {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? status : 404, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe('stream-uploader healthcheck (OBS-17)', () => {
  it('is declared on the service at all', () => {
    const compose = fs.readFileSync(COMPOSE_PATH, 'utf-8');
    const service = compose.slice(compose.indexOf('\n  stream-uploader:'), compose.indexOf('\n  client:'));

    assert.ok(service.includes('healthcheck:'), 'nothing reads /health, so every 503 it raises is unrequested');
  });

  /**
   * The reason this is a test and not a review comment: the image is `node:22-alpine`, which ships
   * neither curl nor wget's https support, so the obvious probe would have failed only on a real
   * deployment and only as a container that never reports healthy.
   */
  it('uses a command the image actually has', () => {
    const dockerfile = fs.readFileSync(UPLOADER_DOCKERFILE, 'utf-8');
    const probe = readHealthcheckProbe();

    assert.ok(dockerfile.includes('FROM node:'), 'this test assumes a node base image');
    assert.ok(!/\b(curl|wget)\b/.test(probe), `the probe reaches for a binary alpine has no reason to carry: ${probe}`);
  });

  /**
   * The one that would have caught this shipping broken. The first version of this probe used a
   * template literal, and compose interpolates `$` in the file before the container ever sees the
   * command: `${process.env.API_PORT||3000}` is read as a variable named `process.env.API_PORT` and
   * `docker compose config` refuses the whole file. Every other test here passed, because they read
   * the probe out of the raw text and ran it under node, which is a path the deployment does not
   * have. A stack that will not start is not something a unit test of the probe can see.
   */
  it('survives compose interpolation, so the file is one compose will load', (t) => {
    const check = spawnSync('docker', ['compose', '--profile', 'stream-uploader', 'config'], {
      cwd: path.join(here, '..'),
      encoding: 'utf-8',
      env: { ...process.env, STAMP: 'x', STREAM_KEY: 'x', API_AUTH_TOKEN: 'x' },
      // `docker compose config` parses a file and does not talk to the daemon, verified by running
      // it with DOCKER_HOST pointed at a socket that does not exist. So there is no legitimate slow
      // path here, and without this bound one unresponsive docker holds the whole suite: on
      // 2026-08-03 it ran 742 seconds against a nominal 12.8. See OPS-28.
      timeout: COMPOSE_CONFIG_TIMEOUT_MS,
    });

    const outcome = classifySpawn(check);
    if (outcome.kind === SPAWN_ABSENT) {
      t.skip('docker is not available on this host');
      return;
    }
    // Named separately from refusal because they call for opposite responses. A refused file is this
    // repository's defect and the reader should go and read the compose file; a docker that never
    // answered says nothing at all about it.
    assert.notEqual(
      outcome.kind,
      SPAWN_TIMED_OUT,
      `docker compose config did not answer in ${COMPOSE_CONFIG_TIMEOUT_MS}ms, so this says nothing about ` +
        `the compose file: ${outcome.detail}`,
    );
    assert.equal(outcome.kind, SPAWN_OK, `docker compose refused the file: ${outcome.detail}`);
    assert.ok(
      check.stdout.includes(readHealthcheckProbe()),
      'compose rewrote the probe on its way through, so the container runs something else',
    );
  });

  /**
   * Asserted directly as well, because the check above skips wherever docker is absent, which
   * includes the machine most likely to be editing this file.
   */
  it('carries no dollar sign for compose to interpolate', () => {
    const probe = readHealthcheckProbe();

    assert.ok(!probe.includes('$'), `compose reads a $ here as one of its own variables: ${probe}`);
  });

  it('exits 0 against a healthy service', async () => {
    const server = await serveHealth(200);
    try {
      assert.equal(await runProbe(server.port), 0);
    } finally {
      await server.close();
    }
  });

  /**
   * The whole point of the row. A degraded service answers 503, and until something read it that was
   * a value in a body nobody requested.
   */
  it('exits non-zero against a degraded service, which is the 503 nothing was reading', async () => {
    const server = await serveHealth(503);
    try {
      assert.notEqual(await runProbe(server.port), 0);
    } finally {
      await server.close();
    }
  });

  it('exits non-zero when nothing is listening', async () => {
    const server = await serveHealth(200);
    const deadPort = server.port;
    await server.close();

    assert.notEqual(await runProbe(deadPort), 0);
  });

  /**
   * Reporting without acting is the intended design, so it is asserted rather than left to be
   * rediscovered. Compose does not restart a container for a failing healthcheck, and a
   * `service_healthy` dependency added later would turn this from a signal into a startup gate.
   */
  it('is not wired to anything that acts on it', () => {
    // Comments stripped first. The block above says the words `service_healthy` while explaining why
    // there is no such dependency, and matching prose would have this test fail on its own rationale.
    const compose = fs
      .readFileSync(COMPOSE_PATH, 'utf-8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    assert.ok(
      !compose.includes('service_healthy'),
      'a service_healthy dependency makes this healthcheck gate startup, which is not what it is for',
    );
  });
});
