/**
 * One latency run against a deployed stack: publish, watch the feed a viewer would watch, and time
 * the first frame of each segment from capture to fetchable.
 *
 * Ordering matters and is the reason this reads the way it does. The publisher starts before anything
 * is polled, the log is read once at the end rather than per sample, and the clock skew is taken
 * before the publish so a run cannot spend minutes and then fail on a `date` that does not support
 * milliseconds.
 */

import { Topic } from '@ethersphere/bee-js';
import { parseManifest, segmentDuration } from '@swarm-hls-stream/shared';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { containerName, type E2EConfig } from '../config.js';
import type { FfmpegExit } from '../harness/ffmpegProcess.js';
import { type Host, waitForIdle } from '../harness/host.js';
import { announcedLiveStreams } from '../harness/logwatch.js';
import { sleep, waitFor } from '../harness/wait.js';

import { measureClockSkew } from './clockSkew.js';
import {
  FEED_BLACKOUT_LIMIT_MS,
  fetchFeedManifest,
  fetchSegment,
  isFeedBlackout,
  isFeedPendingFirstWrite,
  segmentRefFromUri,
} from './gateway.js';
import type { FeedPoll } from './longRun.js';
import { probeSegment } from './probe.js';
import { type BenchRun, type DiscardedSegment, latencyTrend, type SegmentSample } from './report.js';
import { latencySplit, type SegmentInstants } from './split.js';
import { firstManifestAtOrAfter, segmentByRef, uploadTimeline } from './timeline.js';
import { captureInstantMs, latencyMsFromPts } from './wallclock.js';
import { type PublishKnobs, startWallclockPublisher, type WallclockPublisher } from './wallclockPublisher.js';

/** How long to wait for the uploader to announce the stream this run just started publishing. */
const ANNOUNCE_TIMEOUT_MS = 90_000;
/** How long to wait for one more unmeasured segment to appear in the feed. */
const SEGMENT_TIMEOUT_MS = 120_000;

export interface RunOptions {
  cfg: E2EConfig;
  host: Host;
  /** Where a viewer's gateway is, reachable from **this** machine. See `gateway.ts`. */
  gatewayUrl: string;
  knobs: PublishKnobs;
  /** How many distinct segments to carry end to end. */
  samples: number;
  /**
   * Stop collecting once the publish has been running this long, whichever comes first with `samples`.
   *
   * Defaults to `SEGMENT_TIMEOUT_MS` per requested sample, which is the deadline a short run needs to
   * fail rather than hang. A long run sets both: a duration it wants, and a sample count high enough
   * that the duration is what ends it.
   */
  collectForMs?: number;
  /** How often to ask the feed for a new manifest, standing in for the client's own poll. */
  pollIntervalMs: number;
  /**
   * How far the publisher's timestamps run ahead of wall clock, from this run's own self-check.
   *
   * Required rather than defaulted to zero. A default would let a caller that forgot it produce a
   * report that looks complete and reads 1.4 seconds fast, which is the failure this whole quantity
   * exists to end. See `measureMediaTimelineLead`.
   */
  mediaTimelineLeadMs: number;
}

/** Everything one segment contributed, before the uploader's log is read to fill in the middle. */
interface PendingSample {
  ref: string;
  segmentDurationS: number;
  /** What the manifest declared, or null where the entry carried no readable `#EXTINF`. */
  declaredDurationS: number | null;
  videoPacketCount: number;
  capturedAtMs: number;
  visibleAtMs: number;
  fetchedAtMs: number;
}

export async function measureLatency(options: RunOptions): Promise<BenchRun> {
  const { cfg, host, knobs } = options;
  const uploader = containerName(cfg, 'stream-uploader');

  await waitForIdle(host, cfg);
  // Taken before the publish so every log read below is scoped to this run and cannot pick up a
  // previous stream's segments out of the same `docker logs` tail.
  const sinceIso = await host.nowIso();
  const skew = await measureClockSkew(host);

  const publisher = startWallclockPublisher(cfg, knobs);
  let pending: PendingSample[] = [];
  let discarded: DiscardedSegment[] = [];
  let feedPolls: FeedPoll[] = [];
  try {
    const stream = await waitForAnnouncement(host, uploader, sinceIso, publisher);
    const topicHex = Topic.fromString(stream.topic).toString();
    ({
      collected: pending,
      discarded,
      feedPolls,
    } = await collectSamples(options, stream.owner, topicHex, publisher.startedAtMs));
  } finally {
    await publisher.stop();
  }

  const timeline = uploadTimeline(await host.logsSince(uploader, sinceIso));
  const samples = pending.map((sample) => toSample(sample, timeline, skew));

  return {
    measuredAt: new Date().toISOString(),
    engine: cfg.engine,
    profile: cfg.profile,
    knobs,
    samples,
    discarded,
    feedPolls,
    mediaTimelineLeadMs: options.mediaTimelineLeadMs,
    trend: latencyTrend(
      pending.map((sample) => sample.fetchedAtMs),
      pending.map((sample) => sample.capturedAtMs),
    ),
  };
}

function toSample(
  pending: PendingSample,
  timeline: ReturnType<typeof uploadTimeline>,
  skew: Parameters<typeof latencySplit>[1],
): SegmentSample {
  const uploaded = segmentByRef(timeline, pending.ref);
  if (!uploaded) {
    throw new Error(
      `the uploader's log holds no "Segment N uploaded: ${pending.ref}" line, though the gateway served ` +
        'that segment. Either the deployment is not logging at a level that prints it, or the log ' +
        'window read here does not reach back to when it was uploaded.',
    );
  }
  const manifest = firstManifestAtOrAfter(timeline, uploaded.atMs);
  if (!manifest) {
    throw new Error(
      `segment ${uploaded.index} uploaded but no manifest publish follows it in the log, so the feed ` +
        'write that made it visible cannot be timed.',
    );
  }

  const instants: SegmentInstants = {
    capturedAtMs: pending.capturedAtMs,
    segmentDurationS: pending.segmentDurationS,
    uploadedAtMs: uploaded.atMs,
    manifestPublishedAtMs: manifest.atMs,
    visibleAtMs: pending.visibleAtMs,
    fetchedAtMs: pending.fetchedAtMs,
  };

  return {
    index: uploaded.index,
    ref: pending.ref,
    split: latencySplit(instants, skew),
    declaredDurationS: pending.declaredDurationS,
    videoPacketCount: pending.videoPacketCount,
  };
}

/**
 * Wait for the uploader to announce the stream this run just started publishing.
 *
 * Checks whether the publisher is still alive on every poll, rather than only at the deadline. A
 * publisher that failed to spawn or died on its arguments is knowable in the first two seconds, and
 * without this the run spends the full ninety waiting for something that can no longer happen, then
 * reports a timeout when what it had was an encoder that never started.
 */
async function waitForAnnouncement(host: Host, uploader: string, sinceIso: string, publisher: WallclockPublisher) {
  const ffmpegSaid = () => publisher.stderr().trim().slice(0, 300) || '(nothing)';
  let announced: ReturnType<typeof announcedLiveStreams>[number] | undefined;
  await waitFor(
    async () => {
      const exit = publisher.exit();
      if (exit) {
        throw new Error(
          `the publisher exited (${describeExit(exit)}) before the uploader announced a live stream, so ` +
            `nothing was ever ingested. ffmpeg said: ${ffmpegSaid()}`,
        );
      }
      announced = announcedLiveStreams(await host.logsSince(uploader, sinceIso)).at(-1);
      return announced !== undefined;
    },
    {
      timeoutMs: ANNOUNCE_TIMEOUT_MS,
      intervalMs: 2_000,
      label: `the uploader announcing a live stream. ffmpeg said: ${ffmpegSaid()}`,
    },
  );
  return announced!;
}

function describeExit(exit: FfmpegExit): string {
  if (exit.signal !== null) {
    return `on ${exit.signal}`;
  }
  return exit.code === null ? 'without ever starting' : `with status ${exit.code}`;
}

/**
 * Poll the feed the way a player does, and carry each newly-appearing segment end to end.
 *
 * The newest entry is taken rather than the whole window, because the question is how far behind live
 * a viewer is: an older entry in the same manifest has been fetchable for longer and would report a
 * latency that is really its age.
 */
async function collectSamples(
  options: RunOptions,
  owner: string,
  topicHex: string,
  publishStartedAtMs: number,
): Promise<{ collected: PendingSample[]; discarded: DiscardedSegment[]; feedPolls: FeedPoll[] }> {
  const { gatewayUrl, samples: wanted, pollIntervalMs } = options;
  const collected: PendingSample[] = [];
  const discarded: DiscardedSegment[] = [];
  // Every completed read, not only the ones that yielded a sample. A gap in the samples is either
  // the feed not advancing or this loop not asking, and without the polls that never yielded
  // anything the two are the same shape. See `feedProgress`.
  const feedPolls: FeedPoll[] = [];
  const seen = new Set<string>();
  const deadline = Date.now() + (options.collectForMs ?? SEGMENT_TIMEOUT_MS * wanted);

  // Separate from the collection deadline, and shorter than a long run's. A feed that never appears
  // is knowable in two minutes, and waiting out a half-hour collection window to say so would report
  // the uploader never writing as a run that measured nothing.
  const firstWriteDeadline = Date.now() + SEGMENT_TIMEOUT_MS;
  let feedSeen = false;
  let lastFeedSuccessAtMs = Date.now();

  while (collected.length < wanted && Date.now() <= deadline) {
    let manifest;
    try {
      manifest = await fetchFeedManifest(gatewayUrl, owner, topicHex);
    } catch (error) {
      if (!feedSeen) {
        if (!isFeedPendingFirstWrite(error, feedSeen) || Date.now() > firstWriteDeadline) {
          throw error;
        }
        await sleep(pollIntervalMs);
        continue;
      }

      // A poll that failed is a poll that found nothing, and recording it is the whole point of
      // `feedPolls`. Throwing here instead discarded every sample the run had already paid a real
      // broadcast for, and it was triggered by the effect under study: a feed poll slow enough to
      // exceed the timeout is the strongest sample of LAT-10 there is. See `isFeedBlackout`.
      feedPolls.push({ atMs: Date.now(), newestRef: null, resolvedIndex: null });
      if (isFeedBlackout(Date.now() - lastFeedSuccessAtMs)) {
        throw new Error(
          `no feed poll has succeeded at ${gatewayUrl} for ${FEED_BLACKOUT_LIMIT_MS}ms, so this is the ` +
            `gateway being gone rather than the feed being slow. Last error: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await sleep(pollIntervalMs);
      continue;
    }
    feedSeen = true;
    lastFeedSuccessAtMs = manifest.atMs;

    const newest = parseManifest(manifest.body).segments.at(-1);
    const ref = newest ? segmentRefFromUri(newest.uri) : null;
    feedPolls.push({ atMs: manifest.atMs, newestRef: ref, resolvedIndex: manifest.resolvedIndex });
    if (!newest || !ref || seen.has(ref)) {
      await sleep(pollIntervalMs);
      continue;
    }
    seen.add(ref);

    // One unreadable segment loses that segment and nothing else. Every sample here cost a real
    // broadcast and real postage, so throwing would discard the ones that already worked, and it
    // would also make `UnusableTimestampsError` unreachable: that error exists so a run can report a
    // segment as unmeasurable instead of crashing, and a caller that never catches it cannot.
    try {
      collected.push(
        await measureOne(gatewayUrl, newest, ref, manifest.atMs, publishStartedAtMs, options.mediaTimelineLeadMs),
      );
    } catch (error) {
      discarded.push({ ref, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  // Waiting out the first 404 must not turn a feed that never appeared into an empty run, which the
  // sweep report skips over in silence. A feed the uploader never wrote is a real failure and the
  // only place left that can say so.
  if (!feedSeen) {
    throw new Error(
      `the feed ${owner}/${topicHex} never appeared at ${gatewayUrl} in ${SEGMENT_TIMEOUT_MS}ms. ` +
        'The publisher was accepted, so this is the uploader not writing an update rather than the ' +
        'broadcast failing: check the uploader log for the manifest publish.',
    );
  }

  return { collected, discarded, feedPolls };
}

/**
 * One manifest entry carried end to end into a reading.
 *
 * Separate from the polling loop so that everything which can fail for a single segment sits inside
 * one `try` at the call site, and so that adding a step here cannot accidentally escape it.
 */
async function measureOne(
  gatewayUrl: string,
  newest: { uri: string; extinf: string },
  ref: string,
  visibleAtMs: number,
  publishStartedAtMs: number,
  mediaTimelineLeadMs: number,
): Promise<PendingSample> {
  const segment = await fetchSegment(gatewayUrl, ref);
  const probed = await probeSegmentBytes(segment.body, ref);
  const latencyMs = latencyMsFromPts(probed.firstFrame, { publishStartedAtMs, observedAtMs: segment.atMs });
  requireSpanFitsTheBroadcast(probed.mediaSpanS, segment.atMs - publishStartedAtMs, ref);

  return {
    ref,
    segmentDurationS: probed.mediaSpanS,
    // No longer fatal. The split is measured from the bytes now, so an unreadable `#EXTINF` costs the
    // comparison in the report and not the sample, and a segment that was paid for still yields one.
    declaredDurationS: segmentDuration(newest.extinf),
    videoPacketCount: probed.videoPacketCount,
    capturedAtMs: captureInstantMs(segment.atMs, latencyMs, mediaTimelineLeadMs),
    visibleAtMs,
    fetchedAtMs: segment.atMs,
  };
}

/**
 * A segment cannot hold more media than the publisher has produced.
 *
 * True by construction rather than tuned, though **one-sided**, unlike the bounds in `wallclock.ts`
 * which reject in both directions. A span measured too short has no bound here and none is available
 * from the packets: for constant-frame-rate output the span is exactly the packet count times the
 * frame duration, so a truncated list is as self-consistent as a whole one. The external check is the
 * declared duration the report prints beside it.
 *
 * What this one catches is a span measured across an MPEG-TS timestamp wrap, which lands near the
 * 26.5-hour period. **The order of the two calls above matters and is the only thing making the
 * anchor safe in that case**: on a wrap-crossing segment `Math.min` picks a post-wrap frame, so
 * `latencyMsFromPts` returns a latency roughly one segment too small and does not throw. This runs
 * after it and discards the segment before either figure is used.
 */
function requireSpanFitsTheBroadcast(mediaSpanS: number, elapsedMs: number, ref: string): void {
  if (mediaSpanS * 1_000 > elapsedMs) {
    throw new Error(
      `it measures ${mediaSpanS.toFixed(1)}s of media, more than the ${(elapsedMs / 1_000).toFixed(1)}s the ` +
        `publisher has been running. The likeliest cause is a timestamp wrap inside ${ref} rather than ` +
        'anything the pipeline did to it, since MPEG-TS counts in 33 bits and rolls every 26.5 hours',
    );
  }
}

/** ffprobe reads a path, so the fetched bytes go to a temp file that is removed either way. */
async function probeSegmentBytes(bytes: Buffer, ref: string) {
  const path = join(tmpdir(), `swarm-hls-bench-${ref.slice(0, 16)}.ts`);
  await writeFile(path, bytes);
  try {
    return await probeSegment(path, ref);
  } finally {
    await unlink(path).catch(() => {
      // A leftover temp segment is not worth failing a run that otherwise measured cleanly.
    });
  }
}
