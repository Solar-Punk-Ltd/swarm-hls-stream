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
import { type Host, waitForIdle } from '../harness/host.js';
import { announcedLiveStreams } from '../harness/logwatch.js';
import { sleep, waitFor } from '../harness/wait.js';

import { measureClockSkew } from './clockSkew.js';
import { fetchFeedManifest, fetchSegment, segmentRefFromUri } from './gateway.js';
import { probeFirstVideoFrame } from './probe.js';
import { type BenchRun, paceDriftMsPerMinute, type SegmentSample } from './report.js';
import { latencySplit, type SegmentInstants } from './split.js';
import { firstManifestAtOrAfter, segmentByRef, uploadTimeline } from './timeline.js';
import { latencyMsFromPts } from './wallclock.js';
import { type PublishKnobs, startWallclockPublisher } from './wallclockPublisher.js';

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
  /** How often to ask the feed for a new manifest, standing in for the client's own poll. */
  pollIntervalMs: number;
}

/** Everything one segment contributed, before the uploader's log is read to fill in the middle. */
interface PendingSample {
  ref: string;
  segmentDurationS: number;
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
  try {
    const stream = await waitForAnnouncement(host, uploader, sinceIso, publisher.stderr);
    const topicHex = Topic.fromString(stream.topic).toString();
    pending = await collectSamples(options, stream.owner, topicHex, publisher.startedAtMs);
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
    paceDriftMsPerMinute: paceDriftMsPerMinute(
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

  return { index: uploaded.index, ref: pending.ref, split: latencySplit(instants, skew) };
}

async function waitForAnnouncement(host: Host, uploader: string, sinceIso: string, publisherStderr: () => string) {
  let announced: ReturnType<typeof announcedLiveStreams>[number] | undefined;
  await waitFor(
    async () => {
      announced = announcedLiveStreams(await host.logsSince(uploader, sinceIso)).at(-1);
      return announced !== undefined;
    },
    {
      timeoutMs: ANNOUNCE_TIMEOUT_MS,
      intervalMs: 2_000,
      label: `the uploader announcing a live stream. ffmpeg said: ${
        publisherStderr().trim().slice(0, 300) || '(nothing)'
      }`,
    },
  );
  return announced!;
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
): Promise<PendingSample[]> {
  const { gatewayUrl, samples: wanted, pollIntervalMs } = options;
  const collected: PendingSample[] = [];
  const seen = new Set<string>();
  const deadline = Date.now() + SEGMENT_TIMEOUT_MS * wanted;

  while (collected.length < wanted) {
    if (Date.now() > deadline) {
      throw new Error(`only ${collected.length} of ${wanted} segments became visible before the run timed out`);
    }

    const manifest = await fetchFeedManifest(gatewayUrl, owner, topicHex);
    const newest = parseManifest(manifest.body).segments.at(-1);
    const ref = newest ? segmentRefFromUri(newest.uri) : null;
    if (!newest || !ref || seen.has(ref)) {
      await sleep(pollIntervalMs);
      continue;
    }
    seen.add(ref);

    const durationS = segmentDuration(newest.extinf);
    if (durationS === null) {
      throw new Error(`the manifest entry for ${ref} carries an unreadable duration: ${newest.extinf}`);
    }

    const segment = await fetchSegment(gatewayUrl, ref);
    const frame = await probeSegmentBytes(segment.body, ref);
    const latencyMs = latencyMsFromPts(frame, { publishStartedAtMs, observedAtMs: segment.atMs });

    collected.push({
      ref,
      segmentDurationS: durationS,
      capturedAtMs: segment.atMs - latencyMs,
      visibleAtMs: manifest.atMs,
      fetchedAtMs: segment.atMs,
    });
  }

  return collected;
}

/** ffprobe reads a path, so the fetched bytes go to a temp file that is removed either way. */
async function probeSegmentBytes(bytes: Buffer, ref: string) {
  const path = join(tmpdir(), `swarm-hls-bench-${ref.slice(0, 16)}.ts`);
  await writeFile(path, bytes);
  try {
    return await probeFirstVideoFrame(path, ref);
  } finally {
    await unlink(path).catch(() => {
      // A leftover temp segment is not worth failing a run that otherwise measured cleanly.
    });
  }
}
