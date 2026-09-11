/**
 * Where a preview card gets its picture from, decided before anything is fetched.
 *
 * Extracted from the component for the same reason `previewSource.ts` was: `packages/client` runs
 * vitest with `environment: 'node'` and no jsdom, so a rule left inside the card is a rule nothing
 * covers, and the bug this exists to prevent was entirely in the branching.
 *
 * That bug: every card took its frame by fetching the stream's manifest feed and decoding its first
 * segment. A **scheduled** entry has no manifest feed at all — it is an announcement, and the topic
 * is not written to until the broadcast starts — so the probe is a guaranteed miss that costs a slot
 * on a queue of concurrency 1 and, on a build where the miss left the loading flag set, spun
 * forever. Meanwhile the image the broadcaster actually uploaded was ignored.
 */

import { STREAM_STATUS_SCHEDULED, StreamState } from '@/types/stream';

export type PreviewMode =
  /** The catalog carries a picture. Render it and fetch nothing else. */
  | 'image'
  /** No picture to render, so the frame has to come out of the stream's own first segment. */
  | 'probe'
  /** Nothing to render and nothing worth asking for. The default image, immediately. */
  | 'placeholder';

export interface PreviewEntry {
  /** A Swarm reference, or '' / absent on an entry whose publisher gave no image. */
  thumbnail?: string;
  state?: StreamState;
  /** Set once the browser has failed to load the referenced image, so the card can move on. */
  imageFailed?: boolean;
}

/**
 * ⛔ The rule this exists to hold: **a scheduled stream is never probed.** Not on first render, and
 * not as the fallback when its thumbnail turns out to be unfetchable. There is no manifest behind
 * the topic in either case, so a probe there can only end as a wasted queue slot and a placeholder,
 * which is exactly what this returns without spending the fetch.
 *
 * A live or finished stream does fall back to the probe, because its manifest is real and a broken
 * thumbnail reference is no reason to lose a frame the stream can still supply.
 */
export function previewMode({ thumbnail, state, imageFailed = false }: PreviewEntry): PreviewMode {
  if (!imageFailed && hasThumbnail(thumbnail)) {
    return 'image';
  }
  return state === STREAM_STATUS_SCHEDULED ? 'placeholder' : 'probe';
}

/** Absent and empty are the same answer: the publisher gave no image. */
function hasThumbnail(thumbnail: string | undefined): thumbnail is string {
  return typeof thumbnail === 'string' && thumbnail.trim().length > 0;
}

/**
 * Where the gateway serves a catalog entry's thumbnail.
 *
 * The trailing slash is not decoration: `/bzz/<ref>` without it is a redirect on a collection, and
 * the reference an uploader writes addresses the uploaded file's manifest rather than its bytes.
 *
 * ⭐ Encoded rather than interpolated raw. The catalog is JSON pulled off a feed and parsed
 * unchecked, so this field is external input however trusted its author, and a value carrying `../`
 * or a query would otherwise address a path on the gateway that this URL never meant to name. A real
 * reference is hex, which encoding leaves untouched.
 */
export function thumbnailImageUrl(gatewayUrl: string, thumbnail: string): string {
  return `${gatewayUrl}/bzz/${encodeURIComponent(thumbnail.trim())}/`;
}
