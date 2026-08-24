import { AllowedAdvisory } from './types.js';

/**
 * Advisories this repository knowingly ships with. An entry says the exposure
 * was looked at and cannot be closed by a dependency bump today, never that it
 * is harmless, and the gate fails on any entry that stops matching the report.
 */
export const ALLOWED_ADVISORIES: readonly AllowedAdvisory[] = [
  {
    ghsa: 'GHSA-848j-6mx2-7j84',
    packageName: 'elliptic',
    reviewedSeverity: 'low',
    reviewedPatchedVersions: '<0.0.0',
    reason:
      'No release fixes it anywhere. The advisory records its patched range as "<0.0.0", meaning upstream has shipped nothing to move to. It reaches the client bundle through vite-plugin-node-polyfills and crypto-browserify, so it goes when that chain does or when elliptic publishes a fix.',
  },
  {
    ghsa: 'GHSA-7p8r-x3mc-p8w7',
    packageName: 'fast-uri',
    reviewedSeverity: 'high',
    reviewedPatchedVersions: '>=3.1.5',
    reason:
      'Development tooling only, and the bump is worse than the exposure. fast-uri 3.1.4 arrives twice, through ajv under @commitlint/config-validator and under @stryker-mutator/core, and neither is in any shipped artifact: the client bundle, the uploader image and the CLI all resolve without it. The advisory is host confusion via a backslash authority introducer, which needs a URI from an untrusted source, and the only URIs ajv parses here are the $id and $ref fields of our own commitlint and stryker config schemas, committed in this repository. Against that, 3.1.5 was published 2026-07-31, carries a registry signature but no SLSA provenance attestation, and no malware advisory names the package. Taking a fresh unattested release into the tree to close a path that is not reachable is the larger risk of the two. Re-checked 2026-08-10: 3.1.5 is 10 days old, still the newest release, and still has no provenance, verified against a control package so the negative is a real answer rather than a query artifact. Revisit when 3.1.5 has aged past a fortnight and ideally gained an attestation, or when it arrives on its own through a commitlint or stryker upgrade. Re-checked 2026-08-24: the fortnight has passed and the attestation has not. 3.1.5 is 24 days old and still carries a registry signature with no SLSA provenance, verified against sigstore@3.0.0 and tuf-js@3.0.1, which both return one, so the negative is a real answer and not a query artifact. It is no longer the newest 3.x either: 3.1.6 was published 2026-08-23, is one day old, and has no attestation of its own. No malware advisory names the package, and npm audit signatures verifies every one of the 1674 installed packages. The tree still resolves 3.1.4 through ajv 8.18.0. Half the revisit condition is met and half is not, so the entry stands and taking an unattested 3.1.5 anyway is a call for the maintainer rather than the gate.',
  },
];
