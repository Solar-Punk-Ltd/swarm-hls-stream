import {
  buildMasterPlaylist,
  buildSwarmUri,
  HLS_STREAM_INF,
  parseManifest,
  parseSwarmUri,
  type Segment,
} from '@swarm-hls-stream/shared';

/**
 * Playlist text and feed URIs — the pure half of the Swarm HLS loader.
 *
 * Kept apart from `ManifestManagement` so it can be exercised without a Bee node, a gateway URL or
 * a browser: this is the code that decides what hls.js actually parses, and getting a tag or a URI
 * wrong here fails as a mute player rather than as an error.
 *
 * What is *not* defined here lives in the shared package instead: the parser and the segment shape,
 * beside the tags the uploader builds a manifest with, and the master-playlist builder and the swarm
 * URI scheme, beside the uploader that publishes the master this one synthesises as a fallback. Both
 * halves of each contract are then one definition rather than two that promise to agree. They are
 * re-exported for the call sites that used to find them here. See ARCH-1.
 */

export { buildMasterPlaylist, buildSwarmUri, parseManifest, parseSwarmUri, type Segment };

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
