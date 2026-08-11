import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createPlanServer, PLAN_ROUTE, SCRIPT_ROUTE_PREFIX, SWEEP_ROUTE } from '../scripts/serve-sweep-plan.mjs';

const sandboxes = [];

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'serve-plan-'));
  sandboxes.push(dir);
  return dir;
}

after(() => sandboxes.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Starts on an ephemeral port so a stale server from a real sitting cannot make the suite pass or fail. */
async function serving(paths, visit) {
  const server = createPlanServer(paths);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await visit(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function fixture() {
  const dir = sandbox();
  const planPath = join(dir, 'plan.json');
  const sweepPath = join(dir, 'sweep.js');
  writeFileSync(planPath, JSON.stringify({ refs: ['aa', 'bb'], canaries: ['cc'], arms: [16], rounds: 1, block: 2 }));
  writeFileSync(sweepPath, '"first version"');
  return { planPath, sweepPath };
}

describe('the sweep plan server', () => {
  it('serves the plan as JSON the page can parse', async () => {
    const paths = fixture();
    const plan = await serving(paths, async (origin) => (await fetch(origin + PLAN_ROUTE)).json());
    assert.deepEqual(plan.refs, ['aa', 'bb']);
    assert.deepEqual(plan.arms, [16]);
  });

  it('allows the browser page to read it cross-origin, which is the whole point', async () => {
    const paths = fixture();
    const header = await serving(paths, async (origin) =>
      (await fetch(origin + PLAN_ROUTE)).headers.get('access-control-allow-origin'),
    );
    assert.equal(header, '*');
  });

  it('serves the harness as javascript so the page can eval what it fetched', async () => {
    const paths = fixture();
    const response = await serving(paths, async (origin) => {
      const got = await fetch(origin + SWEEP_ROUTE);
      return { type: got.headers.get('content-type'), body: await got.text() };
    });
    assert.match(response.type, /javascript/);
    assert.equal(response.body, '"first version"');
  });

  // The point of serving the harness rather than pasting it is that the browser runs the committed
  // file. A cached copy would reintroduce exactly the drift this removes.
  it('re-reads the harness per request, so an edit lands without a restart', async () => {
    const paths = fixture();
    const bodies = await serving(paths, async (origin) => {
      const before = await (await fetch(origin + SWEEP_ROUTE)).text();
      writeFileSync(paths.sweepPath, '"second version"');
      return [before, await (await fetch(origin + SWEEP_ROUTE)).text()];
    });
    assert.deepEqual(bodies, ['"first version"', '"second version"']);
  });

  it('refuses an unknown route rather than serving some other file', async () => {
    const paths = fixture();
    const status = await serving(paths, async (origin) => (await fetch(origin + '/etc/passwd')).status);
    assert.equal(status, 404);
  });

  // Without the header on the failure path the page sees an opaque network error and the operator
  // debugs their fetch instead of their URL.
  it('sets the CORS header on a refusal too', async () => {
    const paths = fixture();
    const header = await serving(paths, async (origin) =>
      (await fetch(origin + '/nope')).headers.get('access-control-allow-origin'),
    );
    assert.equal(header, '*');
  });

  it('reports a missing plan file as a server error rather than crashing the sitting', async () => {
    const paths = { planPath: join(sandbox(), 'absent.json'), sweepPath: fixture().sweepPath };
    const status = await serving(paths, async (origin) => (await fetch(origin + PLAN_ROUTE)).status);
    assert.equal(status, 500);
  });
});

/**
 * The other in-browser harnesses are pasted into a console by hand, which is how a sitting ends up
 * running something other than what is in git. `in-browser-sustain.js` is 230 lines and has to be
 * pasted by a human at a focused tab, so it is the one that most needs this.
 */
describe('serving any harness in the scripts directory', () => {
  function scriptDir() {
    const dir = sandbox();
    writeFileSync(join(dir, 'in-browser-sustain.js'), '"the sustain harness"');
    return { ...fixture(), scriptDir: dir };
  }

  it('serves a harness by name so a human pastes two lines instead of the whole file', async () => {
    const body = await serving(scriptDir(), async (origin) =>
      (await fetch(`${origin}${SCRIPT_ROUTE_PREFIX}in-browser-sustain.js`)).text(),
    );
    assert.equal(body, '"the sustain harness"');
  });

  it('refuses a name that is not in the scripts directory', async () => {
    const status = await serving(
      scriptDir(),
      async (origin) => (await fetch(`${origin}${SCRIPT_ROUTE_PREFIX}not-a-harness.js`)).status,
    );
    assert.equal(status, 404);
  });

  // The route takes a name from the request, so it is the one place traversal is even possible.
  // Checked with an encoded separator too, since the raw one is normalised away before it arrives.
  it('cannot be walked out of the scripts directory', async () => {
    const statuses = await serving(scriptDir(), async (origin) =>
      Promise.all(
        ['../../package.json', '..%2f..%2fpackage.json', '%2e%2e%2fplan.json', 'sub/dir.js'].map(
          async (attempt) => (await fetch(`${origin}${SCRIPT_ROUTE_PREFIX}${attempt}`)).status,
        ),
      ),
    );
    assert.deepEqual(statuses, [404, 404, 404, 404]);
  });

  it('refuses anything that is not a .js harness', async () => {
    const status = await serving(
      scriptDir(),
      async (origin) => (await fetch(`${origin}${SCRIPT_ROUTE_PREFIX}plan.json`)).status,
    );
    assert.equal(status, 404);
  });
});
