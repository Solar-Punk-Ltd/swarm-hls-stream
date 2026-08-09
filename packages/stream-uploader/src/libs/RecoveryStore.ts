import fs from 'fs';
import path from 'path';

import {
  RECOVERY_ENTRY_LOADED,
  RECOVERY_ENTRY_MISSING,
  RECOVERY_ENTRY_UNREADABLE,
  RecoveryEntry,
  StreamState,
} from '../types.js';

import { Logger } from './Logger.js';

/**
 * Suffix a damaged entry is moved under. Deliberately not `.json`, so `listActive` stops offering it
 * and the next boot does not read, fail on and re-quarantine the same file.
 */
const QUARANTINE_SUFFIX = '.corrupt';

/**
 * How many damaged entries one stream id may accumulate before the store stops moving them aside.
 * Past this the original is left exactly where it is: quarantining exists so that nothing is
 * destroyed, and landing a new damaged copy on the previous one would destroy the older evidence.
 */
const MAX_QUARANTINED_COPIES = 10;

/** `<id>.json.corrupt`, plus the `.2` upward a second damaged copy of the same id is given. */
function isQuarantined(fileName: string): boolean {
  const suffixAt = fileName.indexOf(QUARANTINE_SUFFIX);
  return suffixAt > 0 && /^(\.\d+)?$/.test(fileName.slice(suffixAt + QUARANTINE_SUFFIX.length));
}

export class RecoveryStore {
  private logger = Logger.getInstance();

  constructor(private stateDir: string) {
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }
  }

  public save(streamId: string, state: StreamState): void {
    const filePath = this.getFilePath(streamId);
    const tmpPath = `${filePath}.tmp`;

    fs.writeFileSync(tmpPath, JSON.stringify(state));
    fs.renameSync(tmpPath, filePath);
  }

  /** What is on disk for this stream, keeping "never saved" and "will not parse" apart. */
  public read(streamId: string): RecoveryEntry {
    const filePath = this.getFilePath(streamId);

    if (!fs.existsSync(filePath)) {
      return { kind: RECOVERY_ENTRY_MISSING };
    }

    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      return { kind: RECOVERY_ENTRY_LOADED, state: JSON.parse(data) as StreamState };
    } catch (error) {
      this.logger.error(`Failed to load state for ${streamId}:`, error);
      return { kind: RECOVERY_ENTRY_UNREADABLE };
    }
  }

  /**
   * The state for this stream, or `null` for one this store cannot hand back.
   *
   * ⛔ Lossy on purpose and only safe for callers that are reading: absence and damage are the same
   * answer here. Anything deciding what to *do* with an entry calls {@link read} instead.
   */
  public load(streamId: string): StreamState | null {
    const entry = this.read(streamId);
    return entry.kind === RECOVERY_ENTRY_LOADED ? entry.state : null;
  }

  /**
   * Move an entry that cannot be parsed out of the recovery listing without destroying it, and
   * answer where it went, or `null` when it could not be moved.
   *
   * A recovery entry is the only record that a broadcast was live and the only route back to the
   * recording it was building, so it is kept for an operator rather than deleted. Deleting it also
   * deletes the evidence that anything was lost.
   */
  public quarantine(streamId: string): string | null {
    const filePath = this.getFilePath(streamId);
    const destination = this.freeQuarantinePath(filePath);

    if (destination === null) {
      this.logger.error(
        `[RecoveryStore] Left ${streamId} in place: already keeping ${MAX_QUARANTINED_COPIES} damaged copies of it`,
      );
      return null;
    }

    try {
      fs.renameSync(filePath, destination);
      this.logger.error(`[RecoveryStore] Quarantined unreadable state for ${streamId} at ${destination}`);
      return destination;
    } catch (error) {
      this.logger.error(`[RecoveryStore] Failed to quarantine state for ${streamId}:`, error);
      return null;
    }
  }

  public remove(streamId: string): void {
    const filePath = this.getFilePath(streamId);

    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      this.logger.info(`[RecoveryStore] Removed state file for ${streamId}`);
    }
  }

  /**
   * File names of every damaged entry kept aside in this directory, across every process that ever
   * ran here.
   *
   * Read off disk rather than remembered, so a restart cannot clear the alarm they raise: a
   * quarantined entry stands for a broadcast that can no longer be finalized, and only an operator
   * repairing or removing the file makes that untrue.
   */
  public listQuarantined(): string[] {
    if (!fs.existsSync(this.stateDir)) {
      return [];
    }

    return fs.readdirSync(this.stateDir).filter(isQuarantined);
  }

  public listActive(): string[] {
    if (!fs.existsSync(this.stateDir)) {
      return [];
    }

    // `save` writes `<id>.json.tmp`, so the suffix check excludes a write caught in flight on its own.
    return fs
      .readdirSync(this.stateDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  /** The first quarantine name this entry has not already used, or `null` once the ceiling is hit. */
  private freeQuarantinePath(filePath: string): string | null {
    const first = `${filePath}${QUARANTINE_SUFFIX}`;

    if (!fs.existsSync(first)) {
      return first;
    }

    for (let copy = 2; copy <= MAX_QUARANTINED_COPIES; copy++) {
      const candidate = `${first}.${copy}`;
      if (!fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private getFilePath(streamId: string): string {
    const safeId = streamId.replace(/[/\\]/g, '_');
    return path.join(this.stateDir, `${safeId}.json`);
  }
}
