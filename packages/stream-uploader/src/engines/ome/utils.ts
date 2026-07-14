import { Logger } from '../../libs/Logger.js';

import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType } from './../../types.js';
import { AppStream, PlaylistEntry } from './interfaces.js';

export function isMasterPlaylist(text: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim().startsWith('#EXT-X-STREAM-INF:'));
}

export function parseMasterPlaylist(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
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
  let index = 0;
  const entries: PlaylistEntry[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSeq = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const value = line.slice('#EXTINF:'.length).split(',')[0];
      pendingDuration = parseFloat(value);
      continue;
    }
    if (line.startsWith('#')) {
      continue;
    }

    if (pendingDuration !== null) {
      entries.push({ seq: mediaSeq + index, duration: pendingDuration, uri: line });
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
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    logger.error(`[OME] Could not parse app/stream from URL: ${url} (${errorMsg})`);
    throw new Error(`Could not parse app/stream from URL: ${url} (${errorMsg})`);
  }

  return { app: parts[0], stream: parts[1] };
}
