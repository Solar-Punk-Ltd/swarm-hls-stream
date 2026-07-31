import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  /** Wall clock for the run. The hang case is only a real check if it asserts the gate gave up early. */
  elapsedMs: number;
}

/**
 * Runs the real entry point against a `pnpm` on PATH that prints what the test
 * wants. Driving the command rather than its parts is what keeps the exit code,
 * the non-zero-exit handling and the report parsing inside the same assertion,
 * and an exit code nothing asserts is how a broken gate ships green.
 */
async function runGateWithPath(path: string, env: NodeJS.ProcessEnv = {}): Promise<StubbedRun> {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', GATE_ENTRY], {
      env: { ...process.env, ...env, PATH: path },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      exitCode: failure.code ?? -1,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

function workspace(): string {
  const created = mkdtempSync(join(tmpdir(), 'audit-gate-'));
  workspaces.push(created);
  return created;
}

interface StubbedGate extends StubbedRun {
  /** What the gate actually asked `pnpm` to do. Without recording this the stub answers any command at all. */
  argv: string;
}

interface StubOptions {
  /** Replaces the canned answer entirely, for stubs that hang or misbehave. */
  body?: string;
  /** Only the hang case sets this. Left unset elsewhere so a slow machine cannot make an ordinary run flaky. */
  timeoutMs?: number;
}

async function runGateAgainstStub(stdout: string, exitCode: number, options: StubOptions = {}): Promise<StubbedGate> {
  const dir = workspace();

  const reportPath = join(dir, 'report.json');
  writeFileSync(reportPath, stdout);
  const argvPath = join(dir, 'argv');

  const stubPath = join(dir, 'pnpm');
  const answer = options.body ?? `cat ${JSON.stringify(reportPath)}\nexit ${exitCode}\n`;
  writeFileSync(stubPath, `#!/bin/sh\nprintf '%s' "$*" > ${JSON.stringify(argvPath)}\n${answer}`);
  chmodSync(stubPath, 0o755);

  const env = options.timeoutMs ? { AUDIT_GATE_TIMEOUT_MS: String(options.timeoutMs) } : {};
  const run = await runGateWithPath(`${dir}:${process.env.PATH ?? ''}`, env);
  return { ...run, argv: existsSync(argvPath) ? readFileSync(argvPath, 'utf8') : '' };
}

interface StubbedAdvisory {
  ghsa: string;
  packageName: string;
  reviewedSeverity?: string;
  reviewedPatchedVersions?: string;
}

/**
 * Echoes back whatever an allowlist entry says it was reviewed against, so the
 * happy-path case stays in step with the shipped list instead of pinning a
 * severity and a patched range the list does not actually claim.
 */
function reportOf(advisories: readonly StubbedAdvisory[]): string {
  const entries = advisories.map((advisory, index) => [
    String(1200000 + index),
    {
      id: 1200000 + index,
      module_name: advisory.packageName,
      severity: advisory.reviewedSeverity ?? 'high',
      title: 'Stubbed advisory',
      vulnerable_versions: '<1.0.0',
      patched_versions: advisory.reviewedPatchedVersions ?? '>=1.0.0',
      github_advisory_id: advisory.ghsa,
      findings: [{ version: '0.9.0', paths: [`. > ${advisory.packageName}`] }],
    },
  ]);

  return JSON.stringify({
    actions: [],
    advisories: Object.fromEntries(entries),
    muted: [],
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: advisories.length, critical: 0 } },
  });
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

  it('asks pnpm for the audit as JSON, and nothing else', async () => {
    const run = await runGateAgainstStub(reportOf(ALLOWED_ADVISORIES), 1);

    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(run.argv, 'audit --json');
  });

  it('exits 1 rather than hanging when the registry accepts the connection and never answers', async () => {
    const run = await runGateAgainstStub('', 0, { body: 'sleep 60\n', timeoutMs: 3000 });

    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /could not run/);
    // The outcome alone does not pin this. With no timeout the stub simply
    // finishes its sleep and the gate reaches the same verdict a minute later,
    // so giving up early is the behaviour and the elapsed time is the assertion.
    assert.ok(run.elapsedMs < 20_000, `gave up after ${run.elapsedMs}ms, so the timeout did not fire`);
  });

  it('blames the command rather than the report when pnpm cannot be run at all', async () => {
    const run = await runGateWithPath(workspace());

    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /could not run/);
    assert.doesNotMatch(run.stderr, /did not return JSON/);
  });
});
