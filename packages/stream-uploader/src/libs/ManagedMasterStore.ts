import fs from 'node:fs';
import path from 'node:path';

import { DurableFileOps } from './ManagedRunStore.js';

export interface ManagedMasterBinding {
  readonly streamId: string;
  readonly runNumber: number;
  readonly uploaderId: string;
  readonly claimId: string;
  readonly group: string;
}

export interface ManagedMasterIntent extends ManagedMasterBinding {
  readonly lifecycleVersion: 1;
  readonly eventId: string;
  readonly index: number;
  readonly playlist: string;
  readonly status: 'pending' | 'committed';
  readonly reference?: string;
}

export interface ManagedMasterPersistence {
  read(binding: ManagedMasterBinding): ManagedMasterIntent | null;
  prepare(intent: Omit<ManagedMasterIntent, 'lifecycleVersion' | 'status' | 'reference'>): ManagedMasterIntent;
  commit(intent: ManagedMasterIntent, reference: string): ManagedMasterIntent;
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

function isIntent(value: unknown): value is ManagedMasterIntent {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const intent = value as Partial<ManagedMasterIntent>;
  return (
    intent.lifecycleVersion === 1 &&
    typeof intent.streamId === 'string' &&
    intent.streamId.length > 0 &&
    Number.isSafeInteger(intent.runNumber) &&
    Number(intent.runNumber) > 0 &&
    typeof intent.uploaderId === 'string' &&
    intent.uploaderId.length > 0 &&
    typeof intent.claimId === 'string' &&
    intent.claimId.length > 0 &&
    typeof intent.group === 'string' &&
    intent.group.length > 0 &&
    typeof intent.eventId === 'string' &&
    intent.eventId.length > 0 &&
    Number.isSafeInteger(intent.index) &&
    Number(intent.index) >= 0 &&
    typeof intent.playlist === 'string' &&
    intent.playlist.length > 0 &&
    (intent.status === 'pending' || intent.status === 'committed') &&
    (intent.status === 'pending' || (typeof intent.reference === 'string' && /^[0-9a-f]{64,128}$/i.test(intent.reference)))
  );
}

function sameBinding(left: ManagedMasterBinding, right: ManagedMasterBinding): boolean {
  return (
    left.streamId === right.streamId &&
    left.runNumber === right.runNumber &&
    left.uploaderId === right.uploaderId &&
    left.claimId === right.claimId &&
    left.group === right.group
  );
}

function entryName(binding: ManagedMasterBinding): string {
  return `${encodeURIComponent(binding.streamId)}--${binding.runNumber}--${encodeURIComponent(binding.group)}.json`;
}

/** Exact master write intent retained across Bee acknowledgement and process restart. */
export class ManagedMasterStore implements ManagedMasterPersistence {
  constructor(
    private readonly stateDir: string,
    private readonly fileOps: DurableFileOps = nodeFileOps,
  ) {
    if (!this.fileOps.existsSync(stateDir)) {
      this.fileOps.mkdirSync(stateDir, { recursive: true });
    }
    this.flushDirectory(path.dirname(stateDir));
  }

  public read(binding: ManagedMasterBinding): ManagedMasterIntent | null {
    const filePath = path.join(this.stateDir, entryName(binding));
    if (!this.fileOps.existsSync(filePath)) {
      return null;
    }
    this.flushDirectory(this.stateDir);
    try {
      const parsed: unknown = JSON.parse(this.fileOps.readFileSync(filePath, 'utf8'));
      if (!isIntent(parsed) || !sameBinding(parsed, binding)) {
        throw new Error('invalid intent');
      }
      return parsed;
    } catch {
      throw new Error(`Managed master intent ${filePath} is unreadable`);
    }
  }

  public prepare(
    intent: Omit<ManagedMasterIntent, 'lifecycleVersion' | 'status' | 'reference'>,
  ): ManagedMasterIntent {
    const existing = this.read(intent);
    if (existing?.eventId === intent.eventId) {
      if (existing.index !== intent.index || existing.playlist !== intent.playlist) {
        throw new Error(`Managed master event ${intent.eventId} conflicts with its durable intent`);
      }
      return existing;
    }
    if (existing?.status === 'pending') {
      throw new Error(`Managed master event ${existing.eventId} must settle before ${intent.eventId}`);
    }
    const prepared: ManagedMasterIntent = { lifecycleVersion: 1, ...intent, status: 'pending' };
    this.save(prepared);
    return prepared;
  }

  public commit(intent: ManagedMasterIntent, reference: string): ManagedMasterIntent {
    const existing = this.read(intent);
    if (!existing || existing.eventId !== intent.eventId || existing.index !== intent.index || existing.playlist !== intent.playlist) {
      throw new Error(`Managed master event ${intent.eventId} does not match its durable intent`);
    }
    if (existing.status === 'committed') {
      if (existing.reference !== reference) {
        throw new Error(`Managed master event ${intent.eventId} already has another reference`);
      }
      return existing;
    }
    const committed: ManagedMasterIntent = { ...existing, status: 'committed', reference };
    this.save(committed);
    return committed;
  }

  private save(intent: ManagedMasterIntent): void {
    if (!isIntent(intent)) {
      throw new Error('Refused to persist an invalid managed master intent');
    }
    const filePath = path.join(this.stateDir, entryName(intent));
    const tmpPath = `${filePath}.tmp`;
    const file = this.fileOps.openSync(tmpPath, 'w', 0o600);
    try {
      this.fileOps.writeFileSync(file, JSON.stringify(intent));
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
}
