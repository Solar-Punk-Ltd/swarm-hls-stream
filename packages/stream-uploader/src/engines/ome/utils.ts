import { Logger } from '../../libs/Logger.js';
import { getErrorMessage } from '../../utils/common.js';
import { HLS_EXTINF, HLS_MEDIA_SEQUENCE, HLS_PROGRAM_DATE_TIME, HLS_STREAM_INF } from '../../utils/hlsTags.js';

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

export function parseMediaPlaylist(text: string): PlaylistEntry[] {
  const lines = text.split(/\r?\n/);
  let mediaSeq = 0;
  let pendingDuration: number | null = null;
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
    if (line.startsWith('#')) {
      continue;
    }

    if (pendingDuration !== null) {
      entries.push({
        seq: mediaSeq + index,
        duration: pendingDuration,
        uri: line,
        // Left off the entry entirely rather than set to undefined, so an unstamped playlist parses to
        // exactly the shape it did before this field existed.
        ...(nextProgramDateTime !== null ? { programDateTime: nextProgramDateTime } : {}),
      });
      if (nextProgramDateTime !== null) {
        nextProgramDateTime += pendingDuration * 1000;
      }
      pendingDuration = null;
      index++;
    }
  }

  return entries;
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
