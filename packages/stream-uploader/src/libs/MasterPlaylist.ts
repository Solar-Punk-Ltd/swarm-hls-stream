import { Rendition } from '../types.js';

/**
 * The multivariant playlist for a ladder, as the uploader publishes it to Swarm.
 *
 * This is the authoritative copy. The client has a builder of its own
 * (`components/SwarmHlsPlayer/playlist.ts`) which it uses only as a fallback for catalog entries
 * written before masters were published — the two must keep producing the same text, because a
 * viewer switching between the published master and the synthesised one mid-session would
 * otherwise see the ladder change shape.
 */

/**
 * The URI scheme variants are addressed by, chosen for what hls.js does to a playlist's URIs
 * rather than for looks.
 *
 * Every URI in a playlist is resolved against the playlist's own URL through url-toolkit's
 * `buildAbsoluteURL`, and a URI carrying a scheme is the one case it returns untouched. A bare
 * `owner/topic` would instead be read as host-plus-path and come back out as `owner/owner/topic`.
 */
export const SWARM_SCHEME = 'swarm://';

export function buildSwarmUri(owner: string, topic: string): string {
  return `${SWARM_SCHEME}${owner}/${topic}`;
}

/**
 * One `EXT-X-STREAM-INF` per rung, lowest first, each followed by that rung's feed URI.
 *
 * No CODECS attribute: the uploader never sees the codec string, and hls.js takes it from the
 * first parsed fragment anyway. Omitting it is legal; guessing it would let hls.js discard a rung
 * that plays perfectly well.
 *
 * `BANDWIDTH` is the whole supply-side input to a player's ABR decision, which is why it is
 * measured rather than copied from the encoder's target — see {@link ../libs/BitrateMeter.js}.
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
