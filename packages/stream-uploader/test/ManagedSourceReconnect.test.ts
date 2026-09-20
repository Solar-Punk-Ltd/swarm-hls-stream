import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { StreamUploader } from '../src/libs/StreamUploader.js';
import {
  MEDIA_TYPE_VIDEO,
  SourceConnectionIdentity,
  STREAM_STATUS_VOD,
  StreamState,
} from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import { makeFakeRecoveryStore, makeRecordingCatalog, makeTestOrchestrator } from './helpers/fakes.js';
import { waitFor } from './helpers/waiting.js';

const STREAM_ID = 'video/managed-stream';
const RECONNECT_MS = 60_000;
const SETTLE_CEILING_MS = 4_000;
const ADMIN_SESSION = { id: 'admin-stream', topic: 'managed-topic' };
const CLAIMANT = { address: '198.51.100.7', isAuthenticated: true };
const SOURCE_A: SourceConnectionIdentity = {
  serverId: 'srs-1',
  serviceId: 'service-1',
  clientId: 'client-a',
  generation: 1,
};
const SOURCE_B: SourceConnectionIdentity = {
  serverId: 'srs-1',
  serviceId: 'service-1',
  clientId: 'client-b',
  generation: 2,
};

interface OrchestratorInternals {
  activeStreams: Map<string, StreamUploader>;
}

function activeUploader(orchestrator: StreamOrchestrator): StreamUploader | undefined {
  return (orchestrator as unknown as OrchestratorInternals).activeStreams.get(STREAM_ID);
}

function makeManagedOrchestrator(
  clock: FakeClock,
  published: unknown[] = [],
  saved: StreamState[] = [],
): StreamOrchestrator {
  return makeTestOrchestrator(
    { clock, managedSourceReconnectMs: RECONNECT_MS },
    {},
    makeFakeRecoveryStore({
      save: (_streamId: string, state: StreamState) => saved.push(state),
    }),
    makeRecordingCatalog(published),
  );
}

function provision(orchestrator: StreamOrchestrator, source: SourceConnectionIdentity): boolean {
  return orchestrator.provisionManagedSource(STREAM_ID, MEDIA_TYPE_VIDEO, source, CLAIMANT, ADMIN_SESSION);
}

function media(orchestrator: StreamOrchestrator, source: SourceConnectionIdentity, index: number, value: string) {
  return orchestrator.handleManagedSegment(STREAM_ID, source, index, 2, Buffer.from(value));
}

describe('managed SRS source reconnect foundation', () => {
  it('does not create or replace an uploader from a provisional publish callback alone', async () => {
    const clock = new FakeClock();
    const orchestrator = makeManagedOrchestrator(clock);

    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.equal(orchestrator.getActiveStreamCount(), 0, 'on_publish alone was treated as source acquisition');

    await clock.advance(RECONNECT_MS);

    assert.equal(orchestrator.getActiveStreamCount(), 0);
    assert.deepEqual(
      media(orchestrator, SOURCE_A, 0, 'late media'),
      { accepted: false, reason: 'stale_source' },
      'media from a provisional source was accepted after its bounded acquisition window',
    );
    await orchestrator.cleanup();
  });

  it('keeps one uploader and its history when B returns with media inside A\'s grace window', async () => {
    const clock = new FakeClock();
    const published: { state?: string }[] = [];
    const saved: StreamState[] = [];
    const orchestrator = makeManagedOrchestrator(clock, published, saved);

    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.deepEqual(media(orchestrator, SOURCE_A, 0, 'A'), { accepted: true });
    const uploaderA = activeUploader(orchestrator);
    assert.ok(uploaderA, 'verified media must create the first uploader');
    const notifyStop = mock.method(uploaderA, 'notifyStop');

    assert.equal(orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    await clock.advance(RECONNECT_MS - 1);

    assert.equal(provision(orchestrator, SOURCE_B), true);
    assert.equal(activeUploader(orchestrator), uploaderA, 'a provisional reconnect replaced the incumbent uploader');
    assert.deepEqual(media(orchestrator, SOURCE_B, 0, 'B'), { accepted: true });

    assert.equal(activeUploader(orchestrator), uploaderA, 'verified reconnect media did not reuse the uploader');
    assert.equal(notifyStop.mock.callCount(), 0, 'the in-grace interruption called notifyStop early');
    assert.equal(
      published.filter((entry) => entry.state === STREAM_STATUS_VOD).length,
      0,
      'the in-grace interruption finalized an early VOD',
    );
    assert.ok(saved.length >= 2, 'both sides of the interruption must persist through the same uploader history');
    assert.equal(new Set(saved.map((state) => state.streamRawTopic)).size, 1, 'the reconnect changed feed history');
    await orchestrator.cleanup();
  });

  it('ignores a busy-refused B and its provisional unpublish, then lets A enter waiting', async () => {
    const clock = new FakeClock();
    const orchestrator = makeManagedOrchestrator(clock);

    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.deepEqual(media(orchestrator, SOURCE_A, 0, 'A'), { accepted: true });
    const uploaderA = activeUploader(orchestrator);
    assert.ok(uploaderA);
    const notifyStop = mock.method(uploaderA, 'notifyStop');

    assert.equal(provision(orchestrator, SOURCE_B), false, 'an overlap was admitted while A was still attached');
    assert.equal(activeUploader(orchestrator), uploaderA, 'the refused B retired or replaced A');
    assert.equal(notifyStop.mock.callCount(), 0, 'the refused B finalized A');
    assert.equal(
      orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_B),
      false,
      'a provisional SRT unpublish was mistaken for the incumbent source leaving',
    );
    assert.equal(activeUploader(orchestrator), uploaderA, 'the provisional B unpublish retired A');

    assert.equal(orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    await clock.advance(RECONNECT_MS - 1);

    assert.equal(activeUploader(orchestrator), uploaderA, 'A was retired before its reconnect deadline');
    assert.equal(notifyStop.mock.callCount(), 0, 'A was finalized before its reconnect deadline');
    await orchestrator.cleanup();
  });

  it('finalizes once when the confirmed source reaches its reconnect deadline', async () => {
    const clock = new FakeClock();
    const published: { state?: string }[] = [];
    const orchestrator = makeManagedOrchestrator(clock, published);

    assert.equal(provision(orchestrator, SOURCE_A), true);
    assert.deepEqual(media(orchestrator, SOURCE_A, 0, 'A'), { accepted: true });
    const uploaderA = activeUploader(orchestrator);
    assert.ok(uploaderA);
    const notifyStop = mock.method(uploaderA, 'notifyStop');

    assert.equal(orchestrator.markManagedSourceUnpublished(STREAM_ID, SOURCE_A), true);
    await clock.advance(RECONNECT_MS - 1);
    assert.equal(notifyStop.mock.callCount(), 0);

    await clock.advance(1);
    await waitFor(() => orchestrator.getActiveStreamCount() === 0, SETTLE_CEILING_MS);

    assert.equal(notifyStop.mock.callCount(), 1, 'the deadline finalized the source more than once');
    assert.equal(published.filter((entry) => entry.state === STREAM_STATUS_VOD).length, 1);
    await orchestrator.cleanup();
  });
});
