/**
 * How far the uploader host's clock sits from the bench's.
 *
 * Two of the five hops are bounded by one instant from each machine, so their boundary moves with the
 * skew. The total does not — the host-clock instants appear once positively and once negatively and
 * cancel — which is why an estimate this rough is enough: it apportions time between two rows and
 * cannot move the headline figure. See `split.ts`.
 *
 * Estimated the way NTP does at its simplest: read the remote clock between two local readings and
 * assume the round trip was symmetric. Asymmetry is the error, and half the round trip bounds it.
 */

import type { Host } from '../harness/host.js';

import type { ClockSkew } from './split.js';

/** Epoch milliseconds, which is what `date +%s%3N` prints on the GNU coreutils every image here uses. */
const REMOTE_NOW_COMMAND = 'date +%s%3N';

/** Epoch milliseconds is 13 digits until 2286, and 10 digits would be a `date` that ignored `%3N`. */
const EPOCH_MS_RE = /^\d{13}$/;

/**
 * The estimate from one exchange, split out from the transport so the arithmetic can be driven
 * directly.
 *
 * @param localBeforeMs bench clock, immediately before asking
 * @param remoteMs what the host answered
 * @param localAfterMs bench clock, immediately after the answer arrived
 */
export function skewFrom(localBeforeMs: number, remoteMs: number, localAfterMs: number): ClockSkew {
  const roundTripMs = localAfterMs - localBeforeMs;
  return {
    offsetMs: remoteMs - (localBeforeMs + localAfterMs) / 2,
    uncertaintyMs: roundTripMs / 2,
  };
}

/** The tightest of several exchanges, which is the one whose round trip left least room to be wrong. */
export function tightestSkew(samples: readonly ClockSkew[]): ClockSkew {
  if (samples.length === 0) {
    throw new Error('no clock skew samples to choose from');
  }
  return [...samples].sort((a, b) => a.uncertaintyMs - b.uncertaintyMs)[0];
}

export function parseRemoteEpochMs(stdout: string): number {
  const trimmed = stdout.trim();
  if (!EPOCH_MS_RE.test(trimmed)) {
    throw new Error(
      `the deployment host answered "${trimmed.slice(0, 40)}" to \`${REMOTE_NOW_COMMAND}\`, which is not ` +
        'epoch milliseconds. A `date` without %N support prints the literal, and reading it as a ' +
        'number would place the host clock decades away and drive two hops of every split negative.',
    );
  }
  return Number(trimmed);
}

/**
 * Measure the skew over `exchanges` round trips and keep the tightest.
 *
 * Several rather than one because the ssh transport is multiplexed and a single reading can land
 * behind an unrelated command, which widens the round trip and with it the uncertainty.
 */
export async function measureClockSkew(host: Host, exchanges: number = 5): Promise<ClockSkew> {
  const samples: ClockSkew[] = [];
  for (let i = 0; i < exchanges; i++) {
    const localBeforeMs = Date.now();
    const { stdout } = await host.run(REMOTE_NOW_COMMAND);
    const localAfterMs = Date.now();
    samples.push(skewFrom(localBeforeMs, parseRemoteEpochMs(stdout), localAfterMs));
  }
  return tightestSkew(samples);
}
