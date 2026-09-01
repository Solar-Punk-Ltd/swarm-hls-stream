/**
 * When the uploader did each thing to a segment, from its own log.
 *
 * `logwatch.ts` counts these events, which answers what happened. The bench needs when, so this
 * reads the same lines through `timestampedMessages` and keeps the instant.
 *
 * **Every instant here is on the uploader host's clock, not the bench's.** Nothing in this module
 * corrects for that; `split.ts` takes a measured skew and says which hops it moves between.
 */

import { manifestUploadedPattern, segmentUploadedPattern } from '@swarm-hls-stream/shared';

import { type TimestampedMessage, timestampedMessages } from '../harness/logwatch.js';

/**
 * `Segment 41 of live/stream_720p uploaded: <ref>`. The payload reached Swarm.
 *
 * Derived from the composer rather than written out, for the same reason the manifest pattern below
 * is. A hand-written copy goes silently empty the moment the message is reworded, and this one did:
 * it held the pre-ladder `Segment N uploaded: <hex>` shape from 2026-08-27 to 2026-09-01, so every
 * bench run in between read zero segments and measured no capture-to-fetchable latency at all, with
 * nothing thrown and nothing logged.
 *
 * Anchored to the whole message, which nothing the uploader prints today makes load-bearing: the
 * three failure paths that also name a segment say `segment` in lower case, so an unanchored pattern
 * excludes them too. Kept anchored because the safe failure here is the loud one. The bench looks up
 * one specific reference and says so when the log does not hold it, whereas a pattern that matched
 * too much would attribute a stranger's timestamp to the measured segment.
 */
const RE_SEGMENT_UPLOADED = new RegExp(`^${segmentUploadedPattern().source}$`);
/**
 * `Manifest of live/stream_720p uploaded at SOC index 12` — the feed write returned.
 *
 * Derived from the composer rather than written out, so a reworded message cannot leave this reader
 * silently matching nothing. Anchored for the same reason as the segment pattern above.
 */
const RE_MANIFEST_PUBLISHED = new RegExp(`^${manifestUploadedPattern().source}$`);

export interface UploadedSegment {
  /** The rung's own playlist position. A ladder counts four of these independently from zero. */
  index: number;
  /** Which rung uploaded it, so an index and a manifest can both be read against the right one. */
  streamId: string;
  /** Swarm reference of the payload, which is how a manifest entry names it. */
  ref: string;
  atMs: number;
}

export interface PublishedManifest {
  socIndex: number;
  /** Which rung published it. A ladder is four independent SOC counters interleaved in one log. */
  streamId: string;
  atMs: number;
}

export interface UploadTimeline {
  segments: UploadedSegment[];
  manifests: PublishedManifest[];
}

export function uploadTimeline(logText: string): UploadTimeline {
  const segments: UploadedSegment[] = [];
  const manifests: PublishedManifest[] = [];

  for (const line of timestampedMessages(logText)) {
    const uploaded = RE_SEGMENT_UPLOADED.exec(line.message);
    if (uploaded) {
      // ⚠️ The two group orders below are reverses of each other, because each follows the words of
      // its own message: the segment line names the index first, the manifest line names the stream.
      segments.push({ index: Number(uploaded[1]), streamId: uploaded[2], ref: uploaded[3], atMs: line.atMs });
      continue;
    }
    const published = RE_MANIFEST_PUBLISHED.exec(line.message);
    if (published) {
      manifests.push({ socIndex: Number(published[2]), streamId: published[1], atMs: line.atMs });
    }
  }

  return { segments, manifests };
}

/**
 * The upload of the segment a manifest entry points at.
 *
 * Keyed on the reference rather than the index, because the index is the engine's playlist position
 * and repeats across streams, while the reference is content-addressed and is what the bench actually
 * fetched. Matching on an index would silently pair a measurement with a previous broadcast's upload.
 *
 * A ladder does not change that, which is worth stating because it is the one thing that could. Four
 * rungs put four segments under every index into one log, so an index-keyed lookup would have four
 * candidates for each. A reference picks one of them out, because the rungs encode video at different
 * bitrates and so never produce the same bytes.
 *
 * ⚠️ One shape escapes that, and it is real rather than theoretical. The ladder ships
 * `ABR_ACODEC=copy`, so the audio in all four rungs is bit-identical, and a segment holding no video
 * at all is therefore one payload under one reference. `find` returns the earliest of those lines, so
 * the instant belongs to whichever rung uploaded first rather than to the rung the bench is
 * following. `videolessSegments` in the harness is what reports such a segment happened.
 */
export function segmentByRef(timeline: UploadTimeline, ref: string): UploadedSegment | undefined {
  return timeline.segments.find((segment) => segment.ref === ref);
}

/**
 * The first manifest **that rung** published at or after `atMs`. **A lower bound on when that
 * segment became publishable, not the instant itself.**
 *
 * Scoped to one rung, and it has to be. A ladder publishes four independent manifests, so the next
 * publish after any upload usually belongs to a different rung, and another rung's feed write says
 * nothing about when this segment became fetchable. Unscoped, `manifestPublish` would report the gap
 * to whichever rung happened to write next, which shrinks towards zero as rungs are added. On a
 * single-rendition deployment the filter matches everything and changes nothing.
 *
 * An earlier version of this called it the manifest that first carried the segment, and said that
 * coalescing only meant extra segments might ride along. The real risk runs the other way, and it is
 * provable from the uploader rather than from this log: `StreamUploader.uploadLiveManifest` calls
 * `buildLiveManifest()` and then awaits `commitManifest`, and the log line follows the commit. So a
 * publish already in flight when a segment lands completes after that segment's upload while naming
 * only what existed when it was built. This function returns that publish, and the one that actually
 * carries the segment is the next.
 *
 * The window is the duration of a feed write against the segment cadence, which the first real run
 * measured at 208ms against 2s, so roughly one segment in ten is exposed.
 *
 * What that costs is bounded and is not the total. `manifestPublishedAtMs` enters the split once
 * positively and once negatively, in `manifestPublish` and in `feedPropagation`, so attributing it a
 * publish early moves time from the second row into the first and leaves their sum, and every total,
 * exactly where it was. Read those two rows as one number. Closing this properly needs the uploader
 * to say which segments a manifest carried, which is a change to the uploader and not to the bench.
 */
export function firstManifestAtOrAfter(
  timeline: UploadTimeline,
  streamId: string,
  atMs: number,
): PublishedManifest | undefined {
  return timeline.manifests.find((manifest) => manifest.streamId === streamId && manifest.atMs >= atMs);
}

/** Re-exported so a caller reading a timeline does not also have to reach into the harness. */
export type { TimestampedMessage };
