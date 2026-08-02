/**
 * Where the latency of one segment went, split the way sprint task S5.1 asks for it.
 *
 * Two clocks feed this. The bench's own clock stamps capture and fetch, because the publisher and the
 * fetch both run here; the uploader host's clock stamps the two log lines in between. That split is
 * unavoidable and it is also survivable, for a reason worth stating precisely:
 *
 * **The skew cancels in the total and only moves time between two adjacent hops.** Write the hops out
 * and the host-clock instants appear once positively and once negatively, so `upload` and
 * `feedPropagation` shift against each other by exactly the skew while their sum, and therefore the
 * total, does not move. A skew estimate that is wrong by a second misplaces a second between those
 * two rows and leaves every other number in the report untouched.
 *
 * So the total is the trustworthy figure, `segment`, `manifestPublish` and `fetch` are each bounded
 * by one clock, and the two cross-clock rows carry the skew's uncertainty. `hopsCrossingClocks`
 * names them rather than leaving a reader to work out which.
 */

import { LIVE_SYNC_DURATION_S } from './clientTuning.js';

/** Every instant one measured segment passed through, each on the clock named in its comment. */
export interface SegmentInstants {
  /** Bench clock. When the segment's first frame was captured, recovered from its presentation timestamp. */
  capturedAtMs: number;
  /** Seconds of media the segment holds, from its `#EXTINF`. */
  segmentDurationS: number;
  /** Uploader host clock. `Segment N uploaded`, so the payload had reached Swarm. */
  uploadedAtMs: number;
  /** Uploader host clock. The first `Manifest uploaded at SOC index N` at or after the upload. */
  manifestPublishedAtMs: number;
  /** Bench clock. The first gateway poll whose manifest named this segment. */
  visibleAtMs: number;
  /** Bench clock. When the segment's bytes finished downloading from the gateway. */
  fetchedAtMs: number;
}

/**
 * How far the uploader host's clock runs ahead of the bench's.
 *
 * Estimated the way NTP does at its simplest: read the remote clock between two local readings and
 * assume the round trip was symmetric. `uncertaintyMs` is half that round trip, which is the bound on
 * how wrong the estimate can be, and it applies to the two cross-clock hops only.
 */
export interface ClockSkew {
  offsetMs: number;
  uncertaintyMs: number;
}

export const HOP_SEGMENT = 'segment';
export const HOP_UPLOAD = 'upload';
export const HOP_MANIFEST_PUBLISH = 'manifestPublish';
export const HOP_FEED_PROPAGATION = 'feedPropagation';
export const HOP_FETCH = 'fetch';

export type HopName =
  | typeof HOP_SEGMENT
  | typeof HOP_UPLOAD
  | typeof HOP_MANIFEST_PUBLISH
  | typeof HOP_FEED_PROPAGATION
  | typeof HOP_FETCH;

/** The two hops bounded by instants from different clocks, so the two the skew moves between. */
export const HOPS_CROSSING_CLOCKS: readonly HopName[] = [HOP_UPLOAD, HOP_FEED_PROPAGATION];

export interface Hop {
  name: HopName;
  ms: number;
  /** What this hop covers, in an operator's terms, for the report. */
  what: string;
}

export interface LatencySplit {
  /** Capture to fetch, on one clock. The figure a later sprint is measured against. */
  totalMs: number;
  hops: readonly Hop[];
  /** The configured player buffer, added to the total for what a viewer experiences. Not measured. */
  playerBufferMs: number;
  /** Total plus the player buffer: how far behind live a viewer of this stream sits. */
  viewerLatencyMs: number;
  skew: ClockSkew;
}

/**
 * A hop that came out negative, which is the report's own warning light.
 *
 * Time cannot run backwards between two stages, so a negative row means an input is wrong rather than
 * a pipeline that is fast: a skew estimate taken across a slow link, or a log line paired with the
 * wrong segment. Returned as data rather than thrown, because the total is still valid when this
 * happens and refusing to report it would discard the one number that is.
 */
export function impossibleHops(split: LatencySplit): readonly Hop[] {
  return split.hops.filter((hop) => hop.ms < 0);
}

export function latencySplit(instants: SegmentInstants, skew: ClockSkew): LatencySplit {
  const segmentMs = instants.segmentDurationS * 1_000;
  // Host-clock instants brought onto the bench's clock, which is the clock the total is measured on.
  const uploadedHere = instants.uploadedAtMs - skew.offsetMs;
  const manifestPublishedHere = instants.manifestPublishedAtMs - skew.offsetMs;
  const segmentCompleteAtMs = instants.capturedAtMs + segmentMs;

  const hops: Hop[] = [
    {
      name: HOP_SEGMENT,
      ms: segmentMs,
      what: 'the first frame waiting for its own segment to close at the encoder',
    },
    {
      name: HOP_UPLOAD,
      ms: uploadedHere - segmentCompleteAtMs,
      what: 'the uploader noticing the segment, downloading it from the engine, and uploading it to Swarm',
    },
    {
      name: HOP_MANIFEST_PUBLISH,
      ms: instants.manifestPublishedAtMs - instants.uploadedAtMs,
      what: 'the SOC feed write that publishes a manifest naming it',
    },
    {
      name: HOP_FEED_PROPAGATION,
      ms: instants.visibleAtMs - manifestPublishedHere,
      what: 'the manifest reaching the viewer gateway, plus the wait until the next poll asked for it',
    },
    {
      name: HOP_FETCH,
      ms: instants.fetchedAtMs - instants.visibleAtMs,
      what: 'retrieving the segment payload itself through the gateway',
    },
  ];

  const playerBufferMs = LIVE_SYNC_DURATION_S * 1_000;
  const totalMs = instants.fetchedAtMs - instants.capturedAtMs;

  return {
    totalMs,
    hops,
    playerBufferMs,
    viewerLatencyMs: totalMs + playerBufferMs,
    skew,
  };
}
