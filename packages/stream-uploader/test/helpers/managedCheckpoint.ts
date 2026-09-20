import {
  CreateManagedRun,
  ManagedCheckpointPersistence,
  ManagedCheckpointRecord,
  ManagedCompletedRecording,
  ManagedContinuationOperation,
  ManagedEmptyOutcome,
  ManagedImmutableMediaReference,
  ManagedTrackFinalization,
} from '../../src/libs/ManagedCheckpointStore.js';

export class MemoryManagedCheckpoints implements ManagedCheckpointPersistence {
  public readonly runs = new Map<string, ManagedCheckpointRecord>();
  public failCreate = false;
  private nextReference = 1;

  public createRun(input: CreateManagedRun): ManagedCheckpointRecord {
    if (this.failCreate) {throw new Error('injected checkpoint create failure');}
    const key = this.key(input.adminStreamId, input.runNumber);
    const existing = this.runs.get(key);
    if (existing) {return structuredClone(existing);}
    const reference = `00000000-0000-4000-8000-${String(this.nextReference++).padStart(12, '0')}`;
    const record: ManagedCheckpointRecord = {
      lifecycleVersion: 1,
      checkpointReference: reference,
      adminStreamId: input.adminStreamId,
      runNumber: input.runNumber,
      topic: input.topic,
      mediaType: input.mediaType,
      expectedRenditions: structuredClone(input.expectedRenditions),
      status: 'prepared',
      tracks: [],
    };
    this.runs.set(key, structuredClone(record));
    return record;
  }

  public prepare(_operation: ManagedContinuationOperation): ManagedCheckpointRecord {
    throw new Error('not implemented in memory checkpoint');
  }

  public saveTrack(_checkpointReference: string, _track: ManagedTrackFinalization): ManagedCheckpointRecord {
    throw new Error('not implemented in memory checkpoint');
  }

  public complete(
    _checkpointReference: string,
    _master: ManagedImmutableMediaReference,
  ): ManagedCompletedRecording {
    throw new Error('not implemented in memory checkpoint');
  }

  public sealEmpty(_checkpointReference: string, _acceptedMediaCount: number): ManagedEmptyOutcome {
    throw new Error('not implemented in memory checkpoint');
  }

  public read(checkpointReference: string): ManagedCheckpointRecord | null {
    const record = [...this.runs.values()].find((candidate) => candidate.checkpointReference === checkpointReference);
    return record ? structuredClone(record) : null;
  }

  public findRun(adminStreamId: string, runNumber: number): ManagedCheckpointRecord | null {
    const record = this.runs.get(this.key(adminStreamId, runNumber));
    return record ? structuredClone(record) : null;
  }

  private key(adminStreamId: string, runNumber: number): string {
    return `${adminStreamId}:${runNumber}`;
  }
}
