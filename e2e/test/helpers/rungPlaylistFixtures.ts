/**
 * Playlists in the shape the uploader publishes them, kept out of `manifestContractLive.test.ts` so
 * the tests there read as tests.
 *
 * ⛔ Every line is composed with the same `@swarm-hls-stream/shared` builders `ManifestManager`
 * composes with, in the order it writes them: the headers, then per segment the break, the wall
 * clock, the `#EXTINF` and the bare reference. Nothing here is typed out from RFC 8216, because a
 * fixture written from the specification proves a reader against a playlist nobody publishes. What
 * IS mirrored rather than imported is the ordering, since `ManifestManager` lives in another package
 * and `e2e` must not reach into its internals. `packages/stream-uploader/test/manifestManager.test.ts`
 * holds the producer's own end of it.
 *
 * The dates are this project's own era on purpose. A stamp before 2025 is refused as not being a
 * date at all, which is the defect the first stamped stage broadcast actually produced, so a fixture
 * dated in 1970 would fail every case here for a reason no case is about.
 */

import {
  buildExtinf,
  buildProgramDateTime,
  HLS_DISCONTINUITY,
  HLS_ENDLIST,
  HLS_M3U,
  HLS_MEDIA_SEQUENCE,
  HLS_PLAYLIST_TYPE_VOD,
  HLS_TARGET_DURATION,
  HLS_VERSION,
} from '@swarm-hls-stream/shared';

/** The stage this fixture describes: 2.0s fragments, which is what the `in-browser` profile needs. */
export const FIXTURE_FRAGMENT_SECONDS = 2;

/** The instant the fixture broadcast was admitted, which every stamp below is derived from. */
export const FIXTURE_ANCHOR_MS = Date.UTC(2026, 8, 3, 10, 0, 0);

const MS_PER_SECOND = 1000;

/** A Swarm reference as a playlist line: 32 bytes of lowercase hex, alone on the line. */
function reference(sequence: number): string {
  return sequence.toString(16).padStart(64, '0');
}

export function fixtureDateOf(sequence: number): string {
  return new Date(FIXTURE_ANCHOR_MS + sequence * FIXTURE_FRAGMENT_SECONDS * MS_PER_SECOND).toISOString();
}

export interface PlaylistOptions {
  /** Defaults to the first sequence, which is what an unslid window declares. */
  mediaSequence?: number;
  /** Sequences that carry an `#EXT-X-DISCONTINUITY`. */
  breaks?: readonly number[];
  /** A finished recording: `#EXT-X-PLAYLIST-TYPE:VOD` and an `#EXT-X-ENDLIST`. */
  recording?: boolean;
  /** The closing live playlist: an `#EXT-X-ENDLIST` and no playlist type, which is not a recording. */
  closed?: boolean;
}

/**
 * One rung's playlist naming the given sequences.
 *
 * @param sequences the playlist sequence of each segment, so a caller can build a gap or a repeat
 */
export function rungPlaylist(sequences: readonly number[], options: PlaylistOptions = {}): string {
  const breaks = new Set(options.breaks ?? []);
  const lines = [
    HLS_M3U,
    `${HLS_VERSION}:3`,
    `${HLS_TARGET_DURATION}:${FIXTURE_FRAGMENT_SECONDS}`,
    ...(options.recording ? [HLS_PLAYLIST_TYPE_VOD] : []),
    `${HLS_MEDIA_SEQUENCE}:${options.mediaSequence ?? sequences[0] ?? 0}`,
    '',
    ...sequences.flatMap((sequence) => [
      ...(breaks.has(sequence) ? [HLS_DISCONTINUITY] : []),
      buildProgramDateTime(FIXTURE_ANCHOR_MS + sequence * FIXTURE_FRAGMENT_SECONDS * MS_PER_SECOND),
      buildExtinf(FIXTURE_FRAGMENT_SECONDS),
      reference(sequence),
    ]),
    ...(options.recording || options.closed ? [HLS_ENDLIST] : []),
  ];

  return lines.join('\n') + '\n';
}

/**
 * What the bee gateway answers while it is restarting: its own JSON error envelope.
 *
 * ⛔ Verbatim from a gateway read taken mid-restart, and the reason the reader checks for `#EXTM3U`
 * rather than trusting the parse. This body parses as a playlist naming no segments, so a reader
 * that fed it straight to the contract would report a broadcast that published an empty timeline.
 */
export const GATEWAY_ERROR_ENVELOPE = '{"message":"Not Found","code":404}';
