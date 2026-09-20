import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ContinuationMediaScenarioInput,
  type MediaScenarioFetch,
  type MediaScenarioFetchRequest,
  type MediaScenarioProcess,
  type MediaScenarioProcessInvocation,
  type MediaScenarioProcessResult,
  type MediaScenarioSpawn,
  runReconnectAcceptanceScenario,
} from '../src/continuation/mediaScenario.js';

const STREAM_ID = '11111111-1111-4111-8111-111111111111';
const TOPIC = '22222222-2222-4222-8222-222222222222';
const REPORT_RECEIVED_AT = '2026-09-21T01:00:30.000Z';

function input(): ContinuationMediaScenarioInput {
  return {
    fixtureId: 'srs-continuation-20260920-a1b2c3d4',
    srs: { host: 'srs', rtmpPort: 10012, srtPort: 10011 },
    viewer: {
      controlBaseUrl: 'http://127.0.0.1:18081',
      mediaBaseUrl: 'http://client',
    },
    adminBaseUrl: 'http://127.0.0.1:18080',
    stream: { id: STREAM_ID, topic: TOPIC, mediaType: 'video' },
    uploaderId: 'fixture-srs-uploader',
    authReferences: {
      owner: 'fixture-auth:owner',
      publishKey: 'fixture-auth:publish-key',
      srtPassphrase: 'fixture-auth:srt-passphrase',
    },
  };
}

function stream(
  runNumber: number,
  revision: number,
  state: 'ready' | 'live' | 'waiting' | 'closed' | 'vod',
  extra: Record<string, unknown> = {},
): unknown {
  return {
    id: STREAM_ID,
    topic: TOPIC,
    lifecycle: {
      version: 1,
      revision,
      runNumber,
      state,
      permission: state === 'ready' ? 'open' : state === 'closed' || state === 'vod' ? 'closed' : 'claimed',
      canContinue: state === 'vod',
      ...extra,
    },
  };
}

function continuation(status: 'pending' | 'ready'): unknown {
  return {
    operation: {
      lifecycleVersion: 1,
      operationId: '44444444-4444-4444-8444-444444444444',
      requestId: '55555555-5555-4555-8555-555555555555',
      status,
      streamId: STREAM_ID,
      topic: TOPIC,
      mediaType: 'video',
      previousRunNumber: 1,
      nextRunNumber: 2,
      revision: 20,
      ...(status === 'ready' ? { checkpointReference: '8'.repeat(64) } : {}),
    },
  };
}

class QueuedFetch implements MediaScenarioFetch {
  readonly requests: MediaScenarioFetchRequest[] = [];

  constructor(private readonly responses: Array<{ status: number; body: unknown }>) {}

  async fetch(request: MediaScenarioFetchRequest) {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    assert.ok(response, `unexpected fetch ${request.method} ${request.url}`);
    return response;
  }
}

class ControlledProcess implements MediaScenarioProcess {
  stopCalls = 0;
  waitCalls = 0;

  constructor(private readonly result: MediaScenarioProcessResult) {}

  async wait(): Promise<MediaScenarioProcessResult> {
    this.waitCalls += 1;
    return this.result;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

class QueuedSpawn implements MediaScenarioSpawn {
  readonly invocations: MediaScenarioProcessInvocation[] = [];
  readonly processes: ControlledProcess[] = [];

  constructor(private readonly results: MediaScenarioProcessResult[]) {}

  async spawn(invocation: MediaScenarioProcessInvocation): Promise<MediaScenarioProcess> {
    this.invocations.push(structuredClone(invocation));
    const result = this.results.shift();
    assert.ok(result, 'unexpected media process');
    const process = new ControlledProcess(result);
    this.processes.push(process);
    return process;
  }
}

function processResult(code: number): MediaScenarioProcessResult {
  return { code, stdout: new Uint8Array(), stderr: code === 0 ? '' : 'credential-bearing child refusal' };
}

function successfulFetch(
  afterRefusal: unknown = stream(1, 6, 'vod', { closeReason: 'reconnect_timeout' }),
): QueuedFetch {
  return new QueuedFetch([
    { status: 200, body: stream(1, 1, 'ready') },
    {
      status: 200,
      body: stream(1, 2, 'live', { receivedAt: REPORT_RECEIVED_AT, observationAgeMs: 20 }),
    },
    {
      status: 200,
      body: stream(1, 3, 'waiting', {
        reconnectRemainingMs: 55_000,
        receivedAt: REPORT_RECEIVED_AT,
        observationAgeMs: 25,
      }),
    },
    {
      status: 200,
      body: stream(1, 4, 'live', { receivedAt: REPORT_RECEIVED_AT, observationAgeMs: 30 }),
    },
    {
      status: 200,
      body: stream(1, 5, 'waiting', {
        reconnectRemainingMs: 41_000,
        receivedAt: REPORT_RECEIVED_AT,
        observationAgeMs: 40,
      }),
    },
    {
      status: 200,
      body: stream(1, 6, 'vod', { closeReason: 'reconnect_timeout' }),
    },
    {
      status: 200,
      body: afterRefusal,
    },
    { status: 202, body: continuation('pending') },
    { status: 200, body: continuation('ready') },
    {
      status: 200,
      body: stream(2, 21, 'live', { receivedAt: REPORT_RECEIVED_AT, observationAgeMs: 10 }),
    },
  ]);
}

describe('runReconnectAcceptanceScenario', () => {
  it('proves same-run reconnect, cutoff refusal, and admission only after Continue', async () => {
    const fetch = successfulFetch();
    const spawn = new QueuedSpawn([processResult(0), processResult(0), processResult(1), processResult(0)]);
    let now = 10_000;
    const sleeps: number[] = [];

    const evidence = await runReconnectAcceptanceScenario(input(), {
      fetch,
      spawn,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    });

    assert.deepEqual(
      evidence.sourceAttempts.map(({ markerId, protocol, runNumber, outcome }) => ({
        markerId,
        protocol,
        runNumber,
        outcome,
      })),
      [
        { markerId: 'A', protocol: 'rtmp', runNumber: 1, outcome: 'admitted' },
        { markerId: 'B', protocol: 'srt', runNumber: 1, outcome: 'resumed' },
        { markerId: 'C', protocol: 'rtmp', runNumber: 1, outcome: 'refused_closed' },
        { markerId: 'C', protocol: 'rtmp', runNumber: 2, outcome: 'admitted_after_continue' },
      ],
    );
    assert.deepEqual(evidence.incumbentRun, {
      runNumber: 1,
      firstPublisherStartedAtMs: 10_000,
      firstLiveRevision: 2,
      firstWaitingRevision: 3,
      firstReconnectRemainingMs: 55_000,
      firstWaitingReportReceivedAt: REPORT_RECEIVED_AT,
      firstWaitingObservationAgeMs: 25,
      reconnectPublisherStartedAtMs: 10_000,
      reconnectAttemptDelayMs: 0,
      resumedLiveRevision: 4,
      cutoffWaitingRevision: 5,
      reconnectRemainingMs: 41_000,
      waitingReportReceivedAt: REPORT_RECEIVED_AT,
      waitingObservationAgeMs: 40,
      cutoffWaitStartedAtMs: 10_000,
      terminalRevision: 6,
      terminalState: 'vod',
      closeReason: 'reconnect_timeout',
    });
    assert.deepEqual(evidence.continuedRun, { runNumber: 2, liveRevision: 21 });
    assert.ok(sleeps.includes(42_000), 'cutoff wait uses the server-derived remaining budget plus one poll');
    assert.deepEqual(
      spawn.processes.map((process) => ({ stopCalls: process.stopCalls, waitCalls: process.waitCalls })),
      [
        { stopCalls: 1, waitCalls: 0 },
        { stopCalls: 1, waitCalls: 0 },
        { stopCalls: 0, waitCalls: 1 },
        { stopCalls: 1, waitCalls: 0 },
      ],
    );
    assert.equal(JSON.stringify(evidence).includes('credential-bearing'), false);
    assert.equal(JSON.stringify(evidence).includes('fixture-auth:'), false);
  });

  it('refuses a premature terminal state while the compatible source reconnects and reaps it', async () => {
    const fetch = new QueuedFetch([
      { status: 200, body: stream(1, 1, 'ready') },
      { status: 200, body: stream(1, 2, 'live') },
      {
        status: 200,
        body: stream(1, 3, 'waiting', {
          reconnectRemainingMs: 55_000,
          receivedAt: REPORT_RECEIVED_AT,
          observationAgeMs: 25,
        }),
      },
      { status: 200, body: stream(1, 4, 'vod', { closeReason: 'reconnect_timeout' }) },
    ]);
    const spawn = new QueuedSpawn([processResult(0), processResult(0)]);

    await assert.rejects(
      runReconnectAcceptanceScenario(input(), {
        fetch,
        spawn,
        clock: { now: () => 10_000, sleep: async () => {} },
      }),
      /closed before the compatible reconnect was admitted/i,
    );
    assert.equal(spawn.processes[0].stopCalls, 1);
    assert.equal(spawn.processes[1].stopCalls, 1);
  });

  it('requires a real publisher refusal while the incumbent closed run stays exact', async () => {
    const fetch = successfulFetch();
    const spawn = new QueuedSpawn([processResult(0), processResult(0), processResult(0)]);
    let now = 10_000;

    await assert.rejects(
      runReconnectAcceptanceScenario(input(), {
        fetch,
        spawn,
        clock: {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
      }),
      /accepted a publisher before Continue/i,
    );
    assert.equal(spawn.processes[2].waitCalls, 1);
    assert.equal(spawn.processes[2].stopCalls, 1);
  });

  it('refuses an owner-state mutation after the closed publisher is rejected', async () => {
    const fetch = successfulFetch(stream(1, 7, 'vod', { closeReason: 'reconnect_timeout' }));
    const spawn = new QueuedSpawn([processResult(0), processResult(0), processResult(1)]);
    let now = 10_000;

    await assert.rejects(
      runReconnectAcceptanceScenario(input(), {
        fetch,
        spawn,
        clock: {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
      }),
      /changed the incumbent managed run/i,
    );
    assert.equal(spawn.processes[2].waitCalls, 1);
  });
});
