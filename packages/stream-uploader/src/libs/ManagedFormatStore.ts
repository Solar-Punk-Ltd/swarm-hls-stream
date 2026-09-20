import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SourceConnectionIdentity } from '../types.js';

import { DurableFileOps } from './ManagedRunStore.js';
import {
  isMediaFormatFingerprint,
  MediaFormatFingerprint,
  sameMediaFormatFingerprint,
} from './MediaFormatProbe.js';

export interface ManagedFormatInput {
  readonly adminStreamId: string;
  readonly runNumber: number;
  readonly streamId: string;
  readonly topic: string;
  readonly rendition: string | null;
  readonly source: SourceConnectionIdentity;
  readonly sequence: number;
}

interface ManagedOpeningPart {
  readonly sequence: number;
  readonly digest: string;
  readonly inputByteLength: number;
  readonly byteLength: number;
}

export interface ManagedFormatRecord {
  readonly lifecycleVersion: 1;
  readonly adminStreamId: string;
  readonly runNumber: number;
  readonly streamId: string;
  readonly topic: string;
  readonly rendition: string | null;
  readonly source: SourceConnectionIdentity;
  readonly baseline?: MediaFormatFingerprint;
  readonly fingerprint?: MediaFormatFingerprint;
  readonly openingParts: readonly ManagedOpeningPart[];
  readonly openingBytes: string;
}

export type ManagedOpeningResult =
  | { readonly kind: 'ready'; readonly bytes: Buffer }
  | { readonly kind: 'validated'; readonly fingerprint: MediaFormatFingerprint }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'limit' };

export interface ManagedFormatPersistence {
  stage(input: ManagedFormatInput, data: Buffer): ManagedOpeningResult;
  commit(
    input: ManagedFormatInput,
    fingerprint: MediaFormatFingerprint,
    expected?: MediaFormatFingerprint,
  ): MediaFormatFingerprint;
  read(input: Omit<ManagedFormatInput, 'sequence' | 'source'>): ManagedFormatRecord | null;
}

export class ManagedFormatMismatchError extends Error {}

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
const DIGEST = /^[0-9a-f]{64}$/;

function sameSource(left: SourceConnectionIdentity, right: SourceConnectionIdentity): boolean {
  return (
    left.serverId === right.serverId &&
    left.serviceId === right.serviceId &&
    left.clientId === right.clientId &&
    left.generation === right.generation
  );
}

function validSource(value: unknown): value is SourceConnectionIdentity {
  if (!value || typeof value !== 'object') {return false;}
  const source = value as Partial<SourceConnectionIdentity>;
  return (
    typeof source.serverId === 'string' &&
    source.serverId.length > 0 &&
    typeof source.serviceId === 'string' &&
    source.serviceId.length > 0 &&
    typeof source.clientId === 'string' &&
    source.clientId.length > 0 &&
    Number.isSafeInteger(source.generation) &&
    Number(source.generation) >= 0
  );
}

function validRecord(value: unknown): value is ManagedFormatRecord {
  if (!value || typeof value !== 'object') {return false;}
  const record = value as Partial<ManagedFormatRecord>;
  if (
    record.lifecycleVersion !== 1 ||
    typeof record.adminStreamId !== 'string' ||
    !UUID.test(record.adminStreamId) ||
    !Number.isSafeInteger(record.runNumber) ||
    Number(record.runNumber) <= 0 ||
    typeof record.streamId !== 'string' ||
    record.streamId.length === 0 ||
    typeof record.topic !== 'string' ||
    record.topic.length === 0 ||
    (record.rendition !== null && typeof record.rendition !== 'string') ||
    !validSource(record.source) ||
    (record.baseline !== undefined && !isMediaFormatFingerprint(record.baseline)) ||
    (record.fingerprint !== undefined && !isMediaFormatFingerprint(record.fingerprint)) ||
    !Array.isArray(record.openingParts) ||
    typeof record.openingBytes !== 'string'
  ) {
    return false;
  }
  const partsValid = record.openingParts.every(
    (part) =>
      Number.isSafeInteger(part.sequence) &&
      part.sequence >= 0 &&
      DIGEST.test(part.digest) &&
      Number.isSafeInteger(part.inputByteLength) &&
      part.inputByteLength > 0 &&
      Number.isSafeInteger(part.byteLength) &&
      part.byteLength >= 0,
  );
  if (!partsValid || new Set(record.openingParts.map((part) => part.sequence)).size !== record.openingParts.length) {
    return false;
  }
  const bytes = Buffer.from(record.openingBytes, 'base64');
  return bytes.length === record.openingParts.reduce((total, part) => total + part.byteLength, 0);
}

function fileName(input: Pick<ManagedFormatInput, 'adminStreamId' | 'runNumber' | 'streamId'>): string {
  return `${input.adminStreamId}--${input.runNumber}--${encodeURIComponent(input.streamId)}.json`;
}

/** Durable bounded opening bytes and actual-format binding for lifecycle-v1 media tracks. */
export class ManagedFormatStore implements ManagedFormatPersistence {
  constructor(
    private readonly stateDir: string,
    private readonly maxOpeningBytes = 4 * 1024 * 1024,
    private readonly fileOps: DurableFileOps = nodeFileOps,
  ) {
    if (!this.fileOps.existsSync(stateDir)) {
      this.fileOps.mkdirSync(stateDir, { recursive: true });
    }
    this.flushDirectory(path.dirname(stateDir));
  }

  public stage(input: ManagedFormatInput, data: Buffer): ManagedOpeningResult {
    let record = this.read(input);
    if (record && !sameTrack(record, input)) {
      throw new Error(`Managed format track ${input.streamId} conflicts with its durable binding`);
    }
    if (!record || !sameSource(record.source, input.source)) {
      record = {
        lifecycleVersion: 1,
        adminStreamId: input.adminStreamId,
        runNumber: input.runNumber,
        streamId: input.streamId,
        topic: input.topic,
        rendition: input.rendition,
        source: input.source,
        baseline: record?.baseline,
        openingParts: [],
        openingBytes: '',
      };
    }
    if (record.fingerprint) {
      return { kind: 'validated', fingerprint: record.fingerprint };
    }
    const digest = createHash('sha256').update(data).digest('hex');
    const existing = record.openingParts.find((part) => part.sequence === input.sequence);
    if (existing) {
      return existing.digest === digest && existing.inputByteLength === data.length
        ? { kind: 'ready', bytes: Buffer.from(record.openingBytes, 'base64') }
        : { kind: 'conflict' };
    }
    const previous = Buffer.from(record.openingBytes, 'base64');
    if (previous.length >= this.maxOpeningBytes) {
      return { kind: 'limit' };
    }
    const retained = data.subarray(0, this.maxOpeningBytes - previous.length);
    const bytes = Buffer.concat([previous, retained]);
    const updated: ManagedFormatRecord = {
      ...record,
      openingParts: [
        ...record.openingParts,
        { sequence: input.sequence, digest, inputByteLength: data.length, byteLength: retained.length },
      ],
      openingBytes: bytes.toString('base64'),
    };
    this.save(updated);
    return { kind: 'ready', bytes };
  }

  public commit(
    input: ManagedFormatInput,
    fingerprint: MediaFormatFingerprint,
    expected?: MediaFormatFingerprint,
  ): MediaFormatFingerprint {
    const record = this.read(input);
    if (!record || !sameTrack(record, input) || !sameSource(record.source, input.source)) {
      throw new Error(`Managed format source ${input.streamId} changed before validation completed`);
    }
    const required = expected ?? record.baseline;
    if (required && !sameMediaFormatFingerprint(required, fingerprint)) {
      throw new ManagedFormatMismatchError(
        `Managed format track ${input.streamId} changed from its durable fingerprint`,
      );
    }
    const baseline = record.baseline ?? fingerprint;
    const updated: ManagedFormatRecord = {
      ...record,
      baseline,
      fingerprint,
      openingParts: [],
      openingBytes: '',
    };
    this.save(updated);
    return fingerprint;
  }

  public read(input: Omit<ManagedFormatInput, 'sequence' | 'source'>): ManagedFormatRecord | null {
    const filePath = path.join(this.stateDir, fileName(input));
    if (!this.fileOps.existsSync(filePath)) {return null;}
    this.flushDirectory(this.stateDir);
    try {
      const parsed: unknown = JSON.parse(this.fileOps.readFileSync(filePath, 'utf8'));
      if (!validRecord(parsed)) {throw new Error('invalid record');}
      return parsed;
    } catch {
      throw new Error(`Managed format record ${filePath} is unreadable`);
    }
  }

  private save(record: ManagedFormatRecord): void {
    if (!validRecord(record)) {throw new Error('Refused invalid managed format record');}
    const filePath = path.join(this.stateDir, fileName(record));
    const temporaryPath = `${filePath}.tmp`;
    const file = this.fileOps.openSync(temporaryPath, 'w', 0o600);
    try {
      this.fileOps.writeFileSync(file, JSON.stringify(record));
      this.fileOps.fsyncSync(file);
    } finally {
      this.fileOps.closeSync(file);
    }
    this.fileOps.renameSync(temporaryPath, filePath);
    this.flushDirectory(this.stateDir);
  }

  private flushDirectory(directory: string): void {
    const descriptor = this.fileOps.openSync(directory, 'r');
    try {
      this.fileOps.fsyncSync(descriptor);
    } finally {
      this.fileOps.closeSync(descriptor);
    }
  }
}

function sameTrack(record: ManagedFormatRecord, input: Omit<ManagedFormatInput, 'sequence'>): boolean {
  return (
    record.adminStreamId === input.adminStreamId &&
    record.runNumber === input.runNumber &&
    record.streamId === input.streamId &&
    record.topic === input.topic &&
    record.rendition === input.rendition
  );
}
