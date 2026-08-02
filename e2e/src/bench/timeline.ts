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
 * The first manifest published at or after `atMs`, which is the one that first carried that segment.
 *
 * `uploadLiveManifest` coalesces while a publish is in flight, so this manifest may also carry the
 * segments that landed during it. That does not disturb the reading: the question is when the
 * segment first became publishable, and the first publish after its upload is that instant however
 * many other segments rode along.
 */
export function firstManifestAtOrAfter(timeline: UploadTimeline, atMs: number): PublishedManifest | undefined {
  return timeline.manifests.find((manifest) => manifest.atMs >= atMs);
}

/** Re-exported so a caller reading a timeline does not also have to reach into the harness. */
export type { TimestampedMessage };
