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
export const LIVE_SYNC_DURATION_S = 10;

/** Where the mirrored value lives, for the test that compares them and for a report to cite. */
export const PLAYER_CONFIG_PATH = 'packages/client/src/components/SwarmHlsPlayer/playerConfig.ts';

export const LIVE_SYNC_DURATION_EXPORT = 'LIVE_SYNC_DURATION_S';
