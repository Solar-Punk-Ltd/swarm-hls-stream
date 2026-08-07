/**
 * Every request the viewer's browser made, and what it says about why the picture froze.
 *
 * The session measured on 2026-08-05 joined at its configured buffer and then drained to nothing,
 * spending 12-17% of the wall clock frozen, with the publisher ruled out by measurement. That leaves
 * the path between the gateway and the player, and there are two candidate explanations that a
 * summary of latencies cannot tell apart:
 *
 * - **The player is waiting, not downloading.** Segments nearest the live edge are sometimes refused
 *   with a 404 until they propagate, and hls.js waits `fragLoadPolicy.errorRetry.retryDelayMs`,
 *   which is **1000ms**, before asking again. At a 0.267s segment that is about four segments of
 *   airtime lost per refusal, so a handful an minute would starve a six-second buffer on its own.
 * - **The player is downloading, slowly.** The gateway serves everything it is asked for, and simply
 *   cannot sustain the ~3.75 segments a second this profile needs.
 *
 * The two produce the same stall and opposite fixes. What separates them is not the total time but
 * **where it went**: time between a refusal and the next ask, against time spent inside a transfer.
 * Both come straight out of the request log, so this module records timings per request and the
 * analysis below splits them.
 */

/** A gateway refusal, which here means the chunk has not propagated yet rather than that it is lost. */
export const NOT_RETRIEVABLE_YET = 404;

export interface RequestRecord {
  url: string;
  /** Null when the request failed outright rather than returning a status. */
  status: number | null;
  startedAtMs: number;
  endedAtMs: number;
  bytes: number;
}

/** Segment bodies come from the gateway's `/bytes/` route; feed and manifest reads do not. */
export function isSegmentRequest(url: string): boolean {
  return url.includes('/bytes/');
}

/**
 * The part of a `/bytes/` URL that names the chunk.
 *
 * Used to group attempts at the same segment, so a refusal and the ask that finally worked can be
 * recognised as one segment rather than two requests.
 */
export function segmentRef(url: string): string {
  return url.split('/bytes/')[1]?.split(/[?#]/)[0] ?? url;
}

export interface RefusedSegment {
  ref: string;
  attempts: number;
  /** From the first refusal to the ask that succeeded, or to the last attempt if none did. */
  refusedForMs: number;
  /** Wall time the player spent doing nothing about this segment between attempts. */
  waitedBetweenAttemptsMs: number;
  served: boolean;
}

/**
 * Group the request log by segment and describe the ones that were refused at least once.
 *
 * `waitedBetweenAttemptsMs` is the number the hypothesis lives or dies on. It is the sum of the gaps
 * between one attempt ending and the next starting, so it excludes transfer time entirely: if it
 * lands near a multiple of 1000ms, the player was sitting on hls.js's retry delay, and no amount of
 * gateway throughput would have helped.
 */
export function refusedSegments(records: readonly RequestRecord[]): RefusedSegment[] {
  const byRef = new Map<string, RequestRecord[]>();
  for (const record of records) {
    if (!isSegmentRequest(record.url)) {
      continue;
    }
    const ref = segmentRef(record.url);
    byRef.set(ref, [...(byRef.get(ref) ?? []), record]);
  }

  return [...byRef.entries()]
    .filter(([, attempts]) => attempts.some((attempt) => attempt.status === NOT_RETRIEVABLE_YET))
    .map(([ref, unsorted]) => {
      const attempts = [...unsorted].sort((a, b) => a.startedAtMs - b.startedAtMs);
      const firstRefusal = attempts.find((attempt) => attempt.status === NOT_RETRIEVABLE_YET)!;
      const served = attempts.find((attempt) => attempt.status === 200);
      const last = attempts[attempts.length - 1];

      const waitedBetweenAttemptsMs = attempts
        .slice(1)
        .reduce((total, attempt, i) => total + Math.max(0, attempt.startedAtMs - attempts[i].endedAtMs), 0);

      return {
        ref,
        attempts: attempts.length,
        refusedForMs: (served ?? last).endedAtMs - firstRefusal.startedAtMs,
        waitedBetweenAttemptsMs,
        served: served !== undefined,
      };
    });
}

export interface NetworkSummary {
  spanMs: number;
  segmentRequests: number;
  distinctSegments: number;
  refusals: number;
  /** Share of segment *requests* answered 404, which is not the share of segments affected. */
  refusalShare: number;
  segmentsRefusedAtLeastOnce: number;
  segmentsNeverServed: number;
  /** Median duration of a successful segment transfer. High means the gateway is the cost. */
  medianTransferMs: number;
  /** Total wall time lost sitting between a refusal and the next ask. High means the retry delay is. */
  totalWaitedBetweenAttemptsMs: number;
  segmentBytesPerSecond: number;
  /**
   * Segment bytes that actually arrived, summed over served requests.
   *
   * The rate above is this divided by the run's span, which makes it a property of the run's length
   * as well as of the stream. The total is what a cost is paid against, so it is reported separately
   * rather than left to be multiplied back out.
   */
  segmentBytesDelivered: number;
  maxConcurrent: number;
}

export function summarizeNetwork(records: readonly RequestRecord[]): NetworkSummary {
  const segments = records.filter((record) => isSegmentRequest(record.url));
  const served = segments.filter((record) => record.status === 200);
  const refused = refusedSegments(records);

  const spanMs =
    records.length > 0
      ? Math.max(...records.map((r) => r.endedAtMs)) - Math.min(...records.map((r) => r.startedAtMs))
      : 0;
  const segmentBytes = served.reduce((total, record) => total + record.bytes, 0);

  return {
    spanMs,
    segmentRequests: segments.length,
    distinctSegments: new Set(segments.map((record) => segmentRef(record.url))).size,
    refusals: segments.filter((record) => record.status === NOT_RETRIEVABLE_YET).length,
    refusalShare:
      segments.length > 0 ? segments.filter((r) => r.status === NOT_RETRIEVABLE_YET).length / segments.length : 0,
    segmentsRefusedAtLeastOnce: refused.length,
    segmentsNeverServed: refused.filter((segment) => !segment.served).length,
    medianTransferMs: median(served.map((record) => record.endedAtMs - record.startedAtMs)),
    totalWaitedBetweenAttemptsMs: refused.reduce((total, segment) => total + segment.waitedBetweenAttemptsMs, 0),
    segmentBytesPerSecond: spanMs > 0 ? (segmentBytes * 1000) / spanMs : 0,
    segmentBytesDelivered: segmentBytes,
    maxConcurrent: maxOverlap(segments),
  };
}

/**
 * The most segment requests in flight at once.
 *
 * A player that never exceeds one or two is serialised somewhere, and would starve on latency alone
 * however fast each individual transfer was.
 */
function maxOverlap(records: readonly RequestRecord[]): number {
  const edges = records.flatMap((record) => [
    { at: record.startedAtMs, delta: 1 },
    { at: record.endedAtMs, delta: -1 },
  ]);
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let current = 0;
  let most = 0;
  for (const edge of edges) {
    current += edge.delta;
    most = Math.max(most, current);
  }
  return most;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
