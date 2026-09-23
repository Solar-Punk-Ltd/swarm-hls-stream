import fs from 'fs';
import path from 'path';

import { BroadcastEpoch } from '../types.js';

import { Logger } from './Logger.js';

/** What every rung of one source's ladder has to agree on, and which outlives any one of them. */
export interface RememberedLadder {
  /**
   * The ladder's group id, which is the catalog entry's identity, the master feed's topic, and what
   * every rung's own feed topic is derived from.
   *
   * ⛔ Losing it costs more than a duplicate catalog entry now. `rungTopicFor` hashes this together
   * with the rung name, so a ladder handed a second group publishes its rungs onto a second set of
   * feeds as well: the master the surviving rungs are still writing names feeds nobody is filling,
   * and the recordings on the first set stay reachable only through what already names them.
   */
  group: string;
  /** Epoch milliseconds this broadcast was admitted. See `BroadcastAnchor`. */
  startedAtMs: number;
  /**
   * Where an engine restart inside this broadcast moved the dating on to the wall clock again.
   * Absent on a record written before anything restarted, and on one written before this file kept
   * them. See `BroadcastEpoch`.
   */
  epochs?: BroadcastEpoch[];
  /**
   * The return this ladder's rungs are coming back from, and which of them have said so. Absent until
   * the encoder first comes back.
   *
   * ⛔⛔ **Persisted because the rungs of one return can straddle a restart of this process.** Each rung
   * announces its return separately, seconds apart, and the name of the return is the only thing that
   * lets them join one dating line. Held in memory alone, an uploader restarted between two rungs'
   * webhooks minted a second name for the rungs still to come: they dated the rest of the broadcast
   * on a line of their own, and at the next outage the rung that had already come back joined THAT
   * line, a whole outage behind. See `StreamOrchestrator.tokenForThisReturn`.
   *
   * The rungs are kept with the token rather than the token alone, because they are what says the
   * return is still in progress: the newest name on its own cannot tell a finished return from one a
   * sibling has yet to join.
   */
  returnInProgress?: ReturnInProgress;
}

/** A return of a ladder's encoder, named, with the rungs that have announced they are back from it. */
export interface ReturnInProgress {
  token: string;
  resumedRungs: string[];
}

/**
 * Base stream id to its ladder's identity.
 *
 * A bare string is what a file written before the broadcast start was kept here holds, and it is
 * read back as a group with no start rather than discarded, so an upgrade mid-broadcast costs that
 * ladder a fresh start instant rather than a duplicate catalog entry.
 */
type PersistedLadderGroups = Record<string, RememberedLadder | string>;

/**
 * The re-anchorings on a persisted record, ignoring anything that is not one.
 *
 * Read one field at a time rather than trusted wholesale, for the reason `read` treats damage as
 * absence: this file is an optimisation for the crash case, and a malformed entry must cost a
 * broadcast its dating rather than take a broadcaster off the air. A dropped epoch dates the media
 * after a restart from the broadcast's start, which is where it was dated before any of this
 * existed.
 */
function readEpochs(epochs: unknown): BroadcastEpoch[] {
  if (!Array.isArray(epochs)) {
    return [];
  }
  return epochs.filter(
    (epoch): epoch is BroadcastEpoch =>
      epoch !== null &&
      typeof epoch === 'object' &&
      typeof (epoch as BroadcastEpoch).fromSequence === 'number' &&
      typeof (epoch as BroadcastEpoch).atMs === 'number',
  );
}

/**
 * The return a persisted record names, or undefined for one that names none or names it damaged.
 *
 * Dropped rather than repaired, for `readEpochs`'s reason: a rung that cannot find the return costs
 * the ladder one dating line, which is exactly what a restart cost it before this was kept.
 */
function readReturnInProgress(value: unknown): ReturnInProgress | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const { token, resumedRungs } = value as Partial<ReturnInProgress>;
  if (
    typeof token !== 'string' ||
    !Array.isArray(resumedRungs) ||
    !resumedRungs.every((rung) => typeof rung === 'string')
  ) {
    return undefined;
  }
  return { token, resumedRungs };
}

/**
 * Which ladder each source's rungs belong to and when its broadcast started, kept where a restart of
 * this process can find them.
 *
 * The group is the identity a broadcast's single catalog entry is written under. Four rungs merge
 * into one entry keyed by `(owner, group)`, and `StreamCatalog` replaces an entry only when the
 * group matches, so a source handed a second group is not a cosmetic slip: it is the same broadcast
 * listed twice for viewers, each copy paid for in its own postage and neither reachable from the
 * other. Nothing merges them afterwards, which is why this exists to stop the second one being
 * written rather than to clean it up.
 *
 * Held in memory alone, the mapping died with the process, and the only route back was a surviving
 * per-stream recovery entry. A crash *around finalize* is exactly the case with none, because
 * `StreamUploader.finalize` deletes each rung's entry as that rung completes. This file is what
 * carries the identity across that gap.
 *
 * A record is retired the moment the ladder's last rung stops, which is when its recording is
 * complete. Keeping it any longer would merge the next broadcast on that source into a finished
 * recording, which is the same defect pointing the other way.
 */
export class LadderGroupStore {
  private logger = Logger.getInstance();
  private saveFailedAt: number | null = null;

  constructor(private filePath: string) {}

  /**
   * How long this file has been failing to update, or null when the last write landed.
   *
   * The third of the three stores that write into `STATE_DIR`, and it was the only one with no
   * alarm. Swallowing it is the quietest failure of the three, because nothing is wrong while the
   * process runs: the mapping is in memory and every rung finds its ladder. The damage arrives at
   * the next crash near finalize, which is the one case this file exists for, and it arrives as a
   * second catalog entry for one broadcast, each paid for in its own postage and neither reachable
   * from the other.
   *
   * See `StreamOrchestrator.getMsSinceStatePersistFailed`, which folds this in with the other two.
   */
  public getMsSinceSaveFailed(): number | null {
    return this.saveFailedAt === null ? null : Date.now() - this.saveFailedAt;
  }

  /**
   * The ladder this source's rungs were last publishing under, or null for one nothing remembers.
   *
   * `startedAtMs` is null where the record predates this file keeping one. The caller mints a fresh
   * instant there rather than being handed a fabricated one, because a wrong wall clock on a
   * recording is worse than a late one on a broadcast that was already in progress.
   */
  public load(base: string): {
    group: string;
    startedAtMs: number | null;
    epochs?: BroadcastEpoch[];
    returnInProgress?: ReturnInProgress;
  } | null {
    const identity = this.read()[base];
    if (typeof identity === 'string') {
      return { group: identity, startedAtMs: null };
    }
    if (identity === null || typeof identity !== 'object' || typeof identity.group !== 'string') {
      return null;
    }
    const epochs = readEpochs(identity.epochs);
    const returnInProgress = readReturnInProgress(identity.returnInProgress);
    return {
      group: identity.group,
      startedAtMs: typeof identity.startedAtMs === 'number' ? identity.startedAtMs : null,
      // Absent rather than empty for a broadcast nothing has restarted, so a record that predates
      // the epochs reads back the way it was written.
      ...(epochs.length === 0 ? {} : { epochs }),
      ...(returnInProgress === undefined ? {} : { returnInProgress }),
    };
  }

  public remember(base: string, ladder: RememberedLadder): void {
    this.write({ ...this.read(), [base]: ladder });
  }

  public forget(base: string): void {
    const groups = this.read();
    if (!(base in groups)) {
      return;
    }

    const { [base]: _retired, ...rest } = groups;
    this.write(rest);
  }

  /**
   * What is on disk, or an empty mapping for a file that is absent or damaged.
   *
   * Damage is reported and then treated as absence, deliberately. Losing the identity costs one
   * broadcast a duplicate entry; throwing from here would reach the announce path and take a
   * broadcaster off the air over a file that is only an optimisation for the crash case.
   */
  private read(): PersistedLadderGroups {
    try {
      if (!fs.existsSync(this.filePath)) {
        return {};
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.logger.error(`[LadderGroupStore] ${this.filePath} does not hold a group mapping; ignoring it`);
        return {};
      }
      return parsed as PersistedLadderGroups;
    } catch (error) {
      this.logger.error(`[LadderGroupStore] Failed to load ${this.filePath}:`, error);
      return {};
    }
  }

  private write(groups: PersistedLadderGroups): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(groups));
      fs.renameSync(tmpPath, this.filePath);
      this.saveFailedAt = null;
    } catch (error) {
      this.saveFailedAt ??= Date.now();
      this.logger.error(`[LadderGroupStore] Failed to save ${this.filePath}:`, error);
    }
  }
}
