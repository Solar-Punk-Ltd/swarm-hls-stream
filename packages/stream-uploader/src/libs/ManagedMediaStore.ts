import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SourceConnectionIdentity, StreamState } from '../types.js';

export interface ManagedMediaInput {
  readonly lifecycleVersion: 1;
  readonly adminStreamId: string;
  readonly runNumber: number;
  readonly streamId: string;
  readonly source: SourceConnectionIdentity;
  readonly rendition: string | null;
  readonly sequence: number;
  readonly duration: number;
  readonly discontinuity: boolean;
}

export interface ManagedMediaRecord extends ManagedMediaInput {
  readonly token: string;
  readonly ordinal: number;
  readonly digest: string;
  readonly byteLength: number;
  readonly status: 'pending' | 'committed';
  readonly reference?: string;
  readonly trackState?: StreamState;
}

export type ManagedMediaAcceptance =
  | { kind: 'accepted'; record: ManagedMediaRecord }
  | { kind: 'duplicate'; record: ManagedMediaRecord }
  | { kind: 'conflict' };

/** Synchronous filesystem boundary required before an engine callback can be acknowledged. */
export interface ManagedMediaFileOps {
  mkdirSync(target: string, options: { recursive: true }): unknown;
  existsSync(target: string): boolean;
  readdirSync(target: string): string[];
  readFileSync(target: string): Buffer;
  openSync(target: string, flags: string, mode?: number): number;
  writeFileSync(fd: number, data: string | Uint8Array): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  rmSync(target: string): void;
}

const nodeFileOps: ManagedMediaFileOps = {
  mkdirSync: (target, options) => fs.mkdirSync(target, options),
  existsSync: (target) => fs.existsSync(target),
  readdirSync: (target) => fs.readdirSync(target),
  readFileSync: (target) => fs.readFileSync(target),
  openSync: (target, flags, mode) => fs.openSync(target, flags, mode),
  writeFileSync: (fd, data) => fs.writeFileSync(fd, data),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (from, to) => fs.renameSync(from, to),
  rmSync: (target) => fs.rmSync(target, { force: true }),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_REFERENCE = /^[0-9a-f]{64}$/i;

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSource(value: unknown): value is SourceConnectionIdentity {
  if (!value || typeof value !== 'object') {return false;}
  const source = value as Partial<SourceConnectionIdentity>;
  return (
    typeof source.serverId === 'string' &&
    source.serverId.length > 0 &&
    typeof source.serviceId === 'string' &&
    source.serviceId.length > 0 &&
    typeof source.clientId === 'string' &&
    source.clientId.length > 0 &&
    nonNegativeInteger(source.generation)
  );
}

function isInput(value: unknown): value is ManagedMediaInput {
  if (!value || typeof value !== 'object') {return false;}
  const input = value as Partial<ManagedMediaInput>;
  return (
    input.lifecycleVersion === 1 &&
    typeof input.adminStreamId === 'string' &&
    UUID.test(input.adminStreamId) &&
    positiveInteger(input.runNumber) &&
    typeof input.streamId === 'string' &&
    input.streamId.length > 0 &&
    isSource(input.source) &&
    (input.rendition === null || (typeof input.rendition === 'string' && input.rendition.length > 0)) &&
    nonNegativeInteger(input.sequence) &&
    finiteNonNegative(input.duration) &&
    typeof input.discontinuity === 'boolean'
  );
}

function isStreamState(value: unknown): value is StreamState {
  if (!value || typeof value !== 'object') {return false;}
  const state = value as Partial<StreamState>;
  return (
    typeof state.streamId === 'string' &&
    state.streamId.length > 0 &&
    typeof state.streamRawTopic === 'string' &&
    state.streamRawTopic.length > 0 &&
    (state.mediatype === 'video' || state.mediatype === 'audio') &&
    (state.socIndex === null || nonNegativeInteger(state.socIndex)) &&
    Array.isArray(state.segments) &&
    Array.isArray(state.hlsHeaders) &&
    typeof state.isFirstSegmentReady === 'boolean' &&
    typeof state.isFirstManifestReady === 'boolean' &&
    finiteNonNegative(state.updatedAt)
  );
}

function isRecord(value: unknown): value is ManagedMediaRecord {
  if (!isInput(value)) {return false;}
  const record = value as Partial<ManagedMediaRecord>;
  return (
    typeof record.token === 'string' &&
    /^[0-9a-f]{64}$/.test(record.token) &&
    nonNegativeInteger(record.ordinal) &&
    typeof record.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(record.digest) &&
    nonNegativeInteger(record.byteLength) &&
    (record.status === 'pending' || record.status === 'committed') &&
    (record.status === 'pending' ||
      (typeof record.reference === 'string' && HEX_REFERENCE.test(record.reference) && isStreamState(record.trackState)))
  );
}

function identityJson(input: ManagedMediaInput): string {
  return JSON.stringify({
    adminStreamId: input.adminStreamId,
    runNumber: input.runNumber,
    streamId: input.streamId,
    source: input.source,
    rendition: input.rendition,
    sequence: input.sequence,
  });
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function sameAcceptedPayload(record: ManagedMediaRecord, input: ManagedMediaInput, data: Uint8Array): boolean {
  return (
    record.duration === input.duration &&
    record.discontinuity === input.discontinuity &&
    record.byteLength === data.byteLength &&
    record.digest === digest(data)
  );
}

/** Durable journal for media callbacks accepted from lifecycle-v1 sources. */
export class ManagedMediaStore {
  constructor(
    private readonly stateDir: string,
    private readonly fileOps: ManagedMediaFileOps = nodeFileOps,
  ) {
    if (!this.fileOps.existsSync(stateDir)) {
      this.fileOps.mkdirSync(stateDir, { recursive: true });
      this.flushDirectory(path.dirname(stateDir));
    }
  }

  public accept(input: ManagedMediaInput, data: Uint8Array): ManagedMediaAcceptance {
    if (!isInput(input) || data.byteLength === 0) {
      throw new Error('Refused to persist invalid managed media');
    }
    const token = digest(Buffer.from(identityJson(input), 'utf8'));
    const existing = this.readRecord(token);
    if (existing) {
      this.flushDirectory(this.stateDir);
      return sameAcceptedPayload(existing, input, data) ? { kind: 'duplicate', record: existing } : { kind: 'conflict' };
    }

    const record: ManagedMediaRecord = {
      ...input,
      token,
      ordinal: this.nextOrdinal(input.adminStreamId, input.runNumber),
      digest: digest(data),
      byteLength: data.byteLength,
      status: 'pending',
    };
    this.replaceDurably(this.bytesPath(token), data);
    this.replaceDurably(this.metadataPath(token), JSON.stringify(record));
    return { kind: 'accepted', record };
  }

  public commitUploaded(token: string, reference: string, trackState: StreamState): ManagedMediaRecord {
    const record = this.requireRecord(token);
    if (!HEX_REFERENCE.test(reference) || !isStreamState(trackState)) {
      throw new Error('Refused to commit invalid managed media history');
    }
    const segment = [...trackState.segments]
      .reverse()
      .find((candidate) => candidate.index === record.sequence && candidate.ref === reference);
    if (!segment || trackState.streamId !== record.streamId) {
      throw new Error('Refused to commit managed media without its placed segment history');
    }
    if (record.status === 'committed') {
      if (record.reference !== reference || JSON.stringify(record.trackState) !== JSON.stringify(trackState)) {
        throw new Error('Refused conflicting managed media history');
      }
      this.flushDirectory(this.stateDir);
      return record;
    }

    const committed: ManagedMediaRecord = { ...record, status: 'committed', reference, trackState };
    this.replaceDurably(this.metadataPath(token), JSON.stringify(committed));
    try {
      this.fileOps.rmSync(this.bytesPath(token));
      this.flushDirectory(this.stateDir);
    } catch {
      // The durable committed record is sufficient to suppress a second upload. Raw cleanup is safe
      // to repeat after restart and must never roll back history that already reached disk.
    }
    return committed;
  }

  public readBytes(token: string): Buffer | null {
    const record = this.requireRecord(token);
    if (record.status === 'committed') {return null;}
    const filePath = this.bytesPath(token);
    if (!this.fileOps.existsSync(filePath)) {
      throw new Error(`Managed media ${token} is pending but its bytes are missing`);
    }
    const data = this.fileOps.readFileSync(filePath);
    if (data.byteLength !== record.byteLength || digest(data) !== record.digest) {
      throw new Error(`Managed media ${token} bytes do not match their durable digest`);
    }
    return data;
  }

  public listPending(adminStreamId: string, runNumber: number): ManagedMediaRecord[] {
    return this.listRun(adminStreamId, runNumber).filter((record) => record.status === 'pending');
  }

  public listRun(adminStreamId: string, runNumber: number): ManagedMediaRecord[] {
    return this.fileOps
      .readdirSync(this.stateDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.requireRecord(name.slice(0, -'.json'.length)))
      .filter((record) => record.adminStreamId === adminStreamId && record.runNumber === runNumber)
      .sort((left, right) => left.ordinal - right.ordinal);
  }

  private nextOrdinal(adminStreamId: string, runNumber: number): number {
    const records = this.listRun(adminStreamId, runNumber);
    return records.length === 0 ? 0 : Math.max(...records.map((record) => record.ordinal)) + 1;
  }

  private requireRecord(token: string): ManagedMediaRecord {
    const record = this.readRecord(token);
    if (!record) {throw new Error(`Managed media record ${token} is missing or unreadable`);}
    return record;
  }

  private readRecord(token: string): ManagedMediaRecord | null {
    const filePath = this.metadataPath(token);
    if (!this.fileOps.existsSync(filePath)) {return null;}
    try {
      const value: unknown = JSON.parse(this.fileOps.readFileSync(filePath).toString('utf8'));
      return isRecord(value) && value.token === token ? value : null;
    } catch {
      return null;
    }
  }

  private replaceDurably(filePath: string, data: string | Uint8Array): void {
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

  private bytesPath(token: string): string {
    return path.join(this.stateDir, `${token}.bin`);
  }

  private metadataPath(token: string): string {
    return path.join(this.stateDir, `${token}.json`);
  }
}
