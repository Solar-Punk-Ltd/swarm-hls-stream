/**
 * The player-side latency the bench cannot measure, mirrored from the client.
 *
 * Everything else in the split is observed. This one is a decision: hls.js holds playback
 * `liveSyncDuration` behind the live edge on purpose, so it is a term in what a viewer experiences
 * and would be missing from any total that only measured the pipeline.
 *
 * Mirrored rather than imported, which is the same arrangement `logLevel.ts` uses against the
 * uploader's call sites: e2e must not reach past a package boundary into another package's
 * internals. `test/clientTuning.test.ts` reads the value out of the client's own source and fails if
 * the two drift, so the mirror cannot go stale quietly and report a baseline against a buffer the
 * player stopped using.
 */

/** Mirrors `LIVE_SYNC_DURATION_S` in `packages/client/src/components/SwarmHlsPlayer/playerConfig.ts`. */
export const LIVE_SYNC_DURATION_S = 6;

/**
 * The fastest hls.js may run playback while catching up, and so the fastest media time can honestly
 * outrun wall-clock time.
 *
 * Mirrored because it is the ceiling that separates playing from seeking. Anything gained above it
 * was jumped rather than watched, which is the whole basis of {@link SessionSummary.forwardSeeks}.
 */
export const MAX_LIVE_SYNC_PLAYBACK_RATE = 1.1;

/**
 * The latency past which hls.js seeks to the live edge instead of drifting toward it.
 *
 * Derived here exactly as the client derives it, rather than mirrored as a second number, because a
 * mirror needs a guard to stay true and this one would be guarding arithmetic. If the client ever
 * stops defining it as twice the target, this becomes a mirror and gains a test like
 * {@link LIVE_SYNC_DURATION_S} has.
 */
export const LIVE_MAX_LATENCY_DURATION_S = 2 * LIVE_SYNC_DURATION_S;

/** Where the mirrored values live, for the test that compares them and for a report to cite. */
export const PLAYER_CONFIG_PATH = 'packages/client/src/components/SwarmHlsPlayer/playerConfig.ts';

export interface MirroredPlayerConstant {
  /** The name the client exports it under, which is what the drift guard looks for. */
  clientExport: string;
  value: number;
  /** What a report gets wrong if the two drift apart, said in the terms a reader would notice. */
  ifStale: string;
}

/**
 * Every value copied out of the client, and what goes wrong when a copy stops matching.
 *
 * A table rather than a constant per guard, so a mirror added here cannot be added without one.
 * {@link LIVE_MAX_LATENCY_DURATION_S} is absent on purpose: it is derived from the value above it
 * rather than copied, so there is nothing for a guard to compare.
 */
export const MIRRORED_PLAYER_CONSTANTS: readonly MirroredPlayerConstant[] = [
  {
    clientExport: 'LIVE_SYNC_DURATION_S',
    value: LIVE_SYNC_DURATION_S,
    ifStale: 'every viewer latency the bench reports is wrong by the difference',
  },
  {
    clientExport: 'MAX_LIVE_SYNC_PLAYBACK_RATE',
    value: MAX_LIVE_SYNC_PLAYBACK_RATE,
    ifStale: 'catch-up gets read as a seek, or a seek gets read as catch-up, in every advance ratio',
  },
];
