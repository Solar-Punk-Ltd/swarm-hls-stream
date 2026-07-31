import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ALLOWED_ADVISORIES } from '../src/allowlist.js';

const execFileAsync = promisify(execFile);

const GATE_ENTRY = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src', 'index.ts');

const workspaces: string[] = [];

after(() => {
  for (const workspace of workspaces) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

interface StubbedRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs the real entry point against a `pnpm` on PATH that prints what the test
 * wants. Driving the command rather than its parts is what keeps the exit code,
 * the non-zero-exit handling and the report parsing inside the same assertion,
 * and an exit code nothing asserts is how a broken gate ships green.
 */
async function runGateWithPath(path: string): Promise<StubbedRun> {
  try {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', GATE_ENTRY], {
      env: { ...process.env, PATH: path },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code ?? -1 };
  }
}

function workspace(): string {
  const created = mkdtempSync(join(tmpdir(), 'audit-gate-'));
  workspaces.push(created);
  return created;
}

async function runGateAgainstStub(stdout: string, exitCode: number): Promise<StubbedRun> {
  const dir = workspace();

  const reportPath = join(dir, 'report.json');
  writeFileSync(reportPath, stdout);

  const stubPath = join(dir, 'pnpm');
  writeFileSync(stubPath, `#!/bin/sh\ncat ${JSON.stringify(reportPath)}\nexit ${exitCode}\n`);
  chmodSync(stubPath, 0o755);

  return runGateWithPath(`${dir}:${process.env.PATH ?? ''}`);
}

function reportOf(advisories: readonly { ghsa: string; packageName: string }[]): string {
  const entries = advisories.map((advisory, index) => [
    String(1200000 + index),
    {
      id: 1200000 + index,
      module_name: advisory.packageName,
      severity: 'high',
      title: 'Stubbed advisory',
      vulnerable_versions: '<1.0.0',
      patched_versions: '>=1.0.0',
      github_advisory_id: advisory.ghsa,
      findings: [{ version: '0.9.0', paths: [`. > ${advisory.packageName}`] }],
    },
  ]);

  return JSON.stringify({ actions: [], advisories: Object.fromEntries(entries), muted: [], metadata: {} });
}

describe('the audit gate command', () => {
  it('exits 0 when the report holds exactly what the allowlist covers', async () => {
    const run = await runGateAgainstStub(reportOf(ALLOWED_ADVISORIES), 1);

    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /passed/);
  });

  it('exits 1 and names the advisory when something new turns up', async () => {
    const run = await runGateAgainstStub(
      reportOf([...ALLOWED_ADVISORIES, { ghsa: 'GHSA-zzzz-zzzz-zzzz', packageName: 'left-pad' }]),
      1,
    );

    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /GHSA-zzzz-zzzz-zzzz/);
    assert.match(run.stderr, /left-pad/);
  });

  it('exits 1 rather than passing when the audit itself could not run', async () => {
    const run = await runGateAgainstStub('', 1);

    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /could not run/);
  });

  it('exits 1 rather than passing when the audit exits 0 with output that is not a report', async () => {
    const run = await runGateAgainstStub('ERR_PNPM_NO_LOCKFILE  Cannot audit without a lockfile', 0);

    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /did not return JSON/);
  });

  it('blames the command rather than the report when pnpm cannot be run at all', async () => {
    const run = await runGateWithPath(workspace());

    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /could not run/);
    assert.doesNotMatch(run.stderr, /did not return JSON/);
  });
});
