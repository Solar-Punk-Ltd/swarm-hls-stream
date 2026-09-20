import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { MediaType, StreamState } from '../types.js';

export interface ManagedImmutableMediaReference {
  readonly topic: string;
  readonly index: number;
  readonly reference: string;
  readonly duration: number;
}

export interface ManagedImmutableRenditionReference extends ManagedImmutableMediaReference {
  readonly name: string;
  readonly width?: number;
  readonly height?: number;
  readonly bandwidth?: number;
  readonly avgBandwidth?: number;
}

export interface ManagedCompletedRecording {
  readonly runNumber: number;
  readonly checkpointReference: string;
  readonly master: ManagedImmutableMediaReference;
  readonly expectedRenditions: readonly string[];
  readonly renditions: readonly ManagedImmutableRenditionReference[];
}

export interface ManagedExpectedRendition {
  readonly name: string;
  readonly topic: string;
  readonly width?: number;
  readonly height?: number;
  readonly bandwidth?: number;
  readonly avgBandwidth?: number;
}

export interface ManagedContinuationOperation {
  readonly lifecycleVersion: 1;
  readonly operationId: string;
  readonly requestId: string;
  readonly streamId: string;
  readonly topic: string;
  readonly mediaType: MediaType;
  readonly uploaderId: string;
  readonly previousRunNumber: number;
  readonly nextRunNumber: number;
  readonly revision: number;
  readonly status: 'pending';
  readonly retainedRecording?: ManagedCompletedRecording;
}

export interface ManagedTrackFinalization {
  readonly streamId: string;
  readonly rendition: string | null;
  readonly state: StreamState;
  readonly manifest: ManagedImmutableMediaReference | ManagedImmutableRenditionReference;
}

export interface ManagedTrackCheckpoint {
  readonly streamId: string;
  readonly rendition: string | null;
  readonly state: StreamState;
  readonly manifest?: ManagedImmutableMediaReference | ManagedImmutableRenditionReference;
}

export interface ManagedCheckpointRecord {
  readonly lifecycleVersion: 1;
  readonly checkpointReference: string;
  readonly adminStreamId: string;
  readonly runNumber: number;
  readonly topic: string;
  readonly mediaType: MediaType;
  readonly expectedRenditions: readonly ManagedExpectedRendition[];
  readonly previousCheckpointReference?: string;
  readonly operationId?: string;
  readonly status: 'prepared' | 'complete';
  readonly tracks: readonly ManagedTrackCheckpoint[];
  readonly completedRecording?: ManagedCompletedRecording;
}

export interface ManagedCheckpointFileOps {
  mkdirSync(target: string, options: { recursive: true }): unknown;
  existsSync(target: string): boolean;
  readdirSync(target: string): string[];
  readFileSync(target: string): Buffer;
  openSync(target: string, flags: string, mode?: number): number;
  writeFileSync(fd: number, data: string): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
}

const nodeFileOps: ManagedCheckpointFileOps = {
  mkdirSync: (target, options) => fs.mkdirSync(target, options),
  existsSync: (target) => fs.existsSync(target),
  readdirSync: (target) => fs.readdirSync(target),
  readFileSync: (target) => fs.readFileSync(target),
  openSync: (target, flags, mode) => fs.openSync(target, flags, mode),
  writeFileSync: (fd, data) => fs.writeFileSync(fd, data),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (from, to) => fs.renameSync(from, to),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE = /^[0-9a-f]{64}$/i;

interface CreateManagedRun {
  readonly adminStreamId: string;
  readonly runNumber: number;
  readonly topic: string;
  readonly mediaType: MediaType;
  readonly expectedRenditions: readonly ManagedExpectedRendition[];
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function safePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validStreamState(value: unknown): value is StreamState {
  if (!value || typeof value !== 'object') {return false;}
  const state = value as Partial<StreamState>;
  return (
    typeof state.streamId === 'string' &&
    state.streamId.length > 0 &&
    typeof state.streamRawTopic === 'string' &&
    state.streamRawTopic.length > 0 &&
    (state.mediatype === 'video' || state.mediatype === 'audio') &&
    (state.socIndex === null || safeNonNegativeInteger(state.socIndex)) &&
    Array.isArray(state.segments) &&
    Array.isArray(state.hlsHeaders) &&
    typeof state.isFirstSegmentReady === 'boolean' &&
    typeof state.isFirstManifestReady === 'boolean' &&
    finiteNonNegative(state.updatedAt)
  );
}

function validMediaReference(value: ManagedImmutableMediaReference): boolean {
  return (
    typeof value.topic === 'string' &&
    value.topic.length > 0 &&
    safeNonNegativeInteger(value.index) &&
    REFERENCE.test(value.reference) &&
    finiteNonNegative(value.duration)
  );
}

function normalizedRecording(recording: ManagedCompletedRecording): unknown {
  return {
    ...recording,
    expectedRenditions: [...recording.expectedRenditions].sort(),
    renditions: [...recording.renditions].sort((left, right) =>
      left.name === right.name ? left.topic.localeCompare(right.topic) : left.name.localeCompare(right.name),
    ),
  };
}

function sameRecording(left: ManagedCompletedRecording, right: ManagedCompletedRecording): boolean {
  return JSON.stringify(normalizedRecording(left)) === JSON.stringify(normalizedRecording(right));
}

function sameExpectedRendition(
  expected: ManagedExpectedRendition,
  actual: ManagedImmutableRenditionReference,
): boolean {
  return (
    expected.name === actual.name &&
    expected.topic === actual.topic &&
    expected.width === actual.width &&
    expected.height === actual.height &&
    expected.bandwidth === actual.bandwidth &&
    expected.avgBandwidth === actual.avgBandwidth
  );
}

function validExpectedRendition(value: unknown): value is ManagedExpectedRendition {
  if (!value || typeof value !== 'object') {return false;}
  const rendition = value as Partial<ManagedExpectedRendition>;
  return (
    typeof rendition.name === 'string' &&
    rendition.name.length > 0 &&
    typeof rendition.topic === 'string' &&
    rendition.topic.length > 0 &&
    (rendition.width === undefined || safePositiveInteger(rendition.width)) &&
    (rendition.height === undefined || safePositiveInteger(rendition.height)) &&
    (rendition.bandwidth === undefined || safePositiveInteger(rendition.bandwidth)) &&
    (rendition.avgBandwidth === undefined || safePositiveInteger(rendition.avgBandwidth))
  );
}

function validTrack(value: unknown): value is ManagedTrackCheckpoint {
  if (!value || typeof value !== 'object') {return false;}
  const track = value as Partial<ManagedTrackCheckpoint>;
  return (
    typeof track.streamId === 'string' &&
    track.streamId.length > 0 &&
    (track.rendition === null || (typeof track.rendition === 'string' && track.rendition.length > 0)) &&
    validStreamState(track.state) &&
    track.state.streamId === track.streamId &&
    (track.manifest === undefined || validMediaReference(track.manifest))
  );
}

function validCompletedRecording(value: unknown): value is ManagedCompletedRecording {
  if (!value || typeof value !== 'object') {return false;}
  const recording = value as Partial<ManagedCompletedRecording>;
  return (
    safePositiveInteger(recording.runNumber) &&
    typeof recording.checkpointReference === 'string' &&
    UUID.test(recording.checkpointReference) &&
    recording.master !== undefined &&
    validMediaReference(recording.master) &&
    Array.isArray(recording.expectedRenditions) &&
    recording.expectedRenditions.every((name) => typeof name === 'string' && name.length > 0) &&
    Array.isArray(recording.renditions) &&
    recording.renditions.every(
      (rendition) =>
        validMediaReference(rendition) && typeof rendition.name === 'string' && rendition.name.length > 0,
    )
  );
}

/** Durable private cumulative playback state addressed by the UUID reported to the admin. */
export class ManagedCheckpointStore {
  constructor(
    private readonly stateDir: string,
    private readonly fileOps: ManagedCheckpointFileOps = nodeFileOps,
    private readonly makeReference: () => string = () => crypto.randomUUID(),
  ) {
    if (!this.fileOps.existsSync(stateDir)) {
      this.fileOps.mkdirSync(stateDir, { recursive: true });
      this.flushDirectory(path.dirname(stateDir));
    }
  }

  public createRun(input: CreateManagedRun): ManagedCheckpointRecord {
    this.validateCreate(input);
    const existing = this.findRun(input.adminStreamId, input.runNumber);
    if (existing) {return existing;}
    const checkpointReference = this.makeReference();
    if (!UUID.test(checkpointReference)) {throw new Error('Checkpoint reference generator returned an invalid UUID');}
    const record: ManagedCheckpointRecord = {
      lifecycleVersion: 1,
      checkpointReference,
      adminStreamId: input.adminStreamId,
      runNumber: input.runNumber,
      topic: input.topic,
      mediaType: input.mediaType,
      expectedRenditions: [...input.expectedRenditions],
      status: 'prepared',
      tracks: [],
    };
    this.save(record);
    return record;
  }

  public prepare(operation: ManagedContinuationOperation): ManagedCheckpointRecord {
    if (operation.lifecycleVersion !== 1 || operation.status !== 'pending') {
      throw new Error('Refused invalid managed continuation operation');
    }
    const existing = this.findRun(operation.streamId, operation.nextRunNumber);
    if (existing) {
      if (existing.operationId !== operation.operationId) {throw new Error('Continuation run is already prepared differently');}
      return existing;
    }
    const retained = operation.retainedRecording;
    if (!retained) {throw new Error('Continuation has no retained completed recording');}
    const predecessor = this.read(retained.checkpointReference);
    if (!predecessor?.completedRecording || predecessor.status !== 'complete') {
      throw new Error('Retained continuation checkpoint is missing or incomplete');
    }
    if (
      predecessor.adminStreamId !== operation.streamId ||
      predecessor.runNumber !== operation.previousRunNumber ||
      predecessor.topic !== operation.topic ||
      predecessor.mediaType !== operation.mediaType ||
      !sameRecording(predecessor.completedRecording, retained)
    ) {
      throw new Error('Retained continuation recording does not match its frozen checkpoint');
    }

    const checkpointReference = this.makeReference();
    if (!UUID.test(checkpointReference)) {throw new Error('Checkpoint reference generator returned an invalid UUID');}
    const record: ManagedCheckpointRecord = {
      lifecycleVersion: 1,
      checkpointReference,
      adminStreamId: operation.streamId,
      runNumber: operation.nextRunNumber,
      topic: operation.topic,
      mediaType: operation.mediaType,
      expectedRenditions: predecessor.expectedRenditions,
      previousCheckpointReference: predecessor.checkpointReference,
      operationId: operation.operationId,
      status: 'prepared',
      tracks: predecessor.tracks.map((track) => ({
        streamId: track.streamId,
        rendition: track.rendition,
        state: track.state,
      })),
    };
    this.save(record);
    return record;
  }

  public saveTrack(checkpointReference: string, track: ManagedTrackFinalization): ManagedCheckpointRecord {
    const record = this.require(checkpointReference);
    this.validateTrack(record, track);
    const key = track.rendition ?? '';
    const previous = record.tracks.find((candidate) => (candidate.rendition ?? '') === key);
    if (previous && !isPrefix(previous.state.segments, track.state.segments)) {
      throw new Error(`Track ${track.streamId} does not preserve its cumulative segment history`);
    }
    const tracks = record.tracks.filter((candidate) => (candidate.rendition ?? '') !== key);
    const updated: ManagedCheckpointRecord = { ...record, status: 'prepared', tracks: [...tracks, track] };
    this.save(updated);
    return updated;
  }

  public complete(
    checkpointReference: string,
    master: ManagedImmutableMediaReference,
  ): ManagedCompletedRecording {
    const record = this.require(checkpointReference);
    if (!validMediaReference(master) || master.topic !== record.topic) {
      throw new Error('Managed recording master does not match its stable topic');
    }
    const renditions = record.expectedRenditions.map((expected) => {
      const track = record.tracks.find((candidate) => candidate.rendition === expected.name);
      if (!track?.manifest) {throw new Error(`Managed recording is missing expected rendition ${expected.name}`);}
      const actual = track.manifest as ManagedImmutableRenditionReference;
      if (!sameExpectedRendition(expected, actual)) {
        throw new Error(`Managed recording rendition ${expected.name} does not match its frozen checkpoint`);
      }
      return actual;
    });
    if (record.expectedRenditions.length === 0) {
      const single = record.tracks.find((track) => track.rendition === null);
      if (!single?.manifest) {throw new Error('Managed recording is missing its single track');}
      if (JSON.stringify(single.manifest) !== JSON.stringify(master)) {
        throw new Error('Managed recording master does not match its finalized single track');
      }
    }
    const completedRecording: ManagedCompletedRecording = {
      runNumber: record.runNumber,
      checkpointReference: record.checkpointReference,
      master,
      expectedRenditions: record.expectedRenditions.map((rendition) => rendition.name),
      renditions,
    };
    this.save({ ...record, status: 'complete', completedRecording });
    return completedRecording;
  }

  public read(checkpointReference: string): ManagedCheckpointRecord | null {
    const filePath = this.filePath(checkpointReference);
    if (!this.fileOps.existsSync(filePath)) {return null;}
    try {
      const value = JSON.parse(this.fileOps.readFileSync(filePath).toString('utf8')) as ManagedCheckpointRecord;
      return this.validRecord(value) && value.checkpointReference === checkpointReference ? value : null;
    } catch {
      return null;
    }
  }

  public findRun(adminStreamId: string, runNumber: number): ManagedCheckpointRecord | null {
    for (const name of this.fileOps.readdirSync(this.stateDir)) {
      if (!name.endsWith('.json')) {continue;}
      const record = this.read(name.slice(0, -'.json'.length));
      if (record?.adminStreamId === adminStreamId && record.runNumber === runNumber) {return record;}
    }
    return null;
  }

  private require(checkpointReference: string): ManagedCheckpointRecord {
    const record = this.read(checkpointReference);
    if (!record) {throw new Error(`Managed checkpoint ${checkpointReference} is missing or unreadable`);}
    return record;
  }

  private validateCreate(input: CreateManagedRun): void {
    if (
      !UUID.test(input.adminStreamId) ||
      !safePositiveInteger(input.runNumber) ||
      input.topic.length === 0 ||
      (input.mediaType !== 'video' && input.mediaType !== 'audio') ||
      !input.expectedRenditions.every(validExpectedRendition) ||
      new Set(input.expectedRenditions.map((rendition) => rendition.name)).size !== input.expectedRenditions.length
    ) {
      throw new Error('Refused invalid managed checkpoint run');
    }
  }

  private validateTrack(record: ManagedCheckpointRecord, track: ManagedTrackFinalization): void {
    if (track.state.streamId !== track.streamId || !validMediaReference(track.manifest)) {
      throw new Error('Refused invalid managed checkpoint track');
    }
    if (record.expectedRenditions.length === 0) {
      if (track.rendition !== null || track.manifest.topic !== record.topic) {
        throw new Error('Single-track checkpoint does not match its stable topic');
      }
      return;
    }
    const expected = record.expectedRenditions.find((rendition) => rendition.name === track.rendition);
    if (!expected || !('name' in track.manifest) || !sameExpectedRendition(expected, track.manifest)) {
      throw new Error(`Managed checkpoint track ${track.rendition ?? track.streamId} is not an expected rendition`);
    }
  }

  private validRecord(record: ManagedCheckpointRecord): boolean {
    return (
      record?.lifecycleVersion === 1 &&
      UUID.test(record.checkpointReference) &&
      UUID.test(record.adminStreamId) &&
      safePositiveInteger(record.runNumber) &&
      typeof record.topic === 'string' &&
      record.topic.length > 0 &&
      (record.mediaType === 'video' || record.mediaType === 'audio') &&
      Array.isArray(record.expectedRenditions) &&
      record.expectedRenditions.every(validExpectedRendition) &&
      new Set(record.expectedRenditions.map((rendition) => rendition.name)).size === record.expectedRenditions.length &&
      Array.isArray(record.tracks) &&
      record.tracks.every(validTrack) &&
      new Set(record.tracks.map((track) => track.rendition ?? '')).size === record.tracks.length &&
      (record.previousCheckpointReference === undefined || UUID.test(record.previousCheckpointReference)) &&
      (record.operationId === undefined || UUID.test(record.operationId)) &&
      (record.status === 'prepared' || record.status === 'complete') &&
      (record.status === 'prepared' ||
        (validCompletedRecording(record.completedRecording) &&
          record.completedRecording.runNumber === record.runNumber &&
          record.completedRecording.checkpointReference === record.checkpointReference))
    );
  }

  private save(record: ManagedCheckpointRecord): void {
    const filePath = this.filePath(record.checkpointReference);
    const tmpPath = `${filePath}.tmp`;
    const file = this.fileOps.openSync(tmpPath, 'w', 0o600);
    try {
      this.fileOps.writeFileSync(file, JSON.stringify(record));
      this.fileOps.fsyncSync(file);
    } finally {
      this.fileOps.closeSync(file);
    }
    this.fileOps.renameSync(tmpPath, filePath);
    this.flushDirectory(this.stateDir);
  }

  private flushDirectory(directoryPath: string): void {
    const directory = this.fileOps.openSync(directoryPath, 'r');
    try {
      this.fileOps.fsyncSync(directory);
    } finally {
      this.fileOps.closeSync(directory);
    }
  }

  private filePath(checkpointReference: string): string {
    return path.join(this.stateDir, `${checkpointReference}.json`);
  }
}

function isPrefix(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return previous.length <= next.length && previous.every((value, index) => JSON.stringify(value) === JSON.stringify(next[index]));
}
