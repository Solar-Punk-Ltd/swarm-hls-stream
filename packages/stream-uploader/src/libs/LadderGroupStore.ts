import fs from 'fs';
import path from 'path';

import { Logger } from './Logger.js';

/** What every rung of one source's ladder has to agree on, and which outlives any one of them. */
export interface RememberedLadder {
  /** The ladder's group id, which is the catalog entry's identity and the master feed's topic. */
  group: string;
  /** Epoch milliseconds this broadcast was admitted. See `BroadcastAnchor`. */
  startedAtMs: number;
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
 * Which ladder each source's rungs belong to and when its broadcast started, kept where a restart of
 * this process can find them.
 *
 * The group is the identity a broadcast's single catalog entry is written under. Four rungs fold
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
 * complete. Keeping it any longer would fold the next broadcast on that source into a finished
 * recording, which is the same defect pointing the other way.
 */
export class LadderGroupStore {
  private logger = Logger.getInstance();

  constructor(private filePath: string) {}

  /**
   * The ladder this source's rungs were last publishing under, or null for one nothing remembers.
   *
   * `startedAtMs` is null where the record predates this file keeping one. The caller mints a fresh
   * instant there rather than being handed a fabricated one, because a wrong wall clock on a
   * recording is worse than a late one on a broadcast that was already in progress.
   */
  public load(base: string): { group: string; startedAtMs: number | null } | null {
    const identity = this.read()[base];
    if (typeof identity === 'string') {
      return { group: identity, startedAtMs: null };
    }
    if (identity === null || typeof identity !== 'object' || typeof identity.group !== 'string') {
      return null;
    }
    return {
      group: identity.group,
      startedAtMs: typeof identity.startedAtMs === 'number' ? identity.startedAtMs : null,
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
    } catch (error) {
      this.logger.error(`[LadderGroupStore] Failed to save ${this.filePath}:`, error);
    }
  }
}
