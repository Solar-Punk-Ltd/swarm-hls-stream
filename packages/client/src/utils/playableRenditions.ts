import { Rendition, Stream, STREAM_STATUS_VOD } from '@/types/stream';

/**
 * The rungs of a catalog entry a viewer can be handed: every rung of a live ladder, and only the rungs
 * that have a recording once the ladder is one.
 *
 * ⛔ 2026-09-23: 1080p's postage batch refused its recording, so its ladder finished without it. The
 * uploader's own catalog entry then leaves that rung out of `renditions`. The admin's entry cannot, and
 * lists it without an index, over a feed whose last playlist is a live one that will never end. The
 * recording's master already names only the rungs that recorded, so nothing plays it, and this keeps
 * the player from walking that feed for as long as the recording is watched.
 */
export function playableRenditions(stream: Pick<Stream, 'state' | 'renditions'> | undefined): Rendition[] | undefined {
  const renditions = stream?.renditions;
  if (renditions === undefined || stream?.state !== STREAM_STATUS_VOD) {
    return renditions;
  }
  return renditions.filter((rendition) => rendition.index !== undefined);
}
