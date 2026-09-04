import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * That every single-suite e2e script can actually be run the way an operator runs it.
 *
 * ⛔⛔ `bench-on-host.sh` runs `pnpm ${SCRIPT}` from the repo ROOT, not from `e2e`. Its `case` on the
 * script name only decides whether the preflight prelude is prepended for a `browser:*` driver, and
 * an `e2e:*` script is passed through untouched. So a suite script the e2e package declares and the
 * root cannot reach fails on the host with an empty stdout and a non-zero exit that says nothing
 * about what is wrong, and under `pnpm --silent` it prints nothing at all.
 *
 * ⛔⛔⛔ This is the same defect `browserScriptPassthrough.test.js` exists for, in the other script
 * family, and that file records what it cost twice: `browser:arm-order` with no root entry on
 * 2026-08-13, then `browser:quality` and `browser:rung-outage` on 2026-08-30, both after the
 * broadcast had already started. The `e2e:*` family had no such check at all.
 *
 * ⭐ Stated as a property of the two manifests rather than as a sweep of call sites, so a NEW way of
 * launching one cannot defeat it. Every `test:e2e:*` the e2e package declares must be reachable from
 * the root, because the root is where every sitting is launched from.
 */

function manifests() {
  return {
    root: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts,
    e2e: JSON.parse(readFileSync(join(ROOT, 'e2e/package.json'), 'utf8')).scripts,
  };
}

/** `test:e2e:vod` is reached from the root as `e2e:vod`, which is the whole naming convention. */
function rootNameFor(suiteScript) {
  return `e2e:${suiteScript.slice('test:e2e:'.length)}`;
}

function declaredSuiteScripts(e2e) {
  return Object.keys(e2e).filter((name) => name.startsWith('test:e2e:'));
}

describe('an operator can run every single-suite e2e script from the repo root', () => {
  it('finds the scripts at all, so an empty sweep cannot pass by accident', () => {
    const { e2e } = manifests();
    const declared = declaredSuiteScripts(e2e);

    assert.ok(declared.length >= 7, `only found ${declared.length} test:e2e:* scripts in e2e/package.json`);
    assert.ok(declared.includes('test:e2e:broadcast-ended'), 'V5 has no single-suite script');
  });

  it('has a root passthrough for each, since bench-on-host runs pnpm from /repo', () => {
    const { root, e2e } = manifests();

    const missing = declaredSuiteScripts(e2e).filter((name) => !(rootNameFor(name) in root));
    assert.deepEqual(
      missing,
      [],
      `e2e declares ${missing.join(', ')} and the root cannot run ${missing.length === 1 ? 'it' : 'them'}. ` +
        'A sitting is launched as `pnpm <script>` from /repo, so a missing passthrough exits non-zero with ' +
        'no output about the cause.',
    );
  });

  it('points each passthrough at the e2e script of the same name', () => {
    const { root, e2e } = manifests();

    for (const name of declaredSuiteScripts(e2e)) {
      const passthrough = root[rootNameFor(name)] ?? '';

      assert.match(passthrough, /--filter @swarm-hls-stream\/e2e/, `${rootNameFor(name)} does not delegate to e2e`);
      assert.match(
        passthrough,
        new RegExp(`\\b${name}$`),
        `${rootNameFor(name)} delegates to something other than ${name}, so the root and the package disagree ` +
          'about which suite it runs',
      );
    }
  });

  /**
   * ⛔ Every one of these buys a broadcast, and the gates are what decide whether the stage it is
   * about to measure is worth measuring. A single-suite script that skipped them would run the one
   * suite an operator is debugging against an unchecked stage, which is the reading this repo has
   * already paid for twice.
   */
  it('runs each one behind the ten preflight gates', () => {
    const { e2e } = manifests();

    for (const name of declaredSuiteScripts(e2e)) {
      if (name === 'test:e2e:preflight' || name === 'test:e2e:smoke') {
        continue;
      }
      assert.match(
        e2e[name],
        /suites\/preflight\/\*\.test\.ts' &&/,
        `${name} does not run the preflight gates before the suite it buys a broadcast for`,
      );
    }
  });
});

/**
 * That a drain script's declaration actually reaches the suite it launches.
 *
 * ⛔⛔⛔ **A variable written in front of a command applies to that command alone.** The drain
 * scripts are two commands joined by `&&`, the preflight and then the suite, so
 * `E2E_DRAIN_ARMED=1 tsx <preflight> && tsx <suite>` declares the arming to the gates and to nothing
 * else. The suites then read no declaration, `drainNotDeclared` skips them both, and a sitting that
 * armed a batch the owner paid for and bought a broadcast reports zero tests as a green run. Written
 * and shipped that way on 2026-09-05 and caught by review rather than by a run.
 *
 * ⭐ The rule is proven here by running `sh` rather than asserted from memory of it, because the
 * whole defect was a wrong belief about the shell, and a structural check written by the same belief
 * would have agreed with the bug.
 */
describe('a drain script declares the arming to the suite and not only to the gates', () => {
  const DECLARATION = 'E2E_DRAIN_ARMED';

  function drainScripts() {
    const { e2e } = manifests();
    const found = Object.entries(e2e).filter(([name]) => name.startsWith('test:e2e:batch-drain'));
    assert.ok(found.length >= 2, 'the drain scripts themselves are missing');
    return found;
  }

  it('is the shell rule this shape rests on, proven by running it', () => {
    const read = `node -e "process.stdout.write(String(process.env.${DECLARATION}))"`;

    const prefixed = execFileSync('sh', ['-c', `${DECLARATION}=1 true && ${read}`], { encoding: 'utf8' });
    const exported = execFileSync('sh', ['-c', `export ${DECLARATION}=1 && true && ${read}`], { encoding: 'utf8' });

    assert.equal(prefixed, 'undefined', 'a prefix reaching the second command would make this whole gate pointless');
    assert.equal(exported, '1');
  });

  it('exports before the chain, so every command in it is a drain run', () => {
    for (const [name, script] of drainScripts()) {
      assert.match(
        script,
        new RegExp(`^export ${DECLARATION}=1 &&`),
        `${name} has to export the declaration before its first command, or the suite half runs without it`,
      );
    }
  });

  it('leaves no other script declaring an arming, so nothing else can reach the drain suites', () => {
    const { e2e, root } = manifests();
    const others = [...Object.entries(e2e), ...Object.entries(root)].filter(
      ([name, script]) => !name.includes('batch-drain') && script.includes(DECLARATION),
    );

    assert.deepEqual(others, [], 'a script that arms without being a drain sitting would run the suites on any stage');
  });
});
