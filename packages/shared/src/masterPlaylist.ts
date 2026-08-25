import { HLS_INDEPENDENT_SEGMENTS, HLS_M3U, HLS_STREAM_INF, HLS_VERSION } from './hlsTags.js';

/**
 * One rung of a stream's ABR ladder.
 *
 * `bandwidth` and `avgBandwidth` are measured from real segments rather than taken from the
 * encoder's configuration, and they are the entire supply-side input to a player's ABR decision.
 * See the uploader's `libs/BitrateMeter.ts`.
 *
 * `index` and `duration` are both set once the rung has been finalized as VOD.
 */
export interface Rendition {
  name: string;
  width: number;
  height: number;
  topic: string;
  /** Peak observed segment bitrate, bits/s. HLS's BANDWIDTH. */
  bandwidth: number;
  /** Mean bitrate so far, bits/s. HLS's AVERAGE-BANDWIDTH. */
  avgBandwidth: number;
  index?: number;
  duration?: number;
}

/**
 * The URI scheme feeds are addressed by, chosen for what hls.js does to a playlist's URIs rather
 * than for looks.
 *
 * Every URI in a playlist is resolved against the playlist's own URL through url-toolkit's
 * `buildAbsoluteURL`, and a URI carrying a scheme is the one case it returns untouched. Handing it
 * a bare `owner/topic` instead makes it treat the owner as a host and emit `owner/owner/topic`,
 * harmless while there is a single media playlist whose URL is never re-resolved and wrong the
 * moment a master playlist points at four of them.
 */
export const SWARM_SCHEME = 'swarm://';

export function buildSwarmUri(owner: string, topic: string): string {
  return `${SWARM_SCHEME}${owner}/${topic}`;
}

/** The inverse of {@link buildSwarmUri}, tolerant of the bare `owner/topic` form. */
export function parseSwarmUri(url: string): { owner: string; topic: string } {
  const path = url.startsWith(SWARM_SCHEME) ? url.slice(SWARM_SCHEME.length) : url;
  const [owner, topic] = path.split('/');
  return { owner, topic };
}

/**
 * A ladder's multivariant playlist: one `EXT-X-STREAM-INF` per rung, lowest first, each followed by
 * that rung's feed URI.
 *
 * ⛔ **One definition, because there are two producers.** The uploader publishes the master to a
 * feed of its own and the client builds the same text locally as a fallback for catalog entries
 * written before masters were published. Both used to carry their own copy of this function, each
 * with a comment saying the two had to keep producing identical text, which is the arrangement
 * ARCH-1 exists to remove: a viewer switching between the published master and the synthesised one
 * mid-session would otherwise see the ladder change shape.
 *
 * No CODECS attribute. The uploader never sees the codec string and hls.js takes it from the first
 * parsed fragment anyway, so omitting it is legal where guessing it would let hls.js discard a rung
 * that plays perfectly well.
 */
export function buildMasterPlaylist(owner: string, renditions: Rendition[]): string {
  const lines = [HLS_M3U, `${HLS_VERSION}:3`, HLS_INDEPENDENT_SEGMENTS];

  for (const rendition of renditions) {
    const attributes = [
      `BANDWIDTH=${Math.round(rendition.bandwidth)}`,
      `AVERAGE-BANDWIDTH=${Math.round(rendition.avgBandwidth)}`,
      `RESOLUTION=${rendition.width}x${rendition.height}`,
    ];
    lines.push(`${HLS_STREAM_INF}:${attributes.join(',')}`);
    lines.push(buildSwarmUri(owner, rendition.topic));
  }

  return lines.join('\n') + '\n';
}
