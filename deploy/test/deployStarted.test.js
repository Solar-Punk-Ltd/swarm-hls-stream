import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

/**
 * The watch, driven fast enough that the suite does not wait it out.
 *
 * The real defaults give a service with no healthcheck five seconds to fall over and one with a
 * healthcheck thirty, which is the whole mechanism: the uploader's two startup gates read every bee
 * node and every batch in turn before the API ever listens, and compose returned success long
 * before. Here a look costs a twentieth of a second and the window is half a second, so a test can
 * state what happens on the third look and still finish in the time the old fixed sleep took.
 *
 * The stub answers from a fixed inventory rather than from a daemon, so nothing is being hurried.
 */
const FAST_WATCH = {
  DEPLOY_SETTLE_SECONDS: '0',
  DEPLOY_WATCH_INTERVAL_SECONDS: '0.05',
  DEPLOY_READY_TIMEOUT_SECONDS: '0.5',
};

function deploy(services, env = {}) {
  const sandbox = makeSandbox();
  return { sandbox, run: runScript(sandbox, 'deploy.sh', services, { ...FAST_WATCH, ...env }) };
}

/**
 * How many times the watch looked at one service's container, which is what tells a watch that ended
 * early from one that ran its window out. The id is the inventory's `c-<service>`.
 */
function looks(sandbox, service) {
  return sandbox.calls().filter((call) => call.startsWith('inspect ') && call.endsWith(` c-${service}`)).length;
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
      sandbox.calls().some((call) => call.startsWith('inspect ') && call.includes('RestartCount')),
      `nothing asked docker how the service was doing: ${sandbox.calls().join(' | ')}`,
    );
    assert.ok(looks(sandbox, 'stream-uploader') >= 1, 'something was looked at, but not the service that was named');
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

/**
 * That the deploy watches for as long as its services can take to refuse, rather than looking once.
 *
 * ⛔⛔⛔ A five second look cannot see either of the two gates it was written for. The uploader runs
 * `ChequebookGate.assertFunded` and then `PostageGate.assertUsable` before the API listens, one HTTP
 * read per bee node and per batch, each bounded by START_GATE_TIMEOUT_MS at 20000ms, and only then
 * does `StreamCatalog.init` look a feed up on a node that may be cold. On the four-node ABR pool a
 * pool that answers nothing holds the boot there for minutes. At five seconds the container is
 * `running` with its node process inside an HTTP call, and the deploy prints its success line. Under
 * UPLOADER_START_GATES=refuse, which is what those gates need to stop a start at all since
 * 2026-09-17, the container then exits 1 and loops unwatched.
 *
 * The second half is the same blindness in one instant rather than over time: a crash loop spends
 * most of its life `running`, because `restarting` is the brief moment between attempts. So a look
 * that asks what state a container is in NOW reports a looping container as up, whatever the timing.
 * The restart count is the evidence that does not depend on catching the right moment.
 */
describe('a deploy watches until its services have earned their green', () => {
  it('refuses a container that is running at first and falls over inside the window', async () => {
    const reason = 'ChequebookGate: bee-uploader has 0.0 BZZ in its chequebook, below the 0.5 floor';
    const { run } = deploy(['stream-uploader'], {
      // Running and unrestarted for the first two looks, restarted once from the third. The shape of
      // every startup gate in this repository: the container is up while it is deciding.
      DOCKER_STUB_RESTARTS: 'stream-uploader:1:2',
      DOCKER_STUB_HEALTH: 'stream-uploader:starting',
      DOCKER_STUB_LOG_LINE: reason,
    });
    const finished = await run;
    const output = `${finished.stdout}${finished.stderr}`;

    assert.notEqual(finished.exitCode, 0, 'a deploy whose container fell over inside the window reported success');
    assert.match(output, /stream-uploader/);
    // Docker never reported it as `restarting` here, which is the point: the refusal came from the
    // restart count rather than from catching the container between attempts.
    assert.match(output, /restart/i, `the refusal does not say what was wrong: ${output}`);
    assert.match(output, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the reason was not carried');
  });

  it('stops looking as soon as a healthcheck reports healthy', async () => {
    const { sandbox, run } = deploy(['stream-uploader'], {
      // `starting` for two looks, `healthy` from the third, which is a container whose gates cleared.
      DOCKER_STUB_HEALTH: 'stream-uploader:healthy:2',
    });
    const finished = await run;

    assert.equal(finished.exitCode, 0, `${finished.stdout}${finished.stderr}`);
    // The window holds eleven looks. Ending on the one that answered is what keeps the watch off the
    // critical path of a deploy that is fine, which is the whole cost this check adds.
    assert.equal(
      looks(sandbox, 'stream-uploader'),
      3,
      'the watch did not stop at the look that answered, so every good deploy pays the whole window',
    );
  });

  it('accepts a service that never reports healthy, and says so', async () => {
    const { sandbox, run } = deploy(['stream-uploader'], { DOCKER_STUB_HEALTH: 'stream-uploader:starting' });
    const finished = await run;

    assert.equal(finished.exitCode, 0, `a running container that had not restarted was refused: ${finished.stderr}`);
    assert.match(finished.stderr, /never reported healthy/, `nothing said the window ran out: ${finished.stderr}`);
    assert.match(finished.stderr, /starting/, 'the note does not say what the healthcheck actually said');
    assert.ok(looks(sandbox, 'stream-uploader') > 1, 'the window was never waited out');
  });

  /**
   * ⛔ `unhealthy` is not "did not start". The uploader answers /health with a 503 while it is
   * degraded, and one dropped segment on a recovered stream is enough to do it, so refusing a deploy
   * on `unhealthy` would refuse on media that was already lost before the deploy began.
   */
  it('does not refuse a container whose healthcheck is failing, only one that fell over', async () => {
    const { run } = deploy(['stream-uploader'], { DOCKER_STUB_HEALTH: 'stream-uploader:unhealthy' });
    const finished = await run;

    assert.equal(finished.exitCode, 0, `a degraded but running service was refused: ${finished.stderr}`);
    assert.match(finished.stderr, /unhealthy/, 'the deploy passed without saying the service is unhealthy');
  });

  /**
   * ⛔ A restart count is a lifetime total and not this deploy's.
   *
   * Measured on docker 29.8.0: a container that exited once and recovered reads `1 running` and is
   * perfectly well, and `docker compose up -d` on a service whose image and config have not moved
   * leaves that same container in place, count and all. So refusing on any non-zero count refuses a
   * re-deploy of a healthy stack for a crash it recovered from days ago, complete with DEPLOY
   * REFUSED and a line saying nothing was rolled back.
   */
  it('accepts a container that carries an older restart and holds steady', async () => {
    const { sandbox, run } = deploy(['stream-uploader'], {
      // Restarted once before this deploy ever looked, and not again while it watched. `starting`
      // keeps the watch running, which is what makes "did not rise" a claim about the whole window
      // rather than about one look.
      DOCKER_STUB_RESTARTS: 'stream-uploader:1',
      DOCKER_STUB_HEALTH: 'stream-uploader:starting',
    });
    const finished = await run;

    assert.equal(finished.exitCode, 0, `a stack that had already recovered was refused: ${finished.stderr}`);
    assert.doesNotMatch(finished.stderr, /DEPLOY REFUSED/);
    assert.ok(looks(sandbox, 'stream-uploader') > 1, 'the window was never waited out, so nothing was watched');
  });

  it('refuses a container whose older restart count rises again inside the window', async () => {
    const reason = 'PostageGate: batch 0xabc has 0.4h of TTL left, below the 1h floor';
    const { run } = deploy(['stream-uploader'], {
      // The same older restart as above for two looks, and then another one. This is the half that
      // the baseline must not swallow: a count that was already 1 still has to refuse when it moves.
      DOCKER_STUB_RESTARTS: 'stream-uploader:2:2:1',
      DOCKER_STUB_HEALTH: 'stream-uploader:starting',
      DOCKER_STUB_LOG_LINE: reason,
    });
    const finished = await run;
    const output = `${finished.stdout}${finished.stderr}`;

    assert.notEqual(finished.exitCode, 0, 'a container that fell over again during the deploy was accepted');
    assert.match(output, /1 to 2/, `the refusal does not say the count moved, only what it is: ${output}`);
    assert.match(output, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the reason was not carried');
  });

  it('waits no longer than the settle for a service that declares no healthcheck', async () => {
    const { sandbox, run } = deploy(['bee-uploader']);
    const finished = await run;

    assert.equal(finished.exitCode, 0, `${finished.stdout}${finished.stderr}`);
    // The old behaviour, kept: a service with no startup gates in front of it has nothing further to
    // report, so there is nothing to wait for once it has held for the settle.
    assert.equal(
      looks(sandbox, 'bee-uploader'),
      1,
      'a service with no healthcheck was watched past its settle, which every deploy would now pay',
    );
  });
});
