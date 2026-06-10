import { PlaylistEntry } from './interfaces.js';

// Detects whether a playlist is a master (has #EXT-X-STREAM-INF) and returns
// the first variant URI if so. Returns null if it's a media playlist.
export function parseMasterPlaylist(text: string): string | null {
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
  return null;
}

export function parsePlaylist(text: string): PlaylistEntry[] {
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
