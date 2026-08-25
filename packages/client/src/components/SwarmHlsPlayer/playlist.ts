import { HLS_STREAM_INF, parseManifest, type Segment } from '@swarm-hls-stream/shared';

import type { Rendition } from '@/types/stream';

/**
 * Playlist text and feed URIs — the pure half of the Swarm HLS loader.
 *
 * Kept apart from `ManifestManagement` so it can be exercised without a Bee node, a gateway URL or
 * a browser: this is the code that decides what hls.js actually parses, and getting a tag or a URI
 * wrong here fails as a mute player rather than as an error.
 *
 * The parser and the segment shape are not defined here. They live in the shared package beside the
 * tags the uploader builds a manifest with, so the two halves of the manifest contract cannot drift
 * apart, and they are re-exported for the call sites that used to find them in this module. See
 * ARCH-1.
 */

export { parseManifest, type Segment };

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
 * Whether a feed answered with a multivariant playlist rather than a media playlist.
 *
 * This is how a ladder is recognised, in preference to a flag on the catalog entry: it works on a
 * deep link with no catalog read behind it, and it cannot disagree with the playlist it describes.
 */
export function isMasterPlaylist(text: string): boolean {
  return text.includes(HLS_STREAM_INF);
}

/**
 * The variant feeds a master points at, in the order it lists them.
 *
 * Read off the master rather than out of the catalog, because these are the feeds hls.js will
 * actually request — polling any other set would leave the rungs it asks for un-walked while
 * keeping ones it never touches at the live edge. The owner comes from the URIs for the same
 * reason: the master is what says where its own variants live.
 */
export function masterVariants(text: string): { owner: string; topic: string }[] {
  const lines = text.trim().split('\n');
  const variants: { owner: string; topic: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith(HLS_STREAM_INF)) {
      continue;
    }

    const uri = lines[i + 1]?.trim();
    if (!uri || uri.startsWith('#')) {
      continue;
    }

    const variant = parseSwarmUri(uri);
    if (variant.owner && variant.topic) {
      variants.push(variant);
    }
    i++;
  }

  return variants;
}

/**
 * A ladder's multivariant playlist, built locally instead of fetched.
 *
 * The uploader publishes the real one to a feed of its own, and that is what a session normally
 * reads — see `libs/MasterPlaylist.ts` in the stream-uploader, whose output this must match. This
 * copy is the fallback for a catalog entry written before masters were published, whose `topic`
 * points at the lowest rung: without it such a stream would play as a single rendition forever.
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
