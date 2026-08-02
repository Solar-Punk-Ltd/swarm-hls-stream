import { HLS_DISCONTINUITY, HLS_ENDLIST, HLS_EXTINF } from './hlsTags.js';

/**
 * One media segment as it survives a manifest round trip.
 *
 * `extinf` is the whole `#EXTINF:<duration>,` line rather than the number, because the parser is
 * lossless by design: what the builder wrote is what a reader gets back, and `segmentDuration`
 * exists for the callers that want the number.
 */
export interface Segment {
  extinf: string;
  uri: string;
  discontinuity?: boolean;
}

export interface ParsedManifest {
  headers: string[];
  segments: Segment[];
  isFinalized: boolean;
}

/** The `#EXTINF:<duration>,` line for a segment, the one spelling both packages write. */
export function buildExtinf(duration: number): string {
  return `${HLS_EXTINF}:${duration},`;
}

/**
 * The duration an `#EXTINF` line carries, or `null` when the line is not one or its value is not a
 * number. Segment durations are fractional seconds, so this is not an integer parse.
 */
export function segmentDuration(extinf: string): number | null {
  if (!extinf.startsWith(`${HLS_EXTINF}:`)) {
    return null;
  }
  const value = Number.parseFloat(extinf.slice(HLS_EXTINF.length + 1));
  return Number.isFinite(value) ? value : null;
}

/**
 * Split a playlist into its headers and its segments.
 *
 * Header lines are the ones before the first segment or discontinuity. Everything after that is
 * either a segment pair (`#EXTINF` followed by a URI) or a tag this parser does not model, which is
 * dropped rather than guessed at. `#EXT-X-ENDLIST` sets `isFinalized` wherever it appears, since a
 * finished recording is the one fact a reader must not miss.
 */
export function parseManifest(text: string): ParsedManifest {
  const lines = text.trim().split('\n');
  const headers: string[] = [];
  const segments: Segment[] = [];
  let isFinalized = false;
  let headersDone = false;
  let pendingDiscontinuity = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === HLS_ENDLIST) {
      isFinalized = true;
      continue;
    }

    if (line === HLS_DISCONTINUITY) {
      headersDone = true;
      pendingDiscontinuity = true;
      continue;
    }

    if (line.startsWith(HLS_EXTINF)) {
      headersDone = true;
      const uri = lines[i + 1]?.trim();
      if (uri && !uri.startsWith('#')) {
        segments.push({ extinf: line, uri, discontinuity: pendingDiscontinuity });
        i++;
      }
      pendingDiscontinuity = false;
      continue;
    }

    if (!headersDone && line) {
      headers.push(line);
    }
  }

  return { headers, segments, isFinalized };
}
