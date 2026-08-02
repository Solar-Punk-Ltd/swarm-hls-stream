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

/**
 * Decimal places kept in an `#EXTINF` duration.
 *
 * Six is past the precision any encoder emits and short of where JavaScript starts writing
 * exponents, which is the whole point of fixing it at all.
 */
const EXTINF_DECIMALS = 6;

/**
 * The `#EXTINF:<duration>,` line for a segment, the one spelling both packages write.
 *
 * Formatted rather than interpolated, because `String(0.0000001)` is `"1e-7"` and RFC 8216 does not
 * allow exponent notation. hls.js reads such a line with `/(\d*(?:\.\d+)?)/`, which captures the `1`
 * and plays the segment as **one second** instead of a ten-millionth of one. The uploader accepts
 * that duration today: `isUsableDuration` only asks for a finite number in `[0, 3600]`.
 */
export function buildExtinf(duration: number): string {
  const fixed = duration.toFixed(EXTINF_DECIMALS).replace(/\.?0+$/, '');
  return `${HLS_EXTINF}:${fixed || '0'},`;
}

/**
 * The duration an `#EXTINF` line carries, or `null` when the line is not one or its value is not a
 * number. Segment durations are fractional seconds, so this is not an integer parse.
 *
 * `parseFloat` stops at the first character it cannot use, so `#EXTINF:6abc,` reads as 6 and
 * `#EXTINF:0x10,` reads as 0. The second is the one that matters, because a real zero-length segment
 * and an unparseable one become indistinguishable. See CON-30.
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
 * Header lines are the ones before the first segment or discontinuity. `#EXT-X-ENDLIST` sets
 * `isFinalized` wherever it appears, since a finished recording is the one fact a reader must not
 * miss.
 *
 * **This reads the playlists this project produces, not RFC 8216 in general**, and the difference is
 * worth stating because the function now lives in a shared package where it looks more general than
 * it is. It requires the media URI on the line immediately after its `#EXTINF`, so anything RFC 8216
 * permits in between takes the segment with it rather than only itself: a blank line, a comment, or
 * an `#EXT-X-BYTERANGE`, which §4.3.2.2 requires to sit exactly there. A byte-range playlist
 * therefore parses to zero segments. `ManifestManager` writes neither, which is why this has been
 * correct in practice, and it is carried over unchanged from the client rather than introduced here.
 * See CON-30.
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
