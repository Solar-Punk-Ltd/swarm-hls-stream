import fs from 'node:fs';
import path from 'node:path';

import { Rendition } from '../types.js';

import {
  ManagedRenditionReport,
  managedRenditionReportDigest,
} from './AdminApiClient.js';
import { DurableFileOps } from './ManagedRunStore.js';

export interface ManagedRenditionBinding {
  readonly streamId: string;
  readonly runNumber: number;
  readonly uploaderId: string;
  readonly claimId: string;
}

export interface PreparedManagedRendition {
  readonly report: ManagedRenditionReport;
  /** False when an earlier distinct event must be delivered first. */
  readonly target: boolean;
}

interface ManagedRenditionRecord extends ManagedRenditionBinding {
  readonly lifecycleVersion: 1;
  readonly report: ManagedRenditionReport;
  readonly digest: string;
  readonly accepted: boolean;
  readonly renditionRevision: number | null;
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

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRendition(value: unknown): value is Rendition {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const rendition = value as Partial<Rendition>;
  const final = rendition.index !== undefined || rendition.duration !== undefined;
  return (
    typeof rendition.name === 'string' &&
    rendition.name.length > 0 &&
    typeof rendition.topic === 'string' &&
    rendition.topic.length > 0 &&
    positiveInteger(rendition.width) &&
    positiveInteger(rendition.height) &&
    positiveInteger(rendition.bandwidth) &&
    positiveInteger(rendition.avgBandwidth) &&
    (!final || (nonNegativeInteger(rendition.index) && typeof rendition.duration === 'number' && rendition.duration >= 0))
  );
}

function sameRendition(left: Rendition, right: Rendition): boolean {
  return (
    left.name === right.name &&
    left.topic === right.topic &&
    left.width === right.width &&
    left.height === right.height &&
    left.bandwidth === right.bandwidth &&
    left.avgBandwidth === right.avgBandwidth &&
    left.index === right.index &&
    left.duration === right.duration
  );
}

function isRecord(value: unknown): value is ManagedRenditionRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<ManagedRenditionRecord>;
  const report = record.report as Partial<ManagedRenditionReport> | undefined;
  return (
    record.lifecycleVersion === 1 &&
    typeof record.streamId === 'string' &&
    record.streamId.length > 0 &&
    positiveInteger(record.runNumber) &&
    typeof record.uploaderId === 'string' &&
    record.uploaderId.length > 0 &&
    typeof record.claimId === 'string' &&
    record.claimId.length > 0 &&
    report?.lifecycleVersion === 1 &&
    report.uploaderId === record.uploaderId &&
    report.claimId === record.claimId &&
    positiveInteger(report.renditionSequence) &&
    typeof report.observedAt === 'string' &&
    Number.isFinite(Date.parse(report.observedAt)) &&
    isRendition(report.rendition) &&
    typeof record.digest === 'string' &&
    record.digest === managedRenditionReportDigest(report as ManagedRenditionReport) &&
    typeof record.accepted === 'boolean' &&
    (record.renditionRevision === null || nonNegativeInteger(record.renditionRevision))
  );
}

function entryName(binding: ManagedRenditionBinding, rung: string): string {
  return `${encodeURIComponent(binding.streamId)}--${binding.runNumber}--${encodeURIComponent(rung)}.json`;
}

/** Durable exact-body outbox for lifecycle-v1 run-scoped rendition reports. */
export class ManagedRenditionStore {
  constructor(
    private readonly stateDir: string,
    private readonly fileOps: DurableFileOps = nodeFileOps,
  ) {
    if (!this.fileOps.existsSync(stateDir)) {
      this.fileOps.mkdirSync(stateDir, { recursive: true });
      this.flushDirectory(path.dirname(stateDir));
    }
  }

  public prepare(
    binding: ManagedRenditionBinding,
    rendition: Rendition,
    observedAt: string,
  ): PreparedManagedRendition {
    const existing = this.read(binding, rendition.name);
    if (existing) {
      if (sameRendition(existing.report.rendition, rendition)) {
        return { report: existing.report, target: true };
      }
      if (!existing.accepted) {
        return { report: existing.report, target: false };
      }
    }
    const report: ManagedRenditionReport = {
      lifecycleVersion: 1,
      uploaderId: binding.uploaderId,
      claimId: binding.claimId,
      renditionSequence: (existing?.report.renditionSequence ?? 0) + 1,
      observedAt,
      rendition,
    };
    this.save({
      lifecycleVersion: 1,
      ...binding,
      report,
      digest: managedRenditionReportDigest(report),
      accepted: false,
      renditionRevision: null,
    });
    return { report, target: true };
  }

  public accept(binding: ManagedRenditionBinding, report: ManagedRenditionReport, renditionRevision: number): void {
    const existing = this.read(binding, report.rendition.name);
    if (!existing || existing.digest !== managedRenditionReportDigest(report)) {
      throw new Error(`Managed rendition ${report.rendition.name} acceptance does not match its durable event`);
    }
    this.save({ ...existing, accepted: true, renditionRevision });
  }

  public latestRevision(streamId: string, runNumber: number): number | null {
    const prefix = `${encodeURIComponent(streamId)}--${runNumber}--`;
    let latest: number | null = null;
    for (const name of this.fileOps.readdirSync(this.stateDir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) {
        continue;
      }
      const record = this.readFile(path.join(this.stateDir, name));
      if (record.renditionRevision !== null) {
        latest = Math.max(latest ?? 0, record.renditionRevision);
      }
    }
    return latest;
  }

  private read(binding: ManagedRenditionBinding, rung: string): ManagedRenditionRecord | null {
    const filePath = path.join(this.stateDir, entryName(binding, rung));
    if (!this.fileOps.existsSync(filePath)) {
      return null;
    }
    const record = this.readFile(filePath);
    if (
      record.streamId !== binding.streamId ||
      record.runNumber !== binding.runNumber ||
      record.uploaderId !== binding.uploaderId ||
      record.claimId !== binding.claimId ||
      record.report.rendition.name !== rung
    ) {
      throw new Error(`Managed rendition ${rung} retained state has another run binding`);
    }
    return record;
  }

  private readFile(filePath: string): ManagedRenditionRecord {
    try {
      const parsed: unknown = JSON.parse(this.fileOps.readFileSync(filePath, 'utf8'));
      if (!isRecord(parsed)) {
        throw new Error('invalid record');
      }
      return parsed;
    } catch {
      throw new Error(`Managed rendition retained state ${filePath} is unreadable`);
    }
  }

  private save(record: ManagedRenditionRecord): void {
    if (!isRecord(record)) {
      throw new Error('Refused to persist an invalid managed rendition record');
    }
    const filePath = path.join(this.stateDir, entryName(record, record.report.rendition.name));
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
}
