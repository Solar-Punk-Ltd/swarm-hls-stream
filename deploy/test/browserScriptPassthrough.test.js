import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = join(ROOT, 'deploy/scripts');

/**
 * That every browser script a driver invokes actually exists where the driver invokes it.
 *
 * ⛔⛔ The drivers run the harness by mounting the repo at `/repo` and calling `pnpm browser:<name>`
 * from the ROOT, not from `e2e`. The root package.json therefore needs a passthrough for each one,
 * and a missing passthrough fails with an empty stdout and exit 1 that says nothing about what is
 * wrong. Under `pnpm --silent` it prints nothing at all.
 *
 * ⛔⛔⛔ AND NO STUBBED TEST CAN CATCH IT. `deploy/test/gatewayFundingArms.test.js` stubs docker and
 * matches on the script NAME appearing in the argv, so it is satisfied by a name that resolves to
 * nothing. On 2026-08-13 twenty-three stubbed cases passed while `browser:arm-order` had no root
 * entry, and the first real invocation on the host printed nothing and exited 1. This file is the
 * cheap check that closes the gap between the stub and the host.
 */

/** `pnpm ... browser:<name>`, however many pnpm flags sit between. */
const INVOCATION = /\bpnpm\b[^\n|;]*?\b(browser:[a-z0-9-]+)/g;

function driverInvocations() {
  const found = new Map();
  for (const name of readdirSync(SCRIPTS).filter((file) => file.endsWith('.sh'))) {
    const body = readFileSync(join(SCRIPTS, name), 'utf8');
    for (const [, script] of body.matchAll(INVOCATION)) {
      found.set(script, [...(found.get(script) ?? []), name]);
    }
  }
  return found;
}

describe('a driver can run every browser script it names', () => {
  it('finds the invocations at all, so an empty sweep cannot pass by accident', () => {
    const invocations = driverInvocations();

    assert.ok(invocations.size >= 3, `only found ${invocations.size} browser scripts across the drivers`);
    assert.ok(invocations.has('browser:watch'));
  });

  it('has a root passthrough for each, since the drivers run from the repo root', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

    for (const [script, drivers] of driverInvocations()) {
      assert.ok(
        script in root.scripts,
        `${drivers.join(' and ')} run "pnpm ${script}" from /repo, and the root package.json has no such script`,
      );
    }
  });

  it('points each passthrough at a script the e2e package really has', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const e2e = JSON.parse(readFileSync(join(ROOT, 'e2e/package.json'), 'utf8'));

    for (const [script] of driverInvocations()) {
      const passthrough = root.scripts[script] ?? '';
      assert.match(passthrough, /--filter @swarm-hls-stream\/e2e/, `${script} does not delegate to e2e`);
      assert.ok(script in e2e.scripts, `the root delegates ${script} to e2e, which has no such script`);
    }
  });

  /**
   * ⛔⛔⛔ The direction the two cases above cannot cover, and it cost a paid run on 2026-08-30.
   *
   * They scan `deploy/scripts/*.sh` for invocations, so they only ever see a script some SHELL
   * driver names. `runBrowserArm` in `e2e/src/harness/browser.ts` launches a driver too, out of
   * TypeScript, and `browser:quality` and `browser:rung-outage` were added to `e2e/package.json`
   * with no root passthrough. Every unit test passed, the suites went out to the host, and both
   * arms died with exit 254 in six seconds.
   *
   * ⭐ Stated as a property of the two manifests rather than as a sweep of call sites, so it cannot
   * be defeated by a NEW way of invoking one. Every browser script the e2e package has must be
   * runnable from the root, because the root is where every driver is launched from.
   */
  it('has a root passthrough for every browser script the e2e package declares', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const e2e = JSON.parse(readFileSync(join(ROOT, 'e2e/package.json'), 'utf8'));

    const declared = Object.keys(e2e.scripts).filter((name) => name.startsWith('browser:'));
    assert.ok(declared.length >= 5, `only found ${declared.length} browser scripts in e2e/package.json`);

    const missing = declared.filter((name) => !(name in root.scripts));
    assert.deepEqual(
      missing,
      [],
      `e2e declares ${missing.join(', ')} and the root cannot run ${missing.length === 1 ? 'it' : 'them'}. ` +
        'Every driver is launched as `pnpm <script>` from /repo, so a missing passthrough exits 254 with ' +
        'no output on the host after the broadcast has already started.',
    );
  });
});
