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

  // A `.env` key that happens to name one of the library's own variables must not become that
  // variable. `load_env_file` skips a key that is already set, and an EMPTY ARRAY reads as unset to
  // `${!key+x}`, so a plain `FILTER_SERVICES=client` line used to claim the array's first element.
  // `stop.sh` with no arguments then stopped only `client`, or with a name matching nothing, stopped
  // nothing at all and still printed "All services stopped". In `clean.sh`, which loads the env
  // before it parses argv, that element reached the unquoted remote heredoc.
  it('does not let a .env key claim one of the library own array variables', async () => {
    const sandbox = makeSandbox({
      envFiles: { '.env': 'STAMP=stamp\nSTREAM_KEY=key\nFILTER_SERVICES=client\nREST_ARGS=client\n' },
    });

    const run = await sourceLib(sandbox, 'load_env\necho "filter=${#FILTER_SERVICES[@]} rest=${#REST_ARGS[@]}"');

    assert.equal(run.exitCode, 0, `load_env failed: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /filter=0 rest=0/, 'a .env line wrote into an array the library owns');
  });

  // The same defect at the level that shows the harm. Asserting the array stays empty is necessary
  // and not sufficient: what matters is that the command the operator gets is the one they asked for.
  it('stops the whole stack when a .env names the service filter', async () => {
    const sandbox = makeSandbox({
      envFiles: { '.env': 'STAMP=stamp\nSTREAM_KEY=key\nFILTER_SERVICES=client\n' },
    });

    await runScriptOk(sandbox, 'stop.sh', []);

    const down = sandbox.calls().find((call) => / down(\s|$)/.test(call));
    assert.ok(down, `a .env line suppressed the teardown entirely; calls: ${sandbox.calls().join(' | ')}`);
    for (const service of ['bee-uploader', 'bee-gateway', 'stream-uploader', 'srs', 'ome', 'client']) {
      assert.match(down, new RegExp(`--profile ${service}(\\s|$)`), `${service} was dropped by a .env line`);
    }
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
