/**
 * When the uploader did each thing to a segment, from its own log.
 *
 * `logwatch.ts` counts these events, which answers what happened. The bench needs when, so this
 * reads the same lines through `timestampedMessages` and keeps the instant.
 *
 * **Every instant here is on the uploader host's clock, not the bench's.** Nothing in this module
 * corrects for that; `split.ts` takes a measured skew and says which hops it moves between.
 */

import { type TimestampedMessage, timestampedMessages } from '../harness/logwatch.js';

/**
 * `Segment 41 uploaded: <64 hex>` — the payload reached Swarm.
 *
 * Anchored to the whole message, which nothing the uploader prints today makes load-bearing: the
 * three failure paths that also name a segment say `segment` in lower case, so an unanchored pattern
 * excludes them too. Kept anchored because the safe failure here is the loud one — the bench looks
 * up one specific reference and says so when the log does not hold it, whereas a pattern that
 * matched too much would attribute a stranger's timestamp to the measured segment.
 */
const RE_SEGMENT_UPLOADED = /^Segment (\d+) uploaded: ([0-9a-f]+)$/;
/** `Manifest uploaded at SOC index 12` — the feed write returned. */
const RE_MANIFEST_PUBLISHED = /^Manifest uploaded at SOC index (\d+)$/;

export interface UploadedSegment {
  index: number;
  /** Swarm reference of the payload, which is how a manifest entry names it. */
  ref: string;
  atMs: number;
}

export interface PublishedManifest {
  socIndex: number;
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
      segments.push({ index: Number(uploaded[1]), ref: uploaded[2], atMs: line.atMs });
      continue;
    }
    const published = RE_MANIFEST_PUBLISHED.exec(line.message);
    if (published) {
      manifests.push({ socIndex: Number(published[1]), atMs: line.atMs });
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
 */
export function segmentByRef(timeline: UploadTimeline, ref: string): UploadedSegment | undefined {
  return timeline.segments.find((segment) => segment.ref === ref);
}

/**
 * The first manifest published at or after `atMs`. **A lower bound on when that segment became
 * publishable, not the instant itself.**
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
export function firstManifestAtOrAfter(timeline: UploadTimeline, atMs: number): PublishedManifest | undefined {
  return timeline.manifests.find((manifest) => manifest.atMs >= atMs);
}

/** Re-exported so a caller reading a timeline does not also have to reach into the harness. */
export type { TimestampedMessage };
