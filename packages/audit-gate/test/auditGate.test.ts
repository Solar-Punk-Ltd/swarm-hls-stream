import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ALLOWED_ADVISORIES } from '../src/allowlist.js';
import { evaluateAudit } from '../src/evaluateAudit.js';
import { parseAuditReport } from '../src/parseAuditReport.js';
import { AllowedAdvisory } from '../src/types.js';

interface RawAdvisoryOverrides {
  github_advisory_id?: string;
  module_name?: string;
  severity?: string;
  title?: string;
  patched_versions?: string;
}

/**
 * Builds the shape pnpm actually emits, keyed by its own numeric id rather than
 * by the GHSA, so a test cannot pass on a shape the real command never produces.
 */
function rawReport(...advisories: RawAdvisoryOverrides[]): string {
  const entries = advisories.map((overrides, index) => {
    const advisory: Record<string, unknown> = {
      id: 1100000 + index,
      module_name: 'left-pad',
      severity: 'high',
      title: 'Something is wrong with left-pad',
      vulnerable_versions: '<1.3.0',
      patched_versions: '>=1.3.0',
      github_advisory_id: `GHSA-test-000${index}`,
      findings: [{ version: '1.2.0', paths: ['. > left-pad'] }],
      ...overrides,
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete advisory[key];
      }
    }
    return [String(advisory.id), advisory] as const;
  });

  return JSON.stringify({
    actions: [],
    advisories: Object.fromEntries(entries),
    muted: [],
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: advisories.length, critical: 0 } },
  });
}

function allow(ghsa: string, packageName: string): AllowedAdvisory {
  return { ghsa, packageName, reason: 'Pinned by a test.' };
}

describe('audit gate verdicts', () => {
  it('passes when every reported advisory is on the allowlist', () => {
    const raw = rawReport(
      { github_advisory_id: 'GHSA-aaaa-aaaa-aaaa', module_name: 'elliptic' },
      { github_advisory_id: 'GHSA-bbbb-bbbb-bbbb', module_name: 'react-router' },
    );

    const failures = evaluateAudit(parseAuditReport(raw), [
      allow('GHSA-aaaa-aaaa-aaaa', 'elliptic'),
      allow('GHSA-bbbb-bbbb-bbbb', 'react-router'),
    ]);

    assert.deepEqual(failures, []);
  });

  it('passes on a clean report against an empty allowlist', () => {
    assert.deepEqual(evaluateAudit(parseAuditReport(rawReport()), []), []);
  });

  it('fails on an advisory nobody has reviewed', () => {
    const raw = rawReport({
      github_advisory_id: 'GHSA-newn-ewne-wnew',
      module_name: 'axios',
      severity: 'critical',
      patched_versions: '>=0.33.0',
    });

    const failures = evaluateAudit(parseAuditReport(raw), []);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'unreviewed');
    assert.equal(failures[0].ghsa, 'GHSA-newn-ewne-wnew');
    assert.equal(failures[0].packageName, 'axios');
    assert.match(failures[0].detail, /critical/);
    assert.match(failures[0].detail, />=0\.33\.0/);
  });

  it('reports every unreviewed advisory, not only the first', () => {
    const raw = rawReport(
      { github_advisory_id: 'GHSA-0001-0001-0001', module_name: 'axios' },
      { github_advisory_id: 'GHSA-0002-0002-0002', module_name: 'vite' },
      { github_advisory_id: 'GHSA-0003-0003-0003', module_name: 'ws' },
    );

    const failures = evaluateAudit(parseAuditReport(raw), []);

    assert.deepEqual(failures.map((failure) => failure.ghsa).sort(), [
      'GHSA-0001-0001-0001',
      'GHSA-0002-0002-0002',
      'GHSA-0003-0003-0003',
    ]);
  });

  it('fails on an allowlist entry that no longer matches anything', () => {
    const raw = rawReport({ github_advisory_id: 'GHSA-aaaa-aaaa-aaaa', module_name: 'elliptic' });

    const failures = evaluateAudit(parseAuditReport(raw), [
      allow('GHSA-aaaa-aaaa-aaaa', 'elliptic'),
      allow('GHSA-gone-gone-gone', 'react-router'),
    ]);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'stale-exception');
    assert.equal(failures[0].ghsa, 'GHSA-gone-gone-gone');
  });

  it('fails when an allowlisted advisory turns up against a different package', () => {
    const raw = rawReport({ github_advisory_id: 'GHSA-aaaa-aaaa-aaaa', module_name: 'react-router' });

    const failures = evaluateAudit(parseAuditReport(raw), [allow('GHSA-aaaa-aaaa-aaaa', 'elliptic')]);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'package-mismatch');
    assert.match(failures[0].detail, /elliptic/);
    assert.match(failures[0].detail, /react-router/);
  });

  it('fails on a second allowlist entry for the same advisory rather than dropping one', () => {
    const raw = rawReport({ github_advisory_id: 'GHSA-aaaa-aaaa-aaaa', module_name: 'elliptic' });

    const failures = evaluateAudit(parseAuditReport(raw), [
      allow('GHSA-aaaa-aaaa-aaaa', 'elliptic'),
      allow('GHSA-aaaa-aaaa-aaaa', 'something-else'),
    ]);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, 'duplicate-exception');
    assert.equal(failures[0].ghsa, 'GHSA-aaaa-aaaa-aaaa');
  });
});

describe('audit report parsing', () => {
  it('reads the fields the verdict is built from', () => {
    const raw = rawReport({
      github_advisory_id: 'GHSA-aaaa-aaaa-aaaa',
      module_name: 'elliptic',
      severity: 'low',
      title: 'Risky cryptographic primitive',
      patched_versions: '<0.0.0',
    });

    assert.deepEqual(parseAuditReport(raw), [
      {
        ghsa: 'GHSA-aaaa-aaaa-aaaa',
        packageName: 'elliptic',
        severity: 'low',
        title: 'Risky cryptographic primitive',
        patchedVersions: '<0.0.0',
      },
    ]);
  });

  it('throws when the command printed something that is not JSON', () => {
    assert.throws(
      () => parseAuditReport('ERR_PNPM_REGISTRY_UNREACHABLE  request to registry failed'),
      /did not return JSON/,
    );
  });

  it('throws rather than reading a report with no advisories map as clean', () => {
    assert.throws(() => parseAuditReport(JSON.stringify({ metadata: { vulnerabilities: {} } })), /advisories/);
  });

  it('throws rather than dropping an advisory with no GHSA id', () => {
    assert.throws(() => parseAuditReport(rawReport({ github_advisory_id: undefined })), /GHSA/);
  });

  it('throws rather than dropping an advisory with no package name', () => {
    assert.throws(() => parseAuditReport(rawReport({ module_name: undefined })), /module_name/);
  });

  it('throws on a severity it does not recognise instead of letting it through', () => {
    assert.throws(() => parseAuditReport(rawReport({ severity: 'spicy' })), /spicy/);
  });
});

describe('the shipped allowlist', () => {
  it('names one package and one reason per entry', () => {
    for (const entry of ALLOWED_ADVISORIES) {
      assert.match(entry.ghsa, /^GHSA-/, `${entry.ghsa} is not a GHSA id`);
      assert.ok(entry.packageName.length > 0, `${entry.ghsa} has no package name`);
      assert.ok(entry.reason.length > 0, `${entry.ghsa} has no reason`);
    }
  });

  it('holds no advisory twice', () => {
    const ghsas = ALLOWED_ADVISORIES.map((entry) => entry.ghsa);
    assert.equal(new Set(ghsas).size, ghsas.length);
  });
});
