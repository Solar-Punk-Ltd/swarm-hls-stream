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
];
