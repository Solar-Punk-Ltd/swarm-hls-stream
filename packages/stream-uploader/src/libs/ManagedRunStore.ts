import fs from 'node:fs';
import path from 'node:path';

import { MediaType, SourceConnectionIdentity } from '../types.js';

import { ManagedExpectedRendition } from './ManagedCheckpointStore.js';

export const MANAGED_RUN_MISSING = 'missing' as const;
export const MANAGED_RUN_LOADED = 'loaded' as const;
export const MANAGED_RUN_UNREADABLE = 'unreadable' as const;

export type ManagedRunState = 'claiming' | 'claimed' | 'live' | 'waiting' | 'closed' | 'vod';
export type ManagedRunCloseReason =
  | 'reconnect_timeout'
  | 'cancelled'
  | 'recovery_required'
  | 'finalization_failed'
  | 'empty';

export interface ManagedRungConnectionRecord {
  readonly streamId: string;
  readonly connection: Omit<SourceConnectionIdentity, 'generation'>;
  readonly source: SourceConnectionIdentity;
}

/** Admission state that must outlive normal media-recovery cleanup. */
export interface ManagedRunRecord {
  readonly lifecycleVersion: 1;
  readonly streamId: string;
  readonly adminStreamId: string;
  readonly topic: string;
  readonly mediaType: MediaType;
  readonly revision: number;
  readonly runNumber: number;
  readonly uploaderId: string;
  readonly claimId: string | null;
  readonly claimRequestId: string;
  readonly eventSequence: number;
  readonly expectedRenditions: readonly ManagedExpectedRendition[];
  readonly checkpointReference: string;
  readonly state: ManagedRunState;
  readonly deadlineWallMs: number;
  readonly deadlineRecordedAtWallMs: number;
  readonly deadlineRemainingMs: number;
  readonly lastProgressPts: number | null;
  readonly source: SourceConnectionIdentity | null;
  readonly rungConnections: readonly ManagedRungConnectionRecord[];
  readonly pendingReports: readonly ManagedRunReportRecord[];
  /** Last durable observation that was validated locally. Missing only on records written before this field existed. */
  readonly lastObservedAt?: string;
  readonly closeReason?: ManagedRunCloseReason;
}

export interface ManagedRunReportRecord {
  readonly lifecycleVersion: 1;
  readonly runNumber: number;
  readonly uploaderId: string;
  readonly claimId: string;
  readonly eventSequence: number;
  readonly observedAt: string;
  readonly state: 'live' | 'waiting' | 'closed' | 'vod';
  readonly reconnectDeadline?: string;
  readonly reason?: 'reconnect_timeout' | 'cancelled' | 'recovery_required' | 'finalization_failed' | 'empty';
  readonly emptyOutcome?: { checkpointReference: string; acceptedMediaCount: 0 };
  readonly completedRecording?: unknown;
}

/** The immutable claim fields. Deadline and source progress are owned by this process. */
export type ManagedRunClaim = Omit<
  ManagedRunRecord,
  | 'state'
  | 'deadlineWallMs'
  | 'deadlineRecordedAtWallMs'
  | 'deadlineRemainingMs'
  | 'lastProgressPts'
  | 'source'
  | 'rungConnections'
  | 'claimRequestId'
  | 'checkpointReference'
  | 'pendingReports'
  | 'lastObservedAt'
  | 'closeReason'
>;

export type ManagedClaimAttempt = Omit<ManagedRunClaim, 'claimId' | 'eventSequence'>;

export interface ManagedClaimDecision {
  readonly requestId: string;
  readonly expectedRevision: number;
  /** False once this process already holds the durable claim for this run. */
  readonly needsClaim: boolean;
}

export interface ManagedClaimCompletion {
  readonly lifecycleVersion: 1;
  readonly streamId: string;
  readonly revision: number;
  readonly runNumber: number;
  readonly uploaderId: string;
  readonly claimId: string;
  readonly expectedRenditions: readonly ManagedExpectedRendition[];
  readonly state: 'claimed';
  readonly permission: 'claimed';
}

export type ManagedRunEntry =
  | { kind: typeof MANAGED_RUN_MISSING }
  | { kind: typeof MANAGED_RUN_LOADED; record: ManagedRunRecord }
  | { kind: typeof MANAGED_RUN_UNREADABLE };

/** Admission persistence used by the orchestrator and replaceable with a faulting store in tests. */
export interface ManagedRunPersistence {
  save(record: ManagedRunRecord): void;
  read(streamId: string): ManagedRunEntry;
  list(): string[];
}

/** The synchronous operations whose completion makes one save durable enough to acknowledge. */
export interface DurableFileOps {
  mkdirSync(target: string, options: { recursive: true }): unknown;
  existsSync(target: string): boolean;
  readdirSync(target: string): string[];
  readFileSync(target: string, encoding: BufferEncoding): string;
  openSync(target: string, flags: string, mode?: number): number;
  writeFileSync(fd: number, data: string): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
}

const nodeFileOps: DurableFileOps = {
  mkdirSync: (target, options) => fs.mkdirSync(target, options),
  existsSync: (target) => fs.existsSync(target),
  readdirSync: (target) => fs.readdirSync(target),
  readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
  openSync: (target, flags, mode) => fs.openSync(target, flags, mode),
  writeFileSync: (fd, data) => fs.writeFileSync(fd, data),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (from, to) => fs.renameSync(from, to),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set<ManagedRunState>(['claiming', 'claimed', 'live', 'waiting', 'closed', 'vod']);
const PTS_MODULUS = 2 ** 33;

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isSource(value: unknown): value is SourceConnectionIdentity {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const source = value as Partial<SourceConnectionIdentity>;
  return (
    typeof source.serverId === 'string' &&
    source.serverId.length > 0 &&
    typeof source.serviceId === 'string' &&
    source.serviceId.length > 0 &&
    typeof source.clientId === 'string' &&
    source.clientId.length > 0 &&
    isNonNegativeInteger(source.generation)
  );
}

function isConnection(value: unknown): value is Omit<SourceConnectionIdentity, 'generation'> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const connection = value as Partial<SourceConnectionIdentity>;
  return (
    typeof connection.serverId === 'string' &&
    connection.serverId.length > 0 &&
    typeof connection.serviceId === 'string' &&
    connection.serviceId.length > 0 &&
    typeof connection.clientId === 'string' &&
    connection.clientId.length > 0
  );
}

function isRungConnection(value: unknown): value is ManagedRungConnectionRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const connection = value as Partial<ManagedRungConnectionRecord>;
  return (
    typeof connection.streamId === 'string' &&
    connection.streamId.length > 0 &&
    isConnection(connection.connection) &&
    isSource(connection.source)
  );
}

function isManagedRunRecord(value: unknown): value is ManagedRunRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<ManagedRunRecord>;
  const eventSequence = record.eventSequence;
  const pendingReports = record.pendingReports;
  return (
    record.lifecycleVersion === 1 &&
    typeof record.streamId === 'string' &&
    record.streamId.length > 0 &&
    typeof record.adminStreamId === 'string' &&
    UUID.test(record.adminStreamId) &&
    typeof record.topic === 'string' &&
    record.topic.length > 0 &&
    (record.mediaType === 'video' || record.mediaType === 'audio') &&
    isNonNegativeInteger(record.revision) &&
    isPositiveInteger(record.runNumber) &&
    typeof record.uploaderId === 'string' &&
    record.uploaderId.length > 0 &&
    (record.claimId === null || (typeof record.claimId === 'string' && UUID.test(record.claimId))) &&
    typeof record.claimRequestId === 'string' &&
    UUID.test(record.claimRequestId) &&
    isNonNegativeInteger(eventSequence) &&
    Array.isArray(record.expectedRenditions) &&
    record.expectedRenditions.every(isExpectedRendition) &&
    new Set(record.expectedRenditions.map((rendition) => rendition.name)).size === record.expectedRenditions.length &&
    typeof record.checkpointReference === 'string' &&
    UUID.test(record.checkpointReference) &&
    typeof record.state === 'string' &&
    STATES.has(record.state as ManagedRunState) &&
    isNonNegativeInteger(record.deadlineWallMs) &&
    isNonNegativeInteger(record.deadlineRecordedAtWallMs) &&
    isNonNegativeInteger(record.deadlineRemainingMs) &&
    (record.lastProgressPts === null ||
      (isNonNegativeInteger(record.lastProgressPts) && record.lastProgressPts < PTS_MODULUS)) &&
    (record.source === null || isSource(record.source)) &&
    Array.isArray(record.rungConnections) &&
    record.rungConnections.every(isRungConnection) &&
    new Set(record.rungConnections.map((connection) => connection.streamId)).size === record.rungConnections.length &&
    Array.isArray(pendingReports) &&
    pendingReports.every(
      (report) =>
        isManagedRunReport(report) &&
        report.runNumber === record.runNumber &&
        report.uploaderId === record.uploaderId &&
        report.claimId === record.claimId,
    ) &&
    pendingReports.every(
      (report, index) => report.eventSequence === eventSequence - pendingReports.length + index + 1,
    ) &&
    (record.lastObservedAt === undefined ||
      (typeof record.lastObservedAt === 'string' && Number.isFinite(Date.parse(record.lastObservedAt)))) &&
    (record.closeReason === undefined ||
      record.closeReason === 'reconnect_timeout' ||
      record.closeReason === 'cancelled' ||
      record.closeReason === 'recovery_required' ||
      record.closeReason === 'finalization_failed' ||
      record.closeReason === 'empty') &&
    ((record.state === 'claiming' && record.claimId === null) ||
      (record.state === 'closed' &&
        record.claimId === null &&
        record.deadlineRemainingMs === 0 &&
        record.source === null &&
        record.rungConnections.length === 0 &&
        pendingReports.length === 0) ||
      (record.state !== 'claiming' && record.claimId !== null))
  );
}

function isExpectedRendition(value: unknown): value is ManagedExpectedRendition {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const rendition = value as Partial<ManagedExpectedRendition>;
  return (
    typeof rendition.name === 'string' &&
    rendition.name.length > 0 &&
    typeof rendition.topic === 'string' &&
    rendition.topic.length > 0 &&
    isPositiveInteger(rendition.width) &&
    isPositiveInteger(rendition.height) &&
    isPositiveInteger(rendition.bandwidth) &&
    isPositiveInteger(rendition.avgBandwidth)
  );
}

function isManagedRunReport(value: unknown): value is ManagedRunReportRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const report = value as Partial<ManagedRunReportRecord>;
  return (
    report.lifecycleVersion === 1 &&
    isPositiveInteger(report.runNumber) &&
    typeof report.uploaderId === 'string' &&
    report.uploaderId.length > 0 &&
    typeof report.claimId === 'string' &&
    UUID.test(report.claimId) &&
    isPositiveInteger(report.eventSequence) &&
    typeof report.observedAt === 'string' &&
    Number.isFinite(Date.parse(report.observedAt)) &&
    (report.state === 'live' || report.state === 'waiting' || report.state === 'closed' || report.state === 'vod')
  );
}

function entryName(streamId: string): string {
  return `${encodeURIComponent(streamId)}.json`;
}

/**
 * Remaining monotonic budget reconstructed conservatively from a persisted wall checkpoint.
 * A wall clock that moved backwards is untrustworthy and expires the run instead of granting time.
 */
export function remainingManagedDeadline(record: ManagedRunRecord, nowWallMs: number): number {
  if (!Number.isFinite(nowWallMs) || nowWallMs < record.deadlineRecordedAtWallMs) {
    return 0;
  }
  const elapsed = nowWallMs - record.deadlineRecordedAtWallMs;
  const fromCheckpoint = Math.max(0, record.deadlineRemainingMs - elapsed);
  const fromAbsoluteDeadline = Math.max(0, record.deadlineWallMs - nowWallMs);
  return Math.min(fromCheckpoint, fromAbsoluteDeadline);
}

export class ManagedRunStore implements ManagedRunPersistence {
  constructor(private readonly stateDir: string, private readonly fileOps: DurableFileOps = nodeFileOps) {
    if (!this.fileOps.existsSync(stateDir)) {
      this.fileOps.mkdirSync(stateDir, { recursive: true });
      this.flushDirectory(path.dirname(stateDir));
    }
  }

  /** Returns only after file contents and the renamed directory entry have both been flushed. */
  public save(record: ManagedRunRecord): void {
    if (!isManagedRunRecord(record)) {
      throw new Error('Refused to persist an invalid managed run record');
    }
    const filePath = path.join(this.stateDir, entryName(record.streamId));
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

  public read(streamId: string): ManagedRunEntry {
    const filePath = path.join(this.stateDir, entryName(streamId));
    if (!this.fileOps.existsSync(filePath)) {
      return { kind: MANAGED_RUN_MISSING };
    }
    try {
      const parsed: unknown = JSON.parse(this.fileOps.readFileSync(filePath, 'utf8'));
      if (!isManagedRunRecord(parsed) || parsed.streamId !== streamId) {
        return { kind: MANAGED_RUN_UNREADABLE };
      }
      return { kind: MANAGED_RUN_LOADED, record: parsed };
    } catch {
      return { kind: MANAGED_RUN_UNREADABLE };
    }
  }

  public list(): string[] {
    if (!this.fileOps.existsSync(this.stateDir)) {
      return [];
    }
    return this.fileOps
      .readdirSync(this.stateDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => decodeURIComponent(name.slice(0, -'.json'.length)));
  }
}
