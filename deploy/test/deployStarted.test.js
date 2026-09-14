import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

/**
 * The settle window, set to nothing so the suite does not wait it out.
 *
 * The real default gives a container a few seconds to fall over before the deploy calls it started,
 * which is the whole mechanism: an uploader that throws at config import exits within about a second
 * and compose has already returned success by then. Zero is safe here because the stub answers from
 * a fixed inventory rather than from a daemon that needs time to settle.
 */
const NO_SETTLE = { DEPLOY_SETTLE_SECONDS: '0' };

function deploy(services, env = {}) {
  const sandbox = makeSandbox();
  return { sandbox, run: runScript(sandbox, 'deploy.sh', services, { ...NO_SETTLE, ...env }) };
}

/**
 * That a deploy which did not bring its services up says so instead of reporting success.
 *
 * ⛔⛔⛔ `docker compose up -d` returns as soon as a container has been created and started, and a
 * container whose process throws on its first line has been started. With `restart: unless-stopped`
 * it then loops, and `deploy.sh` printed "Local deploy complete" over the top of it. Every startup
 * refusal this repository has on purpose lands in that gap: the five `required()` reads, the
 * chequebook floor, and `PostageGate`. The compose healthcheck cannot close it either, because it
 * deliberately reports without acting and nothing declares a dependency on it.
 *
 * Found by a cross-provider review on 2026-09-14, prompted by the commit that made
 * STAMP_MIN_TTL_HOURS and STAMP_MAX_UTILIZATION reach the container: two settings that were inert
 * became able to refuse a start, which is right, and there was nothing to notice the refusal.
 */
describe('a deploy reports whether the services it started are up', () => {
  it('succeeds when the service is running, having actually asked', async () => {
    const { sandbox, run } = deploy(['stream-uploader']);
    const finished = await run;

    assert.equal(finished.exitCode, 0, `${finished.stdout}${finished.stderr}`);
    // The success path has to be the answer to a question, not the absence of one. Without this a
    // check that never ran passes this case exactly as well as a check that ran and was satisfied.
    assert.ok(
      sandbox.calls().some((call) => call.includes('status=running') && call.includes('service=stream-uploader')),
      `nothing asked docker whether the service was running: ${sandbox.calls().join(' | ')}`,
    );
  });

  it('refuses when the service is not running, and names it', async () => {
    const { run } = deploy(['stream-uploader'], { DOCKER_STUB_DOWN: 'stream-uploader' });
    const finished = await run;

    assert.notEqual(finished.exitCode, 0, 'a deploy whose service never came up reported success');
    assert.match(`${finished.stdout}${finished.stderr}`, /stream-uploader/);
  });

  it("carries the container's own output, which is where the reason is", async () => {
    const reason = 'Env var STAMP_MAX_UTILIZATION must be at most 1, got 90';
    const { run } = deploy(['stream-uploader'], {
      DOCKER_STUB_DOWN: 'stream-uploader',
      DOCKER_STUB_LOG_LINE: reason,
    });
    const finished = await run;

    // The refusal is worth little without this. An operator who is told the uploader is down still
    // has to go and ask why, and the answer was already printed inside the container.
    assert.match(`${finished.stdout}${finished.stderr}`, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('names every service that did not come up, not only the first', async () => {
    const { run } = deploy(['stream-uploader', 'bee-uploader'], {
      DOCKER_STUB_DOWN: 'stream-uploader,bee-uploader',
    });
    const finished = await run;

    const output = `${finished.stdout}${finished.stderr}`;
    assert.notEqual(finished.exitCode, 0);
    assert.match(output, /stream-uploader/);
    assert.match(output, /bee-uploader/, 'stopped at the first service that was down');
  });
});
