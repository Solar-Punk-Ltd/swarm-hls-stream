import fs from 'fs';
import path from 'path';

import { StreamState } from '../types.js';

import { Logger } from './Logger.js';

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

  public load(streamId: string): StreamState | null {
    const filePath = this.getFilePath(streamId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data) as StreamState;
    } catch (error) {
      this.logger.error(`Failed to load state for ${streamId}:`, error);
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

  public listActive(): string[] {
    if (!fs.existsSync(this.stateDir)) {
      return [];
    }

    return fs
      .readdirSync(this.stateDir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => f.replace(/\.json$/, ''));
  }

  private getFilePath(streamId: string): string {
    const safeId = streamId.replace(/[/\\]/g, '_');
    return path.join(this.stateDir, `${safeId}.json`);
  }
}
