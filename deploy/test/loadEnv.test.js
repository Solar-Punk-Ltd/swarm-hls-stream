import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes, runScriptOk, sourceLib } from './helpers/sandbox.js';

/** Where an injection would leave its evidence. Outside the sandbox, which is written before its own path is known. */
const markerDir = mkdtempSync(join(tmpdir(), 'deploy-env-injection-'));

after(() => {
  rmSync(markerDir, { recursive: true, force: true });
  removeSandboxes();
});

/**
 * Every shell construct that runs a command when a line is evaluated rather than parsed, paired with
 * the marker each one would leave behind. A `.env` holds secrets, and a secret is exactly the kind
 * of value that contains `$` by accident, so this is a correctness case before it is a security one.
 */
const INJECTIONS = [
  { key: 'SUBSHELL', marker: 'pwned-subshell', literal: (path) => `$(touch ${path})` },
  { key: 'BACKTICK', marker: 'pwned-backtick', literal: (path) => `\`touch ${path}\`` },
  { key: 'CHAINED', marker: 'pwned-chained', literal: (path) => `ok; touch ${path}` },
  { key: 'EXPANSION', marker: 'pwned-expansion', literal: (path) => `\${x[$(touch ${path})]}` },
];

const INJECTED_ENV = `${[
  'STAMP=stamp',
  'STREAM_KEY=key',
  ...INJECTIONS.map(({ key, marker, literal }) => `${key}=${literal(join(markerDir, marker))}`),
].join('\n')}\n`;

function assertNothingRan(where) {
  for (const { key, marker } of INJECTIONS) {
    assert.ok(!existsSync(join(markerDir, marker)), `a ${key} value in .env executed ${where}, creating ${marker}`);
  }
}

describe('load_env does not evaluate .env values (OPS-6)', () => {
  // The audit recorded `_lib.sh:441` as evaluating raw lines. It never did: that line is
  // `compose_project_flag`, and `load_env_file` has carried an explicit non-evaluating parser since
  // before the audit ran. What the row was missing was a test, so this is the test.
  it('runs no command in any value it loads', async () => {
    const sandbox = makeSandbox({ envFiles: { '.env': INJECTED_ENV } });

    const run = await sourceLib(sandbox, 'load_env');

    assert.equal(run.exitCode, 0, `load_env failed: ${run.stdout}${run.stderr}`);
    assertNothingRan('while load_env parsed it');
  });

  // The other half, and the one a blunt fix breaks. A parser that dropped every value containing a
  // metacharacter would pass the assertion above while silently deploying with no STREAM_KEY, so the
  // value has to arrive intact as well as inert.
  it('loads the value literally rather than dropping it', async () => {
    const sandbox = makeSandbox({ envFiles: { '.env': INJECTED_ENV } });

    const run = await sourceLib(sandbox, 'load_env\nprintf "%s\\n" "$SUBSHELL" "$CHAINED" "$STREAM_KEY"');

    assert.equal(run.exitCode, 0, `load_env failed: ${run.stdout}${run.stderr}`);
    assert.deepEqual(run.stdout.trim().split('\n'), [
      `$(touch ${join(markerDir, 'pwned-subshell')})`,
      `ok; touch ${join(markerDir, 'pwned-chained')}`,
      'key',
    ]);
  });

  // The function-level proof above cannot see a second evaluation further down the chain. A real
  // script loads the root env, then the engine envs, then resolves ports and prints a topology, and
  // any one of those re-expanding a value would run the command the parser refused to.
  it('runs no command when a whole script loads that .env', async () => {
    const sandbox = makeSandbox({ envFiles: { '.env': INJECTED_ENV } });

    await runScriptOk(sandbox, 'stop.sh', []);

    assertNothingRan('somewhere inside stop.sh');
  });
});
