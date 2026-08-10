import type { Rendition } from '@/types/stream';

/**
 * Playlist text and feed URIs — the pure half of the Swarm HLS loader.
 *
 * Kept apart from `ManifestManagement` so it can be exercised without a Bee node, a gateway URL or
 * a browser: this is the code that decides what hls.js actually parses, and getting a tag or a URI
 * wrong here fails as a mute player rather than as an error.
 */

export interface Segment {
  extinf: string;
  uri: string;
}

/**
 * The URI scheme feeds are addressed by, chosen for what hls.js does to a playlist's URIs rather
 * than for looks.
 *
 * Every URI in a playlist is resolved against the playlist's own URL through url-toolkit's
 * `buildAbsoluteURL`, and a URI carrying a scheme is the one case it returns untouched. Handing it
 * a bare `owner/topic` instead makes it treat the owner as a host and emit `owner/owner/topic` —
 * harmless while there is a single media playlist whose URL is never re-resolved, wrong the moment
 * a master playlist points at four of them.
 */
const SWARM_SCHEME = 'swarm://';

const HLS_ENDLIST = '#EXT-X-ENDLIST';
const HLS_EXTINF = '#EXTINF';

export function buildSwarmUri(owner: string, topic: string): string {
  return `${SWARM_SCHEME}${owner}/${topic}`;
}

/**
 * Where segment references are fetched from, as an absolute URL.
 *
 * Absolute is the whole point. These strings are written into a media playlist, and hls.js
 * resolves every URI in a playlist against that playlist's own URL — which here is
 * `swarm://<owner>/<topic>`. A root-relative `/bee/bytes/<ref>` resolved against that inherits the
 * scheme *and* the owner, arriving at the fragment loader as
 * `swarm://<owner>/bee/bytes/<ref>`; strip the scheme and what is left still carries the owner as
 * a path segment, so the request goes to `<origin>//<owner>/bee/bytes/<ref>` and a dev server
 * answers it with index.html. A URI that already carries a scheme is returned untouched instead.
 */
export function absoluteBytesBase(beeUrl: string, origin: string): string {
  return new URL(`${beeUrl.replace(/\/+$/, '')}/bytes`, origin).href;
}

export function parseSwarmUri(url: string): { owner: string; topic: string } {
  const path = url.startsWith(SWARM_SCHEME) ? url.slice(SWARM_SCHEME.length) : url;
  const [owner, topic] = path.split('/');
  return { owner, topic };
}

/**
 * The multivariant playlist for a ladder, built here rather than fetched.
 *
 * It is four URIs that never change, so putting it on Swarm would buy a fifth feed and no
 * information: the rung topics are already in the stream catalog, and the media playlists the
 * player actually consumes are synthesised locally too.
 *
 * No CODECS attribute — the uploader never sees the codec string, and hls.js takes it from the
 * first parsed fragment anyway. Omitting it is legal; guessing it would let hls.js discard a rung
 * that plays perfectly well.
 */
export function buildMasterPlaylist(owner: string, renditions: Rendition[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];

  for (const rendition of renditions) {
    const attributes = [
      `BANDWIDTH=${Math.round(rendition.bandwidth)}`,
      `AVERAGE-BANDWIDTH=${Math.round(rendition.avgBandwidth)}`,
      `RESOLUTION=${rendition.width}x${rendition.height}`,
    ];
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`);
    lines.push(buildSwarmUri(owner, rendition.topic));
  }

  return lines.join('\n') + '\n';
}

export function parseManifest(text: string): { headers: string[]; segments: Segment[]; isFinalized: boolean } {
  const lines = text.trim().split('\n');
  const headers: string[] = [];
  const segments: Segment[] = [];
  let isFinalized = false;
  let headersDone = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === HLS_ENDLIST) {
      isFinalized = true;
      continue;
    }

    if (line.startsWith(HLS_EXTINF)) {
      headersDone = true;
      const uri = lines[i + 1]?.trim();
      if (uri && !uri.startsWith('#')) {
        segments.push({ extinf: line, uri });
        i++;
      }
      continue;
    }

    if (!headersDone && line) {
      headers.push(line);
    }
  }

  return { headers, segments, isFinalized };
}
