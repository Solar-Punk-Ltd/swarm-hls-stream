import { FeedIndex } from '@ethersphere/bee-js';
import fs from 'fs';
import path from 'path';

import { Logger } from './Logger.js';

interface PersistedCatalogIndex {
  owner: string;
  topicHex: string;
  index: string;
}

/**
 * Persists the last successfully written catalog feed index. The boot-time feed
 * lookup runs against the local bee node, and a freshly restarted node without
 * warmed peers can answer with a stale head — resuming behind the real head
 * forks the feed into already-occupied indices, invisibly to readers who keep
 * following the original chain. The persisted index is the floor a reboot may
 * never resume below.
 */
export class CatalogIndexStore {
  private logger = Logger.getInstance();
  private saveFailedAt: number | null = null;

  constructor(private filePath: string) {}

  /**
   * How long the persisted index has been failing to update, or null when the last save landed.
   *
   * Swallowing this was the quietest possible failure: the running process keeps the right index in
   * memory, so nothing is wrong until a restart, and then the boot lookup resumes from whatever the
   * file last held. That is the fork this class exists to prevent, written back into the feed at
   * indices readers have already passed.
   */
  public getMsSinceSaveFailed(): number | null {
    return this.saveFailedAt === null ? null : Date.now() - this.saveFailedAt;
  }

  public load(owner: string, topicHex: string): FeedIndex | null {
    try {
      if (!fs.existsSync(this.filePath)) {
        return null;
      }
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as PersistedCatalogIndex;
      if (data.owner !== owner || data.topicHex !== topicHex) {
        return null;
      }
      return new FeedIndex(data.index);
    } catch (error) {
      this.logger.error(`[CatalogIndexStore] Failed to load ${this.filePath}:`, error);
      return null;
    }
  }

  public save(owner: string, topicHex: string, index: FeedIndex): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      const data: PersistedCatalogIndex = { owner, topicHex, index: index.toString() };
      fs.writeFileSync(tmpPath, JSON.stringify(data));
      fs.renameSync(tmpPath, this.filePath);
      this.saveFailedAt = null;
    } catch (error) {
      this.saveFailedAt ??= Date.now();
      this.logger.error(`[CatalogIndexStore] Failed to save ${this.filePath}:`, error);
    }
  }
}
