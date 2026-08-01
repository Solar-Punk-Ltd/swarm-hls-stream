import { Logger } from '../../libs/Logger.js';
import { getErrorMessage } from '../../utils/common.js';
import {
  HLS_DISCONTINUITY,
  HLS_EXTINF,
  HLS_MEDIA_SEQUENCE,
  HLS_PROGRAM_DATE_TIME,
  HLS_STREAM_INF,
} from '../../utils/hlsTags.js';

import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType } from './../../types.js';
import { AppStream, PlaylistEntry } from './interfaces.js';

const STREAM_INF_PREFIX = `${HLS_STREAM_INF}:`;
const MEDIA_SEQUENCE_PREFIX = `${HLS_MEDIA_SEQUENCE}:`;
const EXTINF_PREFIX = `${HLS_EXTINF}:`;
const PROGRAM_DATE_TIME_PREFIX = `${HLS_PROGRAM_DATE_TIME}:`;

export function isMasterPlaylist(text: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim().startsWith(STREAM_INF_PREFIX));
}

export function parseMasterPlaylist(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith(STREAM_INF_PREFIX)) {
      // Next non-empty, non-comment line is the variant URI
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next || next.startsWith('#')) {
          continue;
        }
        return next;
      }
    }
  }
  throw new Error('Master playlist has no variant URI');
}

/**
 * A duration that can go into a manifest. Anything else reaches `#EXTINF` verbatim, and a playlist
 * that says `NaN` or a negative length is one no player can follow. Zero is degenerate rather than
 * unusable: it publishes cleanly and adds nothing to a total.
 */
function isUsableDuration(duration: number): boolean {
  return Number.isFinite(duration) && duration >= 0;
}

export function parseMediaPlaylist(text: string): PlaylistEntry[] {
  const lines = text.split(/\r?\n/);
  let mediaSeq = 0;
  let pendingDuration: number | null = null;
  let pendingDiscontinuity = false;
  // Carried forward rather than read per segment, because RFC 8216 lets a playlist stamp only its
  // first segment and leave the rest to be derived by accumulating durations. OME stamps every one,
  // but a puller that only understood OME's spelling would silently lose the floor against any origin
  // using the other, and losing the floor is indistinguishable from having one.
  let nextProgramDateTime: number | null = null;
  let index = 0;
  const entries: PlaylistEntry[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith(MEDIA_SEQUENCE_PREFIX)) {
      mediaSeq = parseInt(line.slice(MEDIA_SEQUENCE_PREFIX.length), 10) || 0;
      continue;
    }
    if (line.startsWith(PROGRAM_DATE_TIME_PREFIX)) {
      const parsed = Date.parse(line.slice(PROGRAM_DATE_TIME_PREFIX.length).trim());
      nextProgramDateTime = Number.isNaN(parsed) ? null : parsed;
      continue;
    }
    if (line.startsWith(EXTINF_PREFIX)) {
      const value = line.slice(EXTINF_PREFIX.length).split(',')[0];
      pendingDuration = parseFloat(value);
      continue;
    }
    if (line === HLS_DISCONTINUITY) {
      pendingDiscontinuity = true;
      // The tag says the media after it is not a continuation of the media before it, so the next
      // segment's start cannot be derived by adding a duration to the last one. Unknown is the honest
      // answer, and a consumer reading these to judge what is old treats unknown as "cannot judge"
      // rather than acting on a number that describes a timeline that no longer applies.
      nextProgramDateTime = null;
      continue;
    }
    if (line.startsWith('#')) {
      continue;
    }

    if (pendingDuration === null) {
      continue;
    }

    const duration = pendingDuration;
    const discontinuity = pendingDiscontinuity;
    pendingDuration = null;
    pendingDiscontinuity = false;
    // Spent whether or not the segment turns out to be usable, because the origin numbers by position.
    // Skipping without advancing hands every later segment in the playlist an index that belongs to
    // other media, and the orchestrator's duplicate filter then swallows real segments as ones it has
    // already seen.
    const seq = mediaSeq + index;
    index++;

    if (!isUsableDuration(duration)) {
      // It would reach `#EXTINF` in the manifest we publish verbatim, which makes that playlist
      // unplayable, and poison the total the VOD catalog entry advertises. Dropping the position
      // leaves a gap the puller reports as a loss, which marks the next segment as a discontinuity,
      // so players skip it rather than being told the gap is contiguous. See CON-7.
      logger.warn(`[OME] Skipping segment ${seq} (${line}): ${HLS_EXTINF} duration is unusable`);
      nextProgramDateTime = null;
      continue;
    }

    entries.push({
      seq,
      duration,
      uri: line,
      // Left off the entry entirely rather than set to undefined, so an unstamped playlist parses to
      // exactly the shape it did before these fields existed.
      ...(nextProgramDateTime !== null ? { programDateTime: nextProgramDateTime } : {}),
      ...(discontinuity ? { discontinuity: true } : {}),
    });
    if (nextProgramDateTime !== null) {
      nextProgramDateTime += duration * 1000;
    }
  }

  return datePrecedingSegments(entries);
}

/**
 * RFC 8216 section 6.3.3: when the first `#EXT-X-PROGRAM-DATE-TIME` appears after one or more segment
 * URIs, a client extrapolates backward from it to date the segments in front of it.
 *
 * Without this the oldest part of a partly stamped playlist carries no date at all, and a consumer
 * using the date to decide what to keep reads that as "cannot judge" rather than "old". Origins that
 * stamp on an interval rather than per segment produce exactly this shape on every poll once the
 * window has slid past the first tag.
 */
function datePrecedingSegments(entries: PlaylistEntry[]): PlaylistEntry[] {
  const firstStamped = entries.findIndex((entry) => entry.programDateTime !== undefined);
  if (firstStamped <= 0) {
    return entries;
  }

  const dated = [...entries];
  for (let i = firstStamped - 1; i >= 0; i--) {
    const nextStart = dated[i + 1].programDateTime;
    // Extrapolating back over a discontinuity dates the older media off the newer timeline, which is
    // exactly as wrong as carrying the anchor forward over one. Every duration is usable by the time
    // it gets here, so there is nothing else left to stop on.
    if (nextStart === undefined || dated[i + 1].discontinuity) {
      break;
    }
    dated[i] = { ...dated[i], programDateTime: nextStart - dated[i].duration * 1000 };
  }

  return dated;
}

const logger = Logger.getInstance();

export function resolveMediaType(app: string): MediaType {
  return app === MEDIA_TYPE_AUDIO ? MEDIA_TYPE_AUDIO : MEDIA_TYPE_VIDEO;
}

export function buildStreamId(app: string, stream: string): string {
  return `${app}/${stream}`;
}

/** Inverse of {@link buildStreamId}: split an OME stream id back into its app + stream parts. */
export function parseStreamId(streamId: string): AppStream {
  const [app, ...rest] = streamId.split('/');
  return { app, stream: rest.join('/') };
}

export function parseAppStream(url: string): AppStream {
  let parts: string[] = [];

  try {
    const u = new URL(url);
    parts = u.pathname.split('/').filter(Boolean);

    if (parts.length < 2) {
      const streamid = u.searchParams.get('streamid');
      if (streamid) {
        parts = new URL(streamid).pathname.split('/').filter(Boolean);
      }
    }
  } catch (e) {
    const errorMsg = getErrorMessage(e);
    logger.error(`[OME] Could not parse app/stream from URL: ${url} (${errorMsg})`);
    throw new Error(`Could not parse app/stream from URL: ${url} (${errorMsg})`);
  }

  return { app: parts[0], stream: parts[1] };
}
