import {
  AdoptLegacyRecording,
  CreateManagedRun,
  ManagedCheckpointPersistence,
  ManagedCheckpointRecord,
  ManagedCompletedRecording,
  ManagedContinuationOperation,
  ManagedEmptyOutcome,
  ManagedImmutableMediaReference,
  ManagedImmutableRenditionReference,
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

  public adoptLegacy(_input: AdoptLegacyRecording): ManagedCompletedRecording {
    throw new Error('not implemented in memory checkpoint');
  }

  public prepare(_operation: ManagedContinuationOperation): ManagedCheckpointRecord {
    throw new Error('not implemented in memory checkpoint');
  }

  public saveTrack(checkpointReference: string, track: ManagedTrackFinalization): ManagedCheckpointRecord {
    const [key, existing] = this.entry(checkpointReference);
    if (existing.status !== 'prepared') {throw new Error('memory checkpoint is already sealed');}
    const record: ManagedCheckpointRecord = {
      ...existing,
      tracks: [
        ...existing.tracks.filter((candidate) => candidate.streamId !== track.streamId),
        structuredClone(track),
      ],
    };
    this.runs.set(key, structuredClone(record));
    return record;
  }

  public complete(
    checkpointReference: string,
    master: ManagedImmutableMediaReference,
  ): ManagedCompletedRecording {
    const [key, existing] = this.entry(checkpointReference);
    if (existing.completedRecording) {return structuredClone(existing.completedRecording);}
    if (existing.status !== 'prepared') {throw new Error('memory checkpoint is already sealed');}
    const completedRecording: ManagedCompletedRecording = {
      runNumber: existing.runNumber,
      checkpointReference,
      master: structuredClone(master),
      expectedRenditions: existing.expectedRenditions.map(({ name }) => name),
      renditions: existing.tracks
        .filter((track) => track.rendition !== null && track.manifest !== undefined)
        .map((track) => structuredClone(track.manifest) as ManagedImmutableRenditionReference),
    };
    this.runs.set(key, {
      ...existing,
      status: 'complete',
      completedRecording: structuredClone(completedRecording),
    });
    return completedRecording;
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

  private entry(checkpointReference: string): [string, ManagedCheckpointRecord] {
    const entry = [...this.runs.entries()].find(([, record]) => record.checkpointReference === checkpointReference);
    if (!entry) {throw new Error('memory checkpoint does not exist');}
    return entry;
  }
}
