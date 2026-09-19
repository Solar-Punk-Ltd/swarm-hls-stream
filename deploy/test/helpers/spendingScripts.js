import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which scripts under `deploy/scripts` can spend, discovered rather than listed, so a new one cannot
 * opt out of the gates by being written after the tests.
 *
 * ⛔ These read script TEXT, which is normally not acceptable in this suite. It is the only lever
 * here because the property under test is exactly "which scripts source which gate": a test that ran
 * the script would answer whether the gate fired on that one path, and the defect being guarded
 * against is a driver in which the gate is not wired at all. `sweepGates.test.js`,
 * `viewerArms.test.js` and the rest drive the gates through the real scripts, so what a gate DOES is
 * proven by execution and only its presence is read off the page.
 */

/** `deploy/scripts`, reached from `deploy/test/helpers` so a sandboxed copy cannot be read by mistake. */
export const SCRIPTS = resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'scripts');

/**
 * Scripts that publish but cannot reach the deployment, with the reason each is exempt.
 *
 * ⛔ Named one at a time on purpose. A rule that quietly skipped anything would be a gate with a hole
 * in it, and the rule these tests enforce is that a script reaching the paid stack is gated.
 */
const PUBLISHES_NOTHING_THE_STACK_PAYS_FOR = {
  'srs-segment-duration-on-host.sh':
    'builds its own SRS container on its own hardcoded ports with no uploader, no bee and no postage ' +
    'behind it, so it cannot reach the paid stack and its own header refuses to be pointed at one',
};

/**
 * A shebang is what separates a driver from a sourced library: the shared files here carry
 * `# shellcheck shell=bash` instead, precisely because running one on its own does nothing useful.
 * Without that split this picks up `capacity-gate.sh` and `spend-ceiling.sh` themselves, which name
 * the other files only to explain the rules they enforce.
 */
function executableScripts() {
  return readdirSync(SCRIPTS)
    .filter((name) => name.endsWith('.sh'))
    .filter((name) => readFileSync(join(SCRIPTS, name), 'utf8').startsWith('#!'));
}

/** The body with whole-line comments removed, so a file that only DISCUSSES ffmpeg is not a publisher. */
function codeOf(name) {
  return readFileSync(join(SCRIPTS, name), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/**
 * Every script that starts a real broadcast, which is what costs BZZ and fills the postage batch.
 *
 * ⛔⛔⛔ This is the discovery `capacityGate.test.js` did not have. It found drivers by asking which
 * scripts source `burn-rates.sh`, so `publish-clock.sh`, which sourced nothing and published an hour
 * of 720p into Swarm on one documented command line, was invisible to it by construction. A script
 * that prices a sitting knows enough to be asked about the money, and so does one that starts the
 * publisher whether or not it prices anything.
 */
export function scriptsThatSpend() {
  return executableScripts().filter((name) => {
    if (name in PUBLISHES_NOTHING_THE_STACK_PAYS_FOR) {
      return false;
    }
    const code = codeOf(name);
    const pricesASitting = code.includes('burn-rates.sh');
    const startsAPublisher = code.includes('ffmpeg') || code.includes('publish-clock.sh');
    return pricesASitting || startsAPublisher;
  });
}

/** The exempt scripts and their reasons, so a test can say the list is read rather than assumed. */
export function exemptScripts() {
  return PUBLISHES_NOTHING_THE_STACK_PAYS_FOR;
}

export function bodyOf(name) {
  return readFileSync(join(SCRIPTS, name), 'utf8');
}

export { codeOf };
