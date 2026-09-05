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

/**
 * The name a stream id is filed under.
 *
 * ⛔ Escaped rather than flattened, because flattening is not reversible and two legitimate ids
 * collided on it. A stream id is `app/stream` with `[A-Za-z0-9][A-Za-z0-9._-]*` per segment (see
 * `STREAM_ID_SEGMENT`), so `_` is an ordinary character inside a name: mapping the separator onto it
 * gave `video/a_b` and `video_a/b` the same file. Saving one destroyed the other's state, and
 * removing either on finalize deleted the entry the other was relying on to survive a crash.
 *
 * Inside that charset only `/` moves, to `%2F`, and `%` is outside it, so no id can spell an escape
 * belonging to another. It is the stronger path guard too: a separator of either kind is escaped
 * rather than substituted, so nothing can resolve outside the state directory.
 */
function entryName(streamId: string): string {
  return encodeURIComponent(streamId);
}

/**
 * The id a file name belongs to.
 *
 * A name holding no escape decodes to itself, which is what keeps every entry written under the old
 * flattening readable: those hold no `%`, so the two namings agree on them.
 *
 * A name that is not an escape sequence at all is its own answer rather than an error. The state
 * directory holds files this store did not write, the catalog feed index among them, and an operator
 * may leave anything there. `decodeURIComponent` throws on a stray `%`, and the listing that calls
 * this runs on the boot path, so one such file would otherwise stop the service recovering anything.
 */
function idOfEntryName(fileName: string): string {
  try {
    return decodeURIComponent(fileName);
  } catch {
    return fileName;
  }
}

/**
 * The name `save` wrote before ids were escaped, which is what an upgrade meets on disk.
 *
 * A deployment upgraded mid-broadcast boots holding entries under this name, and each one is the
 * only record that its broadcast was live. Everything that reads or moves an entry looks here when
 * the escaped name is absent, so none of those recordings is stranded by the change.
 */
function legacyEntryName(streamId: string): string {
  return streamId.replace(/[/\\]/g, '_');
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

    // ⛔ Only after the escaped name holds the whole state, so an interrupted save cannot end with
    // neither name holding one. A recovered stream persists every segment, so it writes here within
    // seconds of the boot that found it under the old name, and leaving that name behind would make
    // one broadcast two entries: the next crash lists both and recovers the same stream twice, the
    // second registration orphaning the first uploader under the id they share.
    const legacyPath = this.getLegacyFilePath(streamId);
    if (legacyPath !== filePath && fs.existsSync(legacyPath)) {
      fs.rmSync(legacyPath, { force: true });
      this.logger.info(`[RecoveryStore] Retired the pre-escaping state file for ${streamId} at ${legacyPath}`);
    }
  }

  /** What is on disk for this stream, keeping "never saved" and "will not parse" apart. */
  public read(streamId: string): RecoveryEntry {
    const filePath = this.findFilePath(streamId);

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
    const filePath = this.findFilePath(streamId);
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

  /**
   * Forget this stream, under both namings.
   *
   * Both, because either may be the one on disk: a broadcast recovered from a pre-escaping entry and
   * finalized before it ever persisted again is still filed under the old name, and one that has
   * saved since is filed under the new one. A remove that took only the escaped name would leave the
   * old entry to be recovered on the next boot and finalized a second time.
   */
  public remove(streamId: string): void {
    const paths = [this.getFilePath(streamId), this.getLegacyFilePath(streamId)].filter(
      (filePath, index, all) => all.indexOf(filePath) === index && fs.existsSync(filePath),
    );

    for (const filePath of paths) {
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

  /**
   * The stream id of every entry there is to recover.
   *
   * Ids rather than file names, because recovery hands each one straight back to {@link read} and
   * then registers the stream under it. While the name was a one-way flattening those two were not
   * the same string, so a stream saved as `live/stream` came back as `live_stream`.
   */
  public listActive(): string[] {
    if (!fs.existsSync(this.stateDir)) {
      return [];
    }

    // `save` writes `<id>.json.tmp`, so the suffix check excludes a write caught in flight on its own.
    return fs
      .readdirSync(this.stateDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => idOfEntryName(f.replace(/\.json$/, '')));
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

  /** Where a save goes, and where everything but an upgrade's first read looks. */
  private getFilePath(streamId: string): string {
    return path.join(this.stateDir, `${entryName(streamId)}.json`);
  }

  private getLegacyFilePath(streamId: string): string {
    return path.join(this.stateDir, `${legacyEntryName(streamId)}.json`);
  }

  /**
   * Where this stream's entry actually is, which is the pre-escaping name only when nothing holds the
   * escaped one. With neither on disk it answers the escaped path, so a caller asking about a stream
   * that was never saved is told about the name a save would use.
   */
  private findFilePath(streamId: string): string {
    const filePath = this.getFilePath(streamId);
    if (fs.existsSync(filePath)) {
      return filePath;
    }

    const legacyPath = this.getLegacyFilePath(streamId);
    return fs.existsSync(legacyPath) ? legacyPath : filePath;
  }
}
