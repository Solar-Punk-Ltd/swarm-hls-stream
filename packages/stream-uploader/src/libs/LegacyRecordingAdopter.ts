import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotReference } from '@swarm-hls-stream/shared';

import { parseMediaPlaylist } from '../engines/ome/utils.js';
import { SegmentEntry, StreamState } from '../types.js';

import {
  LegacyAdoptionOperation,
  LegacyAdoptionValidation,
} from './AdminApiClient.js';
import { BeePublisherPool } from './BeePublisherPool.js';
import {
  AdoptLegacyRecording,
  ManagedExpectedRendition,
  ManagedImmutableMediaReference,
  ManagedTrackFinalization,
} from './ManagedCheckpointStore.js';
import { buildMasterPlaylist } from './MasterPlaylist.js';
import { MediaFormatFingerprint, MediaFormatInspector } from './MediaFormatProbe.js';

const REFERENCE = /^[0-9a-f]{64}$/i;
const MAX_FORMAT_BYTES = 4 * 1024 * 1024;
const DURATION_EPSILON_SECONDS = 0.001;

export class LegacyAdoptionValidationError extends Error {}
export class LegacyAdoptionPendingError extends Error {}

export interface LegacyAdoptionMediaReader {
  readonly owner: string;
  readFeed(topic: string, index: number, rendition: string | null): Promise<{
    readonly playlist: string;
    readonly reference: string;
  }>;
  readSegment(reference: string, rendition: string | null): Promise<Uint8Array>;
}

export interface LegacyAdoptionInspection {
  readonly checkpoint: Omit<AdoptLegacyRecording, 'operationId' | 'candidateDigest'>;
  readonly validation: LegacyAdoptionValidation;
  readonly masterPlaylist: string;
}

/** Reads and fingerprints one frozen legacy VOD without holding an admin database lock. */
export class LegacyRecordingAdopter {
  constructor(
    private readonly reader: LegacyAdoptionMediaReader,
    private readonly inspector: MediaFormatInspector,
    private readonly wallClock: () => number = Date.now,
  ) {}

  public async inspect(
    operation: LegacyAdoptionOperation,
    pendingTopics: readonly string[],
    expectedRenditions: readonly ManagedExpectedRendition[] = operation.candidate.renditions,
  ): Promise<LegacyAdoptionInspection> {
    const mediaTopics = operation.candidate.renditions.length === 0
      ? [operation.candidate.topic]
      : operation.candidate.renditions.map((rendition) => rendition.topic);
    const pending = mediaTopics.filter((topic) => pendingTopics.includes(topic));
    if (pending.length > 0) {
      throw new LegacyAdoptionPendingError(`Legacy recording has pending writes for ${pending.join(', ')}`);
    }
    this.validateExpectedRenditions(operation, expectedRenditions);

    const master = await this.reader.readFeed(
      operation.candidate.master.topic,
      operation.candidate.master.index,
      null,
    );
    if (operation.candidate.renditions.length > 0) {
      const expectedMaster = buildMasterPlaylist(this.reader.owner, operation.candidate.renditions);
      if (normalizePlaylist(master.playlist) !== normalizePlaylist(expectedMaster)) {
      throw new LegacyAdoptionValidationError('Legacy master playlist does not match the frozen rendition set');
      }
    }

    const candidates = operation.candidate.renditions.length === 0
      ? [{ ...operation.candidate.master, name: null }]
      : operation.candidate.renditions.map((rendition) => ({ ...rendition, name: rendition.name }));
    const tracks: ManagedTrackFinalization[] = [];
    const validationTracks: LegacyAdoptionValidation['tracks'][number][] = [];
    for (const candidate of candidates) {
      const feed = candidate.name === null
        ? master
        : await this.reader.readFeed(candidate.topic, candidate.index, candidate.name);
      const inspected = await this.inspectTrack(
        operation,
        candidate.name,
        candidate.topic,
        candidate.index,
        candidate.duration,
        feed.playlist,
        feed.reference,
      );
      tracks.push(inspected.track);
      validationTracks.push({ topic: candidate.topic, formatFingerprint: inspected.fingerprint });
    }

    validationTracks.sort((left, right) => left.topic.localeCompare(right.topic));
    const masterReference: ManagedImmutableMediaReference = {
      topic: operation.candidate.master.topic,
      index: operation.candidate.master.index,
      reference: master.reference,
      duration: operation.candidate.master.duration,
    };
    return {
      checkpoint: {
        adminStreamId: operation.streamId,
        topic: operation.topic,
        mediaType: operation.mediaType,
        expectedRenditions,
        tracks,
        master: masterReference,
      },
      validation: {
        version: 1,
        mediaReadable: true,
        pendingWrites: 0,
        tracks: validationTracks,
      },
      masterPlaylist: master.playlist,
    };
  }

  private async inspectTrack(
    operation: LegacyAdoptionOperation,
    rendition: string | null,
    topic: string,
    index: number,
    expectedDuration: number,
    playlist: string,
    reference: string,
  ): Promise<{ track: ManagedTrackFinalization; fingerprint: MediaFormatFingerprint }> {
    if (!playlist.split(/\r?\n/).some((line) => line.trim() === '#EXT-X-ENDLIST')) {
      throw new LegacyAdoptionValidationError(`Legacy media playlist ${topic} is not final`);
    }
    const entries = parseMediaPlaylist(playlist);
    if (entries.length === 0) {
      throw new LegacyAdoptionValidationError(`Legacy media playlist ${topic} has no media`);
    }
    const gaps = gapUris(playlist);
    if (gaps.has(entries[0].uri) || gaps.has(entries[entries.length - 1].uri)) {
      throw new LegacyAdoptionValidationError(`Legacy media playlist ${topic} has an unsupported edge gap`);
    }
    const gapDurations = entries.filter((entry) => gaps.has(entry.uri)).map((entry) => entry.duration);
    if (new Set(gapDurations).size > 1) {
      throw new LegacyAdoptionValidationError(`Legacy media playlist ${topic} has inconsistent gap durations`);
    }
    const duration = entries
      .filter((entry) => !gaps.has(entry.uri))
      .reduce((total, entry) => total + entry.duration, 0);
    if (Math.abs(duration - expectedDuration) > DURATION_EPSILON_SECONDS) {
      throw new LegacyAdoptionValidationError(
        `Legacy media playlist ${topic} duration does not match its frozen candidate`,
      );
    }

    const segments: SegmentEntry[] = [];
    const opening: Buffer[] = [];
    let openingBytes = 0;
    for (const entry of entries) {
      if (gaps.has(entry.uri)) {continue;}
      if (!REFERENCE.test(entry.uri)) {
        throw new LegacyAdoptionValidationError(
          `Legacy media playlist ${topic} contains a non-immutable segment reference`,
        );
      }
      const data = Buffer.from(await this.reader.readSegment(entry.uri, rendition));
      if (openingBytes < MAX_FORMAT_BYTES) {
        const part = data.subarray(0, MAX_FORMAT_BYTES - openingBytes);
        opening.push(part);
        openingBytes += part.length;
      }
      segments.push({
        index: entry.seq,
        sequence: entry.seq,
        duration: entry.duration,
        ref: entry.uri,
        ...(entry.discontinuity ? { discontinuity: true } : {}),
        ...(entry.programDateTime !== undefined ? { presentedAtMs: entry.programDateTime } : {}),
      });
    }
    if (segments.length === 0 || openingBytes === 0) {
      throw new LegacyAdoptionValidationError(`Legacy media playlist ${topic} has no readable media`);
    }
    const probe = await this.inspector.inspect(Buffer.concat(opening));
    if (probe.kind === 'busy') {
      throw new LegacyAdoptionPendingError(`Legacy media playlist ${topic} format inspection is busy`);
    }
    if (probe.kind !== 'valid') {
      throw new LegacyAdoptionValidationError(
        `Legacy media playlist ${topic} has no verified format metadata (${probe.kind})`,
      );
    }
    validateFingerprint(operation, rendition, probe.fingerprint);

    const streamId = rendition === null
      ? `${operation.mediaType}/${operation.topic}`
      : `${operation.mediaType}/${operation.topic}_${rendition}`;
    const state: StreamState = {
      streamId,
      streamRawTopic: topic,
      mediatype: operation.mediaType,
      socIndex: index,
      segments,
      hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
      isFirstSegmentReady: true,
      isFirstManifestReady: true,
      updatedAt: this.wallClock(),
      adminStreamId: operation.streamId,
      ...(gapDurations.length > 0
        ? {
            anchor: {
              startedAtMs:
                segments[0].presentedAtMs ?? this.wallClock() - segments[0].sequence! * gapDurations[0] * 1_000,
              fragmentSeconds: gapDurations[0],
            },
          }
        : {}),
    };
    const expected = operation.candidate.renditions.find((candidate) => candidate.name === rendition);
    return {
      track: {
        streamId,
        rendition,
        state,
        manifest: expected
          ? {
              name: expected.name,
              topic,
              index,
              reference,
              duration: expectedDuration,
              width: expected.width,
              height: expected.height,
              bandwidth: expected.bandwidth,
              avgBandwidth: expected.avgBandwidth,
            }
          : { topic, index, reference, duration: expectedDuration },
        formatFingerprint: probe.fingerprint,
      },
      fingerprint: probe.fingerprint,
    };
  }

  private validateExpectedRenditions(
    operation: LegacyAdoptionOperation,
    expected: readonly ManagedExpectedRendition[],
  ): void {
    const candidates = operation.candidate.renditions;
    if (candidates.length !== expected.length) {
      throw new LegacyAdoptionValidationError(
        'Legacy candidate does not match the configured managed rendition set',
      );
    }
    for (const target of expected) {
      const candidate = candidates.find((entry) => entry.name === target.name);
      if (
        !candidate ||
        candidate.topic !== target.topic ||
        candidate.width !== target.width ||
        candidate.height !== target.height
      ) {
        throw new LegacyAdoptionValidationError(
          'Legacy candidate does not match the configured managed rendition set',
        );
      }
    }
  }
}

/** Production Bee reader for exact feed slots and immutable media chunks. */
export class BeeLegacyAdoptionMediaReader implements LegacyAdoptionMediaReader {
  constructor(
    private readonly publishers: BeePublisherPool,
    public readonly owner: string,
  ) {}

  public async readFeed(topic: string, index: number, rendition: string | null) {
    const publisher = rendition === null ? this.publishers.coordinator() : this.publishers.forRung(rendition);
    const feedTopic = Topic.fromString(topic);
    const feedIndex = FeedIndex.fromBigInt(BigInt(index));
    const result = await publisher.bee
      .makeFeedReader(feedTopic, this.owner)
      .downloadPayload({ index: feedIndex });
    return {
      playlist: result.payload.toUtf8(),
      reference: feedSlotReference(this.owner, feedTopic, feedIndex).toHex(),
    };
  }

  public async readSegment(reference: string, rendition: string | null): Promise<Uint8Array> {
    const publisher = rendition === null ? this.publishers.coordinator() : this.publishers.forRung(rendition);
    return (await publisher.bee.downloadData(reference)).toUint8Array();
  }
}

function gapUris(playlist: string): Set<string> {
  const gaps = new Set<string>();
  const lines = playlist.split(/\r?\n/);
  let gap = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '#EXT-X-GAP') {
      gap = true;
    } else if (line && !line.startsWith('#')) {
      if (gap) {gaps.add(line);}
      gap = false;
    }
  }
  return gaps;
}

function normalizePlaylist(playlist: string): string {
  return playlist.replace(/\r\n/g, '\n').trim();
}

function validateFingerprint(
  operation: LegacyAdoptionOperation,
  rendition: string | null,
  fingerprint: MediaFormatFingerprint,
): void {
  const videos = fingerprint.tracks.filter((track) => track.kind === 'video');
  const audios = fingerprint.tracks.filter((track) => track.kind === 'audio');
  if (operation.mediaType === 'audio') {
    if (videos.length > 0 || audios.length === 0) {
      throw new LegacyAdoptionValidationError('Legacy audio recording format is not audio-only');
    }
    return;
  }
  if (videos.length === 0) {
    throw new LegacyAdoptionValidationError('Legacy video recording has no video track');
  }
  if (rendition !== null) {
    const expected = operation.candidate.renditions.find((candidate) => candidate.name === rendition)!;
    if (videos.some((track) => track.width !== expected.width || track.height !== expected.height)) {
      throw new LegacyAdoptionValidationError(
        `Legacy rendition ${rendition} dimensions do not match its frozen candidate`,
      );
    }
  }
}
