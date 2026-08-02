import { Logger } from '../../libs/Logger.js';
import { getErrorMessage } from '../../utils/common.js';
import {
  HLS_DISCONTINUITY,
  HLS_EXTINF,
  HLS_MEDIA_SEQUENCE,
  HLS_PROGRAM_DATE_TIME,
  HLS_STREAM_INF,
} from '../../utils/hlsTags.js';
import { isUsableDuration } from '../../utils/segmentDuration.js';
import { isUsableStreamId } from '../../utils/streamId.js';

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
 * An hour, which no HLS segment approaches and which every real one is three orders of magnitude
 * under. The ceiling exists because finite is not the same as sane: `1e308` is finite, publishes as
 * `#EXTINF:1e+308,` and `#EXT-X-TARGETDURATION:1e+308`, poisons the total the VOD advertises, and
 * drives every derived timestamp to an infinity a replacement puller then adopts as its floor.
 */
export function parseMediaPlaylist(text: string): PlaylistEntry[] {
  const lines = text.split(/\r?\n/);
  let mediaSeq = 0;
  let pendingDuration: number | null = null;
  let pendingDiscontinuity = false;
  /** Whether the pending anchor was accumulated from durations rather than read from a tag. */
  let anchorIsDerived = true;
  const skipped: number[] = [];
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
      anchorIsDerived = false;
      continue;
    }
    if (line.startsWith(EXTINF_PREFIX)) {
      const value = line.slice(EXTINF_PREFIX.length).split(',')[0];
      pendingDuration = parseFloat(value);
      continue;
    }
    if (line === HLS_DISCONTINUITY) {
      pendingDiscontinuity = true;
      // The tag says the media after it is not a continuation of the media before it, so a start
      // *derived* by adding durations to the last one describes a timeline that no longer applies.
      // Unknown is the honest answer there, and a consumer judging what is old treats unknown as
      // "cannot judge" rather than acting on a wrong number.
      //
      // An anchor the origin wrote for the segment that follows is not derived and not invalidated:
      // RFC 8216 does not order the two tags, so discarding it loses the stamp on exactly the segment
      // it was written for. That is the field the handover floor is built on, and the loss would land
      // on an encoder restart, which is when a session boundary is likeliest.
      if (anchorIsDerived) {
        nextProgramDateTime = null;
      }
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
      skipped.push(seq);
      // The dropped media occupied real time, so what follows it is not a continuation of what came
      // before it. Recording that is what stops the backward walk in `datePrecedingSegments` dating
      // the earlier segments as if they were adjacent: the `Number.isFinite` guard it replaced used
      // to stop there only because the bad entry was present, and now it is absent instead.
      pendingDiscontinuity = true;
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
      anchorIsDerived = true;
    }
  }

  if (skipped.length > 0) {
    // Once per parse with a count, not once per segment. An origin serving a window full of malformed
    // durations re-serves it every poll, and a line each would bury the loss report that says what was
    // actually lost. The neighbouring skip log keeps a high-water for the same reason.
    logger.warn(`[OME] Skipped ${skipped.length} segment(s) with an unusable ${HLS_EXTINF}: ${skipped.join(', ')}`);
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
    // exactly as wrong as carrying the anchor forward over one. A position the parser dropped is one
    // too: it now carries the flag, so this one condition stops on both.
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

/**
 * The app and stream a publish URL names, from its path or from an SRT `streamid`.
 *
 * Throws unless both are present and both are usable as a name. It used to return them as-is, which
 * typed as `AppStream` but was not one: `srt://ome:10080/video` produced
 * `{ app: 'video', stream: undefined }` and its only caller built the stream id `video/undefined`
 * from it and admitted the publish.
 *
 * **The character check is the security half and it is not a tightening of the emptiness check.**
 * `srt:` is not a special scheme, so `new URL` leaves a backslash in `pathname` verbatim. The name
 * `pwn\..\..\video\victim` therefore reached `OmeHlsPuller`, which interpolates it into an `http:`
 * URL, where the WHATWG parser reads `\` as `/` and resolves the dot segments. The puller was
 * pointed at `/video/victim/ts:playlist.m3u8`, and mirrored another broadcaster's live segments into
 * Swarm on the operator's postage under a second catalog entry, without stopping. It also could not
 * be stopped by hand, because `streamIdSchema` refuses that id, so the operator's own control path
 * could not name the stream the engine had created. See SEC-25.
 */
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
    logger.error(`[OME] URL is not parseable: ${url} (${errorMsg})`);
    throw new Error(`Could not parse app/stream from URL: ${url} (unparseable: ${errorMsg})`);
  }

  const [app, stream] = parts;
  if (!app || !stream) {
    logger.error(`[OME] URL names no app/stream pair: ${url}`);
    throw new Error(`Could not parse app/stream from URL: ${url} (no app/stream pair)`);
  }
  if (!isUsableStreamId(buildStreamId(app, stream))) {
    logger.error(`[OME] URL names an unusable app/stream: ${url}`);
    throw new Error(`Could not parse app/stream from URL: ${url} (unusable app/stream name)`);
  }

  return { app, stream };
}
