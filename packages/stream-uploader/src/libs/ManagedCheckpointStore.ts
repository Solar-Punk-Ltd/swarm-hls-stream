import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { MediaType, StreamState } from '../types.js';

import { isMediaFormatFingerprint, MediaFormatFingerprint } from './MediaFormatProbe.js';

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

export interface ManagedEmptyOutcome {
  readonly runNumber: number;
  readonly checkpointReference: string;
  readonly acceptedMediaCount: 0;
}

export interface ManagedExpectedRendition {
  readonly name: string;
  readonly topic: string;
  readonly width: number;
  readonly height: number;
  readonly bandwidth: number;
  readonly avgBandwidth: number;
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
  readonly previousEmptyOutcome?: ManagedEmptyOutcome;
}

export interface ManagedTrackFinalization {
  readonly streamId: string;
  readonly rendition: string | null;
  readonly state: StreamState;
  readonly manifest: ManagedImmutableMediaReference | ManagedImmutableRenditionReference;
  readonly formatFingerprint?: MediaFormatFingerprint;
}

export interface ManagedTrackCheckpoint {
  readonly streamId: string;
  readonly rendition: string | null;
  readonly state: StreamState;
  readonly manifest?: ManagedImmutableMediaReference | ManagedImmutableRenditionReference;
  readonly formatFingerprint?: MediaFormatFingerprint;
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
  readonly adoptionCandidateDigest?: string;
  readonly status: 'prepared' | 'complete' | 'empty';
  readonly tracks: readonly ManagedTrackCheckpoint[];
  readonly retainedRecording?: ManagedCompletedRecording;
  readonly completedRecording?: ManagedCompletedRecording;
  readonly emptyOutcome?: ManagedEmptyOutcome;
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

export interface CreateManagedRun {
  readonly adminStreamId: string;
  readonly runNumber: number;
  readonly topic: string;
  readonly mediaType: MediaType;
  readonly expectedRenditions: readonly ManagedExpectedRendition[];
}

export interface AdoptLegacyRecording {
  readonly operationId: string;
  readonly candidateDigest: string;
  readonly adminStreamId: string;
  readonly topic: string;
  readonly mediaType: MediaType;
  readonly expectedRenditions: readonly ManagedExpectedRendition[];
  readonly tracks: readonly ManagedTrackFinalization[];
  readonly master: ManagedImmutableMediaReference;
}

/** Durable checkpoint operations used by the orchestrator and replaceable with a faulting store in tests. */
export interface ManagedCheckpointPersistence {
  createRun(input: CreateManagedRun): ManagedCheckpointRecord;
  adoptLegacy(input: AdoptLegacyRecording): ManagedCompletedRecording;
  prepare(operation: ManagedContinuationOperation): ManagedCheckpointRecord;
  saveTrack(checkpointReference: string, track: ManagedTrackFinalization): ManagedCheckpointRecord;
  complete(checkpointReference: string, master: ManagedImmutableMediaReference): ManagedCompletedRecording;
  sealEmpty(checkpointReference: string, acceptedMediaCount: number): ManagedEmptyOutcome;
  read(checkpointReference: string): ManagedCheckpointRecord | null;
  findRun(adminStreamId: string, runNumber: number): ManagedCheckpointRecord | null;
}

interface ManagedRunIndex {
  readonly lifecycleVersion: 1;
  readonly adminStreamId: string;
  readonly runNumber: number;
  readonly checkpointReference: string;
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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function sameRecording(left: ManagedCompletedRecording, right: ManagedCompletedRecording): boolean {
  return sameValue(normalizedRecording(left), normalizedRecording(right));
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

function sameExpectedRenditions(
  left: readonly ManagedExpectedRendition[],
  right: readonly ManagedExpectedRendition[],
): boolean {
  return (
    left.length === right.length &&
    left.every((expected, index) => {
      const actual = right[index];
      return (
        actual !== undefined &&
        expected.name === actual.name &&
        expected.topic === actual.topic &&
        expected.width === actual.width &&
        expected.height === actual.height &&
        expected.bandwidth === actual.bandwidth &&
        expected.avgBandwidth === actual.avgBandwidth
      );
    })
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
    safePositiveInteger(rendition.width) &&
    safePositiveInteger(rendition.height) &&
    safePositiveInteger(rendition.bandwidth) &&
    safePositiveInteger(rendition.avgBandwidth)
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
    (track.manifest === undefined || validMediaReference(track.manifest)) &&
    (track.formatFingerprint === undefined || isMediaFormatFingerprint(track.formatFingerprint))
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

function validEmptyOutcome(value: unknown): value is ManagedEmptyOutcome {
  if (!value || typeof value !== 'object') {return false;}
  const outcome = value as Partial<ManagedEmptyOutcome>;
  return (
    safePositiveInteger(outcome.runNumber) &&
    typeof outcome.checkpointReference === 'string' &&
    UUID.test(outcome.checkpointReference) &&
    outcome.acceptedMediaCount === 0
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
    }
    this.flushDirectory(path.dirname(stateDir));
  }

  public createRun(input: CreateManagedRun): ManagedCheckpointRecord {
    this.validateCreate(input);
    const existing = this.findRun(input.adminStreamId, input.runNumber);
    if (existing) {
      if (
        existing.topic !== input.topic ||
        existing.mediaType !== input.mediaType ||
        !sameExpectedRenditions(existing.expectedRenditions, input.expectedRenditions)
      ) {
        throw new Error('Managed checkpoint run is already prepared with different immutable input');
      }
      return existing;
    }
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
    this.saveRunIndex(record);
    return record;
  }

  public adoptLegacy(input: AdoptLegacyRecording): ManagedCompletedRecording {
    this.validateCreate({ ...input, runNumber: 1 });
    if (!UUID.test(input.operationId) || !REFERENCE.test(input.candidateDigest) || !validMediaReference(input.master)) {
      throw new Error('Refused invalid legacy adoption checkpoint');
    }
    const existing = this.findRun(input.adminStreamId, 1);
    if (existing) {
      const planned = this.legacyAdoptionRecord(input, existing.checkpointReference);
      if (existing.adoptionCandidateDigest === input.candidateDigest) {
        if (
          existing.status !== 'complete' ||
          !existing.completedRecording ||
          !sameValue({ ...existing, operationId: input.operationId }, planned)
        ) {
          throw new Error('Legacy adoption run is already sealed with different immutable input');
        }
        return existing.completedRecording;
      }
      if (!existing.adoptionCandidateDigest) {
        throw new Error('Legacy adoption run is already sealed with different immutable input');
      }
    }
    const planned = this.legacyAdoptionRecord(input, this.makeReference());
    if (!UUID.test(planned.checkpointReference)) {
      throw new Error('Checkpoint reference generator returned an invalid UUID');
    }
    this.save(planned);
    this.saveRunIndex(planned);
    return planned.completedRecording!;
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
    const immediateEmpty = this.validatePreviousEmpty(operation);
    const retainedCheckpoint = this.validateRetainedRecording(operation);
    if (!immediateEmpty && (!retainedCheckpoint || retainedCheckpoint.runNumber !== operation.previousRunNumber)) {
      throw new Error('Continuation has no verified immediate predecessor');
    }
    if (immediateEmpty) {
      const locallyRetained = immediateEmpty.retainedRecording;
      if (
        (locallyRetained &&
          (!operation.retainedRecording || !sameRecording(locallyRetained, operation.retainedRecording))) ||
        (!locallyRetained && operation.retainedRecording)
      ) {
        throw new Error('Empty predecessor does not match the retained continuation recording');
      }
    }
    const replay = retainedCheckpoint ?? immediateEmpty;
    if (!replay) {throw new Error('Continuation has no retained or verified-empty checkpoint');}

    const checkpointReference = this.makeReference();
    if (!UUID.test(checkpointReference)) {throw new Error('Checkpoint reference generator returned an invalid UUID');}
    const record: ManagedCheckpointRecord = {
      lifecycleVersion: 1,
      checkpointReference,
      adminStreamId: operation.streamId,
      runNumber: operation.nextRunNumber,
      topic: operation.topic,
      mediaType: operation.mediaType,
      expectedRenditions: replay.expectedRenditions,
      previousCheckpointReference: immediateEmpty?.checkpointReference ?? replay.checkpointReference,
      operationId: operation.operationId,
      status: 'prepared',
      tracks: replay.tracks.map((track) => ({
        streamId: track.streamId,
        rendition: track.rendition,
        state: track.state,
        formatFingerprint: track.formatFingerprint,
      })),
      retainedRecording: operation.retainedRecording,
    };
    this.save(record);
    this.saveRunIndex(record);
    return record;
  }

  public saveTrack(checkpointReference: string, track: ManagedTrackFinalization): ManagedCheckpointRecord {
    const record = this.require(checkpointReference);
    this.validateTrack(record, track);
    const key = track.rendition ?? '';
    const previous = record.tracks.find((candidate) => (candidate.rendition ?? '') === key);
    if (record.status === 'complete') {
      if (previous && sameValue(previous, track)) {return record;}
      throw new Error('Managed checkpoint is complete and cannot accept another track finalization');
    }
    if (record.status === 'empty') {
      throw new Error('Managed checkpoint is empty and cannot accept a track finalization');
    }
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
    if (record.status === 'complete') {
      if (record.completedRecording && sameValue(record.completedRecording.master, master)) {
        return record.completedRecording;
      }
      throw new Error('Managed checkpoint is complete and cannot be finalized differently');
    }
    if (record.status === 'empty') {
      throw new Error('Managed checkpoint is empty and cannot be finalized as a recording');
    }
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
      if (!sameValue(single.manifest, master)) {
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

  public sealEmpty(checkpointReference: string, acceptedMediaCount: number): ManagedEmptyOutcome {
    const record = this.require(checkpointReference);
    if (acceptedMediaCount !== 0) {
      throw new Error('Managed checkpoint with accepted media cannot be sealed empty');
    }
    if (record.status === 'complete') {
      throw new Error('Managed checkpoint is complete and cannot be sealed empty');
    }
    if (record.status === 'empty') {
      if (record.emptyOutcome) {return record.emptyOutcome;}
      throw new Error('Managed empty checkpoint is missing its outcome');
    }
    if (record.tracks.some((track) => track.manifest !== undefined)) {
      throw new Error('Managed checkpoint with uploaded track media cannot be sealed empty');
    }
    const emptyOutcome: ManagedEmptyOutcome = {
      runNumber: record.runNumber,
      checkpointReference: record.checkpointReference,
      acceptedMediaCount: 0,
    };
    this.save({ ...record, status: 'empty', emptyOutcome });
    return emptyOutcome;
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
    this.flushDirectory(this.stateDir);
    const indexPath = this.runIndexPath(adminStreamId, runNumber);
    if (this.fileOps.existsSync(indexPath)) {
      const index = this.readRunIndex(indexPath);
      if (!index || index.adminStreamId !== adminStreamId || index.runNumber !== runNumber) {
        throw new Error(`Managed checkpoint index for ${adminStreamId} run ${runNumber} is corrupt`);
      }
      const record = this.read(index.checkpointReference);
      if (!record || record.adminStreamId !== adminStreamId || record.runNumber !== runNumber) {
        throw new Error(`Managed checkpoint ${index.checkpointReference} is missing or unreadable`);
      }
      return record;
    }
    for (const name of this.fileOps.readdirSync(this.stateDir)) {
      const match = /^([0-9a-f-]{36})\.json$/i.exec(name);
      if (!match) {continue;}
      const record = this.read(match[1]);
      if (!record) {throw new Error(`Managed checkpoint ${match[1]} is missing or unreadable`);}
      if (record.adminStreamId === adminStreamId && record.runNumber === runNumber) {
        this.saveRunIndex(record);
        return record;
      }
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

  private validatePreviousEmpty(operation: ManagedContinuationOperation): ManagedCheckpointRecord | null {
    const outcome = operation.previousEmptyOutcome;
    if (!outcome) {return null;}
    if (!validEmptyOutcome(outcome) || outcome.runNumber !== operation.previousRunNumber) {
      throw new Error('Continuation empty outcome does not name the immediate predecessor');
    }
    const predecessor = this.require(outcome.checkpointReference);
    if (
      predecessor.status !== 'empty' ||
      !predecessor.emptyOutcome ||
      !sameValue(predecessor.emptyOutcome, outcome) ||
      predecessor.adminStreamId !== operation.streamId ||
      predecessor.runNumber !== operation.previousRunNumber ||
      predecessor.topic !== operation.topic ||
      predecessor.mediaType !== operation.mediaType
    ) {
      throw new Error('Continuation empty outcome does not match its sealed checkpoint');
    }
    return predecessor;
  }

  private validateRetainedRecording(operation: ManagedContinuationOperation): ManagedCheckpointRecord | null {
    const retained = operation.retainedRecording;
    if (!retained) {return null;}
    const checkpoint = this.require(retained.checkpointReference);
    if (
      checkpoint.status !== 'complete' ||
      !checkpoint.completedRecording ||
      checkpoint.adminStreamId !== operation.streamId ||
      checkpoint.runNumber > operation.previousRunNumber ||
      checkpoint.topic !== operation.topic ||
      checkpoint.mediaType !== operation.mediaType ||
      !sameRecording(checkpoint.completedRecording, retained)
    ) {
      throw new Error('Retained continuation recording does not match its frozen checkpoint');
    }
    return checkpoint;
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
      (record.adoptionCandidateDigest === undefined || REFERENCE.test(record.adoptionCandidateDigest)) &&
      (record.retainedRecording === undefined || validCompletedRecording(record.retainedRecording)) &&
      (record.status === 'prepared' || record.status === 'complete' || record.status === 'empty') &&
      (record.status !== 'complete' ||
        (validCompletedRecording(record.completedRecording) &&
          record.completedRecording.runNumber === record.runNumber &&
          record.completedRecording.checkpointReference === record.checkpointReference)) &&
      (record.status !== 'empty' ||
        (validEmptyOutcome(record.emptyOutcome) &&
          record.emptyOutcome.runNumber === record.runNumber &&
          record.emptyOutcome.checkpointReference === record.checkpointReference))
    );
  }

  private legacyAdoptionRecord(input: AdoptLegacyRecording, checkpointReference: string): ManagedCheckpointRecord {
    if (input.master.topic !== input.topic || input.tracks.length === 0) {
      throw new Error('Refused invalid legacy adoption checkpoint');
    }
    const base: ManagedCheckpointRecord = {
      lifecycleVersion: 1,
      checkpointReference,
      adminStreamId: input.adminStreamId,
      runNumber: 1,
      topic: input.topic,
      mediaType: input.mediaType,
      expectedRenditions: [...input.expectedRenditions],
      operationId: input.operationId,
      adoptionCandidateDigest: input.candidateDigest,
      status: 'complete',
      tracks: input.tracks.map((track) => structuredClone(track)),
    };
    const renditions: ManagedImmutableRenditionReference[] = [];
    if (input.expectedRenditions.length === 0) {
      const track = input.tracks[0];
      if (
        input.tracks.length !== 1 ||
        track.rendition !== null ||
        !track.formatFingerprint ||
        !sameValue(track.manifest, input.master) ||
        track.state.streamRawTopic !== input.topic
      ) {
        throw new Error('Legacy single-track adoption does not match its immutable recording');
      }
    } else {
      if (input.tracks.length !== input.expectedRenditions.length) {
        throw new Error('Legacy ladder adoption is missing an expected rendition');
      }
      for (const expected of input.expectedRenditions) {
        const track = input.tracks.find((candidate) => candidate.rendition === expected.name);
        const manifest = track?.manifest;
        if (
          !track ||
          !track.formatFingerprint ||
          !manifest ||
          !('name' in manifest) ||
          manifest.name !== expected.name ||
          manifest.topic !== expected.topic ||
          manifest.width !== expected.width ||
          manifest.height !== expected.height ||
          track.state.streamRawTopic !== expected.topic
        ) {
          throw new Error(`Legacy adoption rendition ${expected.name} does not match its managed profile`);
        }
        renditions.push(manifest);
      }
    }
    if (!base.tracks.every(validTrack)) {
      throw new Error('Legacy adoption contains an invalid retained track');
    }
    const completedRecording: ManagedCompletedRecording = {
      runNumber: 1,
      checkpointReference,
      master: input.master,
      expectedRenditions: input.expectedRenditions.map(({ name }) => name),
      renditions,
    };
    return { ...base, completedRecording };
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

  private saveRunIndex(record: ManagedCheckpointRecord): void {
    const index: ManagedRunIndex = {
      lifecycleVersion: 1,
      adminStreamId: record.adminStreamId,
      runNumber: record.runNumber,
      checkpointReference: record.checkpointReference,
    };
    this.replaceDurably(this.runIndexPath(record.adminStreamId, record.runNumber), JSON.stringify(index));
  }

  private readRunIndex(filePath: string): ManagedRunIndex | null {
    try {
      const value = JSON.parse(this.fileOps.readFileSync(filePath).toString('utf8')) as Partial<ManagedRunIndex>;
      return value.lifecycleVersion === 1 &&
        typeof value.adminStreamId === 'string' &&
        UUID.test(value.adminStreamId) &&
        safePositiveInteger(value.runNumber) &&
        typeof value.checkpointReference === 'string' &&
        UUID.test(value.checkpointReference)
        ? (value as ManagedRunIndex)
        : null;
    } catch {
      return null;
    }
  }

  private replaceDurably(filePath: string, data: string): void {
    const tmpPath = `${filePath}.tmp`;
    const file = this.fileOps.openSync(tmpPath, 'w', 0o600);
    try {
      this.fileOps.writeFileSync(file, data);
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

  private runIndexPath(adminStreamId: string, runNumber: number): string {
    const key = crypto.createHash('sha256').update(`${adminStreamId}\u0000${runNumber}`).digest('hex');
    return path.join(this.stateDir, `run-${key}.index`);
  }
}

function isPrefix(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return previous.length <= next.length && previous.every((value, index) => sameValue(value, next[index]));
}
