import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findUnusedExports, readBaseline } from '../scripts/unused-exports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = resolve(HERE, '..', 'scripts', 'unused-exports.mjs');

/**
 * The gate this covers is a ratchet, so the failure that matters is the one where it approves a tree
 * that got worse. Proving it passes is the easy half and proves nothing on its own: a gate that
 * always returned zero would pass that test too. So the refusal is driven against a fixture tree
 * with its own baseline, and the exit code is read rather than the message.
 */
function fixture(files, baselineCount) {
  const dir = mkdtempSync(join(tmpdir(), 'unused-exports-'));
  const src = join(dir, 'src');
  mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(src, name), body);
  const baselinePath = join(dir, 'baseline.json');
  writeFileSync(baselinePath, JSON.stringify({ count: baselineCount }));
  return {
    dir,
    env: { ...process.env, UNUSED_EXPORTS_ROOTS: src, UNUSED_EXPORTS_BASELINE: baselinePath },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runGate(env) {
  try {
    return { code: 0, out: execFileSync('node', [GATE], { env, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

describe('the unused-export gate', () => {
  it('reports an export nothing else references, and not one that is imported', () => {
    const f = fixture(
      {
        'a.ts': 'export const lonely = 1;\nexport const shared = 2;\n',
        'b.ts': "import { shared } from './a.js';\nconsole.log(shared);\n",
      },
      99,
    );
    try {
      const names = findUnusedExports([join(f.dir, 'src')]).map((u) => u.name);
      assert.deepEqual(names, ['lonely'], 'exactly the unimported export, and nothing else');
    } finally {
      f.cleanup();
    }
  });

  it('REFUSES with exit 1 when the count rises above its baseline', () => {
    const f = fixture({ 'a.ts': 'export const one = 1;\nexport const two = 2;\n' }, 1);
    try {
      const { code, out } = runGate(f.env);
      assert.equal(code, 1, 'a tree worse than its baseline must not be approved');
      assert.match(out, /REFUSING/);
    } finally {
      f.cleanup();
    }
  });

  it('passes at exit 0 when the tree is level with its baseline', () => {
    const f = fixture({ 'a.ts': 'export const one = 1;\n' }, 1);
    try {
      assert.equal(runGate(f.env).code, 0);
    } finally {
      f.cleanup();
    }
  });

  it('passes but asks for the baseline to be lowered when the tree improves', () => {
    const f = fixture({ 'a.ts': 'export const one = 1;\n' }, 5);
    try {
      const { code, out } = runGate(f.env);
      assert.equal(code, 0, 'an improvement is not a failure');
      assert.match(out, /--write/, 'ground gained has to be held or it is given back');
    } finally {
      f.cleanup();
    }
  });

  it('refuses to judge at all when no baseline is recorded', () => {
    const f = fixture({ 'a.ts': 'export const one = 1;\n' }, 1);
    try {
      const env = { ...f.env, UNUSED_EXPORTS_BASELINE: join(f.dir, 'absent.json') };
      assert.equal(runGate(env).code, 2, 'a missing baseline is a refusal, never a silent pass');
    } finally {
      f.cleanup();
    }
  });

  it('counts the same twice on one tree, so the ratchet cannot fire at random', () => {
    assert.equal(findUnusedExports().length, findUnusedExports().length);
  });

  it('holds this repo at or below its committed baseline', () => {
    const baseline = readBaseline();
    assert.ok(baseline && Number.isInteger(baseline.count), 'the baseline is what makes it a ratchet');
    const actual = findUnusedExports().length;
    // At-or-below rather than equal: removing an export is the outcome this gate wants, and a test
    // asserting equality would fail the one change it is supposed to encourage.
    assert.ok(
      actual <= baseline.count,
      `${actual} unreferenced exports against a baseline of ${baseline.count}: run unused-exports.mjs --list`,
    );
  });
});
