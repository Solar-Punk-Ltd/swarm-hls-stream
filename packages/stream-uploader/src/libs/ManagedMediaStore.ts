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
}

export interface ManagedTrackJournal {
  readonly lifecycleVersion: 1;
  readonly adminStreamId: string;
  readonly runNumber: number;
  readonly streamId: string;
  readonly rendition: string | null;
  readonly lastToken?: string;
  readonly lastReference?: string;
  readonly state: StreamState;
}

export type ManagedMediaAcceptance =
  | { kind: 'accepted'; record: ManagedMediaRecord }
  | { kind: 'duplicate'; record: ManagedMediaRecord }
  | { kind: 'conflict' };
export type ManagedMediaExisting = 'missing' | 'duplicate' | 'conflict';

/** The durable managed-media boundary used by the orchestrator and replaceable in focused tests. */
export interface ManagedMediaPersistence {
  initializeTrack(
    adminStreamId: string,
    runNumber: number,
    streamId: string,
    rendition: string | null,
    state: StreamState,
  ): void;
  restoreTrack(
    adminStreamId: string,
    runNumber: number,
    streamId: string,
    rendition: string | null,
    state: StreamState,
  ): void;
  find(input: ManagedMediaInput, data: Uint8Array): ManagedMediaExisting;
  accept(input: ManagedMediaInput, data: Uint8Array): ManagedMediaAcceptance;
  commitUploaded(token: string, reference: string, trackState: StreamState): ManagedMediaRecord;
  readBytes(token: string): Buffer | null;
  listPending(adminStreamId: string, runNumber: number): ManagedMediaRecord[];
  listRun(adminStreamId: string, runNumber: number): ManagedMediaRecord[];
  listTrackStates(adminStreamId: string, runNumber: number): ManagedTrackJournal[];
  readTrackState(
    adminStreamId: string,
    runNumber: number,
    streamId: string,
    rendition: string | null,
  ): StreamState | null;
  saveTrackState(
    adminStreamId: string,
    runNumber: number,
    streamId: string,
    rendition: string | null,
    state: StreamState,
  ): void;
}

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
    nonNegativeInteger(source.generation)
  );
}

function isInput(value: unknown): value is ManagedMediaInput {
  if (!value || typeof value !== 'object') {
    return false;
  }
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
  if (!value || typeof value !== 'object') {
    return false;
  }
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
  if (!isInput(value)) {
    return false;
  }
  const record = value as Partial<ManagedMediaRecord>;
  return (
    typeof record.token === 'string' &&
    /^[0-9a-f]{64}$/.test(record.token) &&
    nonNegativeInteger(record.ordinal) &&
    typeof record.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(record.digest) &&
    nonNegativeInteger(record.byteLength) &&
    (record.status === 'pending' || record.status === 'committed') &&
    (record.status === 'pending' || (typeof record.reference === 'string' && HEX_REFERENCE.test(record.reference)))
  );
}

function isTrackJournal(value: unknown): value is ManagedTrackJournal {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const journal = value as Partial<ManagedTrackJournal>;
  return (
    journal.lifecycleVersion === 1 &&
    typeof journal.adminStreamId === 'string' &&
    UUID.test(journal.adminStreamId) &&
    positiveInteger(journal.runNumber) &&
    typeof journal.streamId === 'string' &&
    journal.streamId.length > 0 &&
    (journal.rendition === null || (typeof journal.rendition === 'string' && journal.rendition.length > 0)) &&
    ((journal.lastToken === undefined && journal.lastReference === undefined) ||
      (typeof journal.lastToken === 'string' &&
        HEX_REFERENCE.test(journal.lastToken) &&
        typeof journal.lastReference === 'string' &&
        HEX_REFERENCE.test(journal.lastReference))) &&
    isStreamState(journal.state) &&
    journal.state.streamId === journal.streamId
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

/** Durable journal for media callbacks accepted from lifecycle-v1 sources. */
export class ManagedMediaStore implements ManagedMediaPersistence {
  private readonly nextOrdinals = new Map<string, number>();

  constructor(private readonly stateDir: string, private readonly fileOps: ManagedMediaFileOps = nodeFileOps) {
    if (!this.fileOps.existsSync(stateDir)) {
      this.fileOps.mkdirSync(stateDir, { recursive: true });
      this.flushDirectory(path.dirname(stateDir));
    }
    this.loadOrdinals();
  }

  public initializeTrack(
    adminStreamId: string,
    runNumber: number,
    streamId: string,
    rendition: string | null,
    state: StreamState,
  ): void {
    const identity = { adminStreamId, runNumber, streamId, rendition };
    if (
      !UUID.test(adminStreamId) ||
      !positiveInteger(runNumber) ||
      streamId.length === 0 ||
      (rendition !== null && rendition.length === 0) ||
      !isStreamState(state) ||
      state.streamId !== streamId ||
      state.segments.length !== 0
    ) {
      throw new Error(`Refused invalid managed track initialization for ${streamId}`);
    }
    const filePath = this.trackPath(identity);
    const existing = this.readTrackJournal(identity);
    if (existing) {
      this.flushDirectory(this.stateDir);
      return;
    }
    if (this.fileOps.existsSync(filePath)) {
      throw new Error(`Managed track journal for ${streamId} is unreadable`);
    }
    const journal: ManagedTrackJournal = {
      lifecycleVersion: 1,
      ...identity,
      state,
    };
    this.replaceDurably(filePath, JSON.stringify(journal));
  }

  /** Seed a new managed run from its already verified cumulative checkpoint. */
  public restoreTrack(
    adminStreamId: string,
    runNumber: number,
    streamId: string,
    rendition: string | null,
    state: StreamState,
  ): void {
    const identity = { adminStreamId, runNumber, streamId, rendition };
    if (
      !UUID.test(adminStreamId) ||
      !positiveInteger(runNumber) ||
      streamId.length === 0 ||
      (rendition !== null && rendition.length === 0) ||
      !isStreamState(state) ||
      state.streamId !== streamId
    ) {
      throw new Error(`Refused invalid managed track restore for ${streamId}`);
    }
    const filePath = this.trackPath(identity);
    const existing = this.readTrackJournal(identity);
    if (existing) {
      if (!sameValue(existing.state, state)) {
        throw new Error(`Managed track ${streamId} is already restored with different history`);
      }
      this.flushDirectory(this.stateDir);
      return;
    }
    if (this.fileOps.existsSync(filePath)) {
      throw new Error(`Managed track journal for ${streamId} is unreadable`);
    }
    const journal: ManagedTrackJournal = {
      lifecycleVersion: 1,
      ...identity,
      state,
    };
    this.replaceDurably(filePath, JSON.stringify(journal));
  }

  public accept(input: ManagedMediaInput, data: Uint8Array): ManagedMediaAcceptance {
    if (!isInput(input) || data.byteLength === 0) {
      throw new Error('Refused to persist invalid managed media');
    }
    const token = digest(Buffer.from(identityJson(input), 'utf8'));
    const existing = this.readRecord(token);
    if (existing) {
      this.observeOrdinal(existing);
      this.flushDirectory(this.stateDir);
      return sameAcceptedPayload(existing, input, data)
        ? { kind: 'duplicate', record: existing }
        : { kind: 'conflict' };
    }

    const runKey = this.runKey(input.adminStreamId, input.runNumber);
    const record: ManagedMediaRecord = {
      ...input,
      token,
      ordinal: this.nextOrdinals.get(runKey) ?? 0,
      digest: digest(data),
      byteLength: data.byteLength,
      status: 'pending',
    };
    this.replaceDurably(this.bytesPath(token), data);
    try {
      this.replaceDurably(this.metadataPath(token), JSON.stringify(record));
      this.nextOrdinals.set(runKey, record.ordinal + 1);
    } catch (error) {
      this.loadOrdinals();
      throw error;
    }
    return { kind: 'accepted', record };
  }

  public find(input: ManagedMediaInput, data: Uint8Array): ManagedMediaExisting {
    if (!isInput(input) || data.byteLength === 0) {
      return 'missing';
    }
    const existing = this.readRecord(digest(Buffer.from(identityJson(input), 'utf8')));
    if (!existing) {
      return 'missing';
    }
    return sameAcceptedPayload(existing, input, data) ? 'duplicate' : 'conflict';
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
      if (record.reference !== reference) {
        throw new Error('Refused conflicting managed media history');
      }
      this.flushDirectory(this.stateDir);
      return record;
    }

    const previousJournal = this.readTrackJournal(record);
    if (previousJournal && !isPrefix(previousJournal.state.segments, trackState.segments)) {
      throw new Error(`Managed track ${record.streamId} does not preserve its cumulative segment history`);
    }
    const journal: ManagedTrackJournal = {
      lifecycleVersion: 1,
      adminStreamId: record.adminStreamId,
      runNumber: record.runNumber,
      streamId: record.streamId,
      rendition: record.rendition,
      lastToken: record.token,
      lastReference: reference,
      state: trackState,
    };
    this.replaceDurably(this.trackPath(record), JSON.stringify(journal));
    const committed: ManagedMediaRecord = { ...record, status: 'committed', reference };
    this.replaceDurably(this.metadataPath(token), JSON.stringify(committed));
    this.removeRaw(token);
    return committed;
  }

  public readBytes(token: string): Buffer | null {
    const record = this.requireRecord(token);
    if (record.status === 'committed') {
      return null;
    }
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
      .filter((name) => /^[0-9a-f]{64}\.json$/i.test(name))
      .map((name) => this.requireRecord(name.slice(0, -'.json'.length)))
      .filter((record) => record.adminStreamId === adminStreamId && record.runNumber === runNumber)
      .sort((left, right) => left.ordinal - right.ordinal);
  }

  public listTrackStates(adminStreamId: string, runNumber: number): ManagedTrackJournal[] {
    const journals: ManagedTrackJournal[] = [];
    for (const name of this.fileOps.readdirSync(this.stateDir)) {
      if (!/^track-[0-9a-f]{64}\.json$/i.test(name)) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(this.fileOps.readFileSync(path.join(this.stateDir, name)).toString('utf8'));
      } catch {
        throw new Error(`Managed track journal ${name} is unreadable`);
      }
      if (!isTrackJournal(value)) {
        throw new Error(`Managed track journal ${name} is invalid`);
      }
      if (value.adminStreamId === adminStreamId && value.runNumber === runNumber) {
        journals.push(value);
      }
    }
    return journals.sort((left, right) => left.streamId.localeCompare(right.streamId));
  }

  public readTrackState(
    adminStreamId: string,
    runNumber: number,
    streamId: string,
    rendition: string | null,
  ): StreamState | null {
    const journal = this.readTrackJournal({ adminStreamId, runNumber, streamId, rendition });
    return journal?.state ?? null;
  }

  public saveTrackState(
    adminStreamId: string,
    runNumber: number,
    streamId: string,
    rendition: string | null,
    state: StreamState,
  ): void {
    const identity = { adminStreamId, runNumber, streamId, rendition };
    const journal = this.readTrackJournal(identity);
    if (
      !journal ||
      !isStreamState(state) ||
      state.streamId !== streamId ||
      !isPrefix(journal.state.segments, state.segments)
    ) {
      throw new Error(`Refused invalid managed track state update for ${streamId}`);
    }
    this.replaceDurably(this.trackPath(identity), JSON.stringify({ ...journal, state }));
  }

  private requireRecord(token: string): ManagedMediaRecord {
    const record = this.readRecord(token);
    if (!record) {
      throw new Error(`Managed media record ${token} is missing or unreadable`);
    }
    return record;
  }

  private readRecord(token: string): ManagedMediaRecord | null {
    const filePath = this.metadataPath(token);
    if (!this.fileOps.existsSync(filePath)) {
      return null;
    }
    try {
      const value: unknown = JSON.parse(this.fileOps.readFileSync(filePath).toString('utf8'));
      if (!isRecord(value) || value.token !== token) {
        return null;
      }
      return this.reconcileCommitted(value);
    } catch {
      return null;
    }
  }

  private reconcileCommitted(record: ManagedMediaRecord): ManagedMediaRecord {
    if (record.status === 'committed') {
      return record;
    }
    const journal = this.readTrackJournal(record);
    if (journal?.lastToken !== record.token) {
      return record;
    }
    const placed = journal.state.segments.some(
      (segment) => segment.index === record.sequence && segment.ref === journal.lastReference,
    );
    if (!placed) {
      return record;
    }
    const committed: ManagedMediaRecord = {
      ...record,
      status: 'committed',
      reference: journal.lastReference,
    };
    this.replaceDurably(this.metadataPath(record.token), JSON.stringify(committed));
    this.removeRaw(committed.token);
    return committed;
  }

  private loadOrdinals(): void {
    this.nextOrdinals.clear();
    for (const name of this.fileOps.readdirSync(this.stateDir)) {
      if (!/^[0-9a-f]{64}\.json$/i.test(name)) {
        continue;
      }
      const token = name.slice(0, -'.json'.length);
      const record = this.readRecord(token);
      if (!record) {
        throw new Error(`Managed media record ${token} is missing or unreadable`);
      }
      this.observeOrdinal(record);
    }
  }

  private observeOrdinal(record: ManagedMediaRecord): void {
    const key = this.runKey(record.adminStreamId, record.runNumber);
    this.nextOrdinals.set(key, Math.max(this.nextOrdinals.get(key) ?? 0, record.ordinal + 1));
  }

  private readTrackJournal(identity: {
    adminStreamId: string;
    runNumber: number;
    streamId: string;
    rendition: string | null;
  }): ManagedTrackJournal | null {
    const filePath = this.trackPath(identity);
    if (!this.fileOps.existsSync(filePath)) {
      return null;
    }
    try {
      const value: unknown = JSON.parse(this.fileOps.readFileSync(filePath).toString('utf8'));
      return isTrackJournal(value) &&
        value.adminStreamId === identity.adminStreamId &&
        value.runNumber === identity.runNumber &&
        value.streamId === identity.streamId &&
        value.rendition === identity.rendition
        ? value
        : null;
    } catch {
      return null;
    }
  }

  private removeRaw(token: string): void {
    try {
      this.fileOps.rmSync(this.bytesPath(token));
      this.flushDirectory(this.stateDir);
    } catch {
      // A committed record and track journal suppress a second upload. Raw cleanup is repeatable.
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

  private trackPath(identity: {
    adminStreamId: string;
    runNumber: number;
    streamId: string;
    rendition: string | null;
  }): string {
    const key = digest(
      Buffer.from(
        JSON.stringify({
          adminStreamId: identity.adminStreamId,
          runNumber: identity.runNumber,
          streamId: identity.streamId,
          rendition: identity.rendition,
        }),
        'utf8',
      ),
    );
    return path.join(this.stateDir, `track-${key}.json`);
  }

  private runKey(adminStreamId: string, runNumber: number): string {
    return `${adminStreamId}\u0000${runNumber}`;
  }
}

function isPrefix(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return (
    previous.length <= next.length &&
    previous.every((value, index) => JSON.stringify(value) === JSON.stringify(next[index]))
  );
}
