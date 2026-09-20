import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type MediaScenarioFetch,
  type MediaScenarioFetchRequest,
  type MediaScenarioProcess,
  type MediaScenarioProcessInvocation,
  type MediaScenarioProcessResult,
  type MediaScenarioSpawn,
  runContinuationMediaScenario,
} from '../src/continuation/mediaScenario.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const STREAM_ID = '11111111-1111-4111-8111-111111111111';
const TOPIC = '22222222-2222-4222-8222-222222222222';
const MASTER_TOPIC = TOPIC;
const RUNG_TOPIC = '33333333-3333-4333-8333-333333333333';
const MASTER_REFERENCES = ['a', 'b', 'c'].map((letter) => letter.repeat(64));
const RUNG_REFERENCES = ['d', 'e', 'f'].map((letter) => letter.repeat(64));

type Marker = 'A' | 'B' | 'C';

function stream(
  runNumber: number,
  revision: number,
  state: 'ready' | 'live' | 'waiting' | 'closed' | 'vod',
  completedMarkers = 0,
): unknown {
  return {
    id: STREAM_ID,
    topic: TOPIC,
    lifecycle: {
      version: 1,
      revision,
      runNumber,
      state,
      permission: state === 'ready' ? 'open' : state === 'vod' ? 'closed' : 'claimed',
      canContinue: state === 'vod',
    },
    ...(completedMarkers > 0
      ? {
          completedRecording: {
            runNumber,
            master: {
              topic: MASTER_TOPIC,
              index: 10 + completedMarkers,
              reference: MASTER_REFERENCES[completedMarkers - 1],
              duration: completedMarkers * 6,
            },
            expectedRenditions: ['720p'],
            renditions: [
              {
                name: '720p',
                topic: RUNG_TOPIC,
                index: 20 + completedMarkers,
                reference: RUNG_REFERENCES[completedMarkers - 1],
                duration: completedMarkers * 6,
                width: 1280,
                height: 720,
                bandwidth: 2_800_000,
                avgBandwidth: 2_500_000,
              },
            ],
          },
        }
      : {}),
  };
}

function continuation(marker: 'B' | 'C', status: 'pending' | 'ready'): unknown {
  const nextRunNumber = marker === 'B' ? 2 : 3;
  return {
    operation: {
      lifecycleVersion: 1,
      operationId:
        `${marker === 'B' ? '4' : '5'}`.repeat(8) + '-4444-4444-8444-' + `${marker === 'B' ? '4' : '5'}`.repeat(12),
      requestId:
        `${marker === 'B' ? '6' : '7'}`.repeat(8) + '-4444-4444-8444-' + `${marker === 'B' ? '6' : '7'}`.repeat(12),
      status,
      streamId: STREAM_ID,
      topic: TOPIC,
      mediaType: 'video',
      previousRunNumber: nextRunNumber - 1,
      nextRunNumber,
      revision: nextRunNumber * 10,
      ...(status === 'ready' ? { checkpointReference: `${marker === 'B' ? '8' : '9'}`.repeat(64) } : {}),
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

function rawFrames(markers: readonly Marker[]): Uint8Array {
  const pixels: Record<Marker, readonly [number, number, number]> = {
    A: [230, 20, 20],
    B: [20, 230, 20],
    C: [20, 20, 230],
  };
  return Uint8Array.from(markers.flatMap((marker) => [...pixels[marker], ...pixels[marker]]));
}

function decoded(markers: readonly Marker[]): MediaScenarioProcessResult {
  return {
    code: 0,
    stdout: rawFrames(markers),
    stderr: markers
      .flatMap((_, markerIndex) => [markerIndex * 2, markerIndex * 2 + 1])
      .map((pts) => `[Parsed_showinfo_0] n:${pts} pts:${pts * 90_000} pts_time:${pts}`)
      .join('\n'),
  };
}

function decodedAudio(markers: readonly Marker[]): MediaScenarioProcessResult {
  const frequencies: Record<Marker, number> = { A: 440, B: 880, C: 1320 };
  return {
    code: 0,
    stdout: new Uint8Array(),
    stderr: markers
      .flatMap((marker, markerIndex) => [markerIndex * 2, markerIndex * 2 + 1].map((pts) => ({ marker, pts })))
      .map(
        ({ marker, pts }) =>
          `frame:${pts} pts:${pts * 8_000} pts_time:${pts}\nlavfi.aspectralstats.1.centroid=${frequencies[marker]}`,
      )
      .join('\n'),
  };
}

class CompletedProcess implements MediaScenarioProcess {
  stopCalls = 0;

  constructor(private readonly result: MediaScenarioProcessResult) {}

  async wait(): Promise<MediaScenarioProcessResult> {
    return this.result;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

class RecordingSpawn implements MediaScenarioSpawn {
  readonly invocations: MediaScenarioProcessInvocation[] = [];
  readonly processes: CompletedProcess[] = [];
  private decodeIndex = 0;
  private currentDecode: readonly Marker[] | undefined;

  constructor(private readonly decodeMarkers: readonly (readonly Marker[])[]) {}

  async spawn(invocation: MediaScenarioProcessInvocation): Promise<MediaScenarioProcess> {
    this.invocations.push(structuredClone(invocation));
    if (invocation.purpose === 'decode-video') {
      const markers = this.decodeMarkers[this.decodeIndex++];
      assert.ok(markers, 'unexpected decode invocation');
      this.currentDecode = markers;
      const process = new CompletedProcess(decoded(markers));
      this.processes.push(process);
      return process;
    }
    if (invocation.purpose === 'decode-audio') {
      assert.ok(this.currentDecode, 'audio decode must follow video decode');
      const markers = this.currentDecode;
      this.currentDecode = undefined;
      const process = new CompletedProcess(decodedAudio(markers));
      this.processes.push(process);
      return process;
    }
    const process = new CompletedProcess({ code: 0, stdout: new Uint8Array(), stderr: '' });
    this.processes.push(process);
    return process;
  }
}

function input() {
  return {
    fixtureId: FIXTURE_ID,
    srs: { host: 'srs', rtmpPort: 10012, srtPort: 10011 },
    viewer: {
      controlBaseUrl: 'http://127.0.0.1:18081',
      mediaBaseUrl: 'http://client',
    },
    adminBaseUrl: 'http://127.0.0.1:18080',
    stream: { id: STREAM_ID, topic: TOPIC, mediaType: 'video' as const },
    uploaderId: 'fixture-srs-uploader',
    authReferences: {
      owner: 'fixture-auth:owner',
      publishKey: 'fixture-auth:publish-key',
      srtPassphrase: 'fixture-auth:srt-passphrase',
    },
  };
}

function successfulFetch(): QueuedFetch {
  return new QueuedFetch([
    { status: 200, body: stream(1, 1, 'ready') },
    { status: 200, body: stream(1, 2, 'live') },
    { status: 200, body: stream(1, 5, 'vod', 1) },
    { status: 202, body: continuation('B', 'pending') },
    { status: 200, body: continuation('B', 'ready') },
    { status: 200, body: stream(2, 21, 'live', 1) },
    { status: 200, body: stream(2, 25, 'vod', 2) },
    { status: 202, body: continuation('C', 'pending') },
    { status: 200, body: continuation('C', 'ready') },
    { status: 200, body: stream(3, 31, 'live', 2) },
    { status: 200, body: stream(3, 35, 'vod', 3) },
  ]);
}

describe('runContinuationMediaScenario', () => {
  it('publishes A/B/C through both SRS protocols and proves cumulative replay plus the old snapshot', async () => {
    const fetch = successfulFetch();
    const spawn = new RecordingSpawn([['A'], ['A', 'B'], ['A', 'B', 'C'], ['A']]);
    let now = Date.parse('2026-09-21T00:00:00.000Z');

    const evidence = await runContinuationMediaScenario(input(), {
      fetch,
      spawn,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });

    assert.deepEqual(
      evidence.sources.map(({ markerId, protocol }) => ({ markerId, protocol })),
      [
        { markerId: 'A', protocol: 'rtmp' },
        { markerId: 'B', protocol: 'srt' },
        { markerId: 'C', protocol: 'rtmp' },
      ],
    );
    assert.deepEqual(
      evidence.snapshots.map((snapshot) => ({
        runNumber: snapshot.runNumber,
        lifecycleRevision: snapshot.lifecycleRevision,
        master: [snapshot.master.reference, snapshot.master.index],
        rung: [snapshot.renditions[0]?.reference, snapshot.renditions[0]?.index],
        videoMarkers: snapshot.decoded.videoMarkerRanges.map((range) => range.markerId),
        audioMarkers: snapshot.decoded.audioMarkerRanges.map((range) => range.markerId),
      })),
      [
        {
          runNumber: 1,
          lifecycleRevision: 5,
          master: [MASTER_REFERENCES[0], 11],
          rung: [RUNG_REFERENCES[0], 21],
          videoMarkers: ['A'],
          audioMarkers: ['A'],
        },
        {
          runNumber: 2,
          lifecycleRevision: 25,
          master: [MASTER_REFERENCES[1], 12],
          rung: [RUNG_REFERENCES[1], 22],
          videoMarkers: ['A', 'B'],
          audioMarkers: ['A', 'B'],
        },
        {
          runNumber: 3,
          lifecycleRevision: 35,
          master: [MASTER_REFERENCES[2], 13],
          rung: [RUNG_REFERENCES[2], 23],
          videoMarkers: ['A', 'B', 'C'],
          audioMarkers: ['A', 'B', 'C'],
        },
      ],
    );
    assert.equal(evidence.preservedSnapshot.runNumber, 1);
    assert.equal(evidence.preservedSnapshot.reference, RUNG_REFERENCES[0]);
    assert.deepEqual(
      evidence.preservedSnapshot.decoded.videoMarkerRanges.map((range) => range.markerId),
      ['A'],
    );
    assert.deepEqual(
      evidence.preservedSnapshot.decoded.audioMarkerRanges.map((range) => range.markerId),
      ['A'],
    );

    const publishers = spawn.invocations.filter((invocation) => invocation.purpose === 'publish');
    assert.deepEqual(
      publishers.map((invocation) => invocation.protocol),
      ['rtmp', 'srt', 'rtmp'],
    );
    assert.equal(
      publishers.every((invocation) => invocation.args.some((argument) => typeof argument !== 'string')),
      true,
      'publish targets retain symbolic credential references',
    );
    assert.equal(JSON.stringify(evidence).includes('fixture-auth:'), false);
    assert.equal(JSON.stringify(spawn.invocations).includes('?key='), true);
    assert.equal(JSON.stringify(spawn.invocations).includes('fixture-auth:publish-key'), true);
    assert.match(JSON.stringify(publishers[0]?.args), /rtmp:\/\/srs:10012\/video\//);
    assert.match(JSON.stringify(publishers[1]?.args), /srt:\/\/srs:10011\?streamid=/);

    const decoders = spawn.invocations.filter((invocation) => invocation.purpose.startsWith('decode-'));
    assert.equal(decoders.length, 8);
    assert.equal(JSON.stringify(decoders).includes('http://client/bee/bytes/'), true);
    assert.equal(JSON.stringify(decoders).includes('-allowed_extensions'), true);
    assert.equal(JSON.stringify(decoders).includes('-extension_picky'), true);
    assert.equal(
      evidence.snapshots.every((snapshot) => snapshot.decoded.evidenceKind === 'sampled-order'),
      true,
    );
    assert.equal(
      evidence.snapshots.every((snapshot) => snapshot.decoded.audioAnalysisWindowSeconds === 0.256),
      true,
    );
    assert.equal(
      evidence.snapshots.every((snapshot) => snapshot.decoded.audioAnalysisHopSeconds === 0.128),
      true,
    );
    assert.equal(
      evidence.snapshots.every((snapshot) => snapshot.decoded.audioCentroidUnit === 'hertz'),
      true,
    );

    const continuationPosts = fetch.requests.filter((request) => request.method === 'POST');
    assert.equal(continuationPosts.length, 2);
    assert.deepEqual(
      continuationPosts.map((request) => request.authReference),
      ['fixture-auth:owner', 'fixture-auth:owner'],
    );
  });

  it('refuses a broken cumulative seam and withholds process diagnostics', async () => {
    const fetch = successfulFetch();
    const spawn = new RecordingSpawn([['A'], ['B'], ['A', 'B', 'C'], ['A']]);

    await assert.rejects(
      runContinuationMediaScenario(input(), {
        fetch,
        spawn,
        clock: { now: () => 1_000, sleep: async () => {} },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /cumulative replay/i);
        assert.doesNotMatch(error.message, /fixture-auth:/);
        return true;
      },
    );
  });

  it('refuses host publish endpoints before spawning media', async () => {
    const fetch = successfulFetch();
    const spawn = new RecordingSpawn([]);

    await assert.rejects(
      runContinuationMediaScenario(
        { ...input(), srs: { host: '127.0.0.1', rtmpPort: 1935, srtPort: 10080 } },
        {
          fetch,
          spawn,
          clock: { now: () => 1_000, sleep: async () => {} },
        },
      ),
      /internal SRS endpoint/i,
    );
    assert.equal(spawn.invocations.length, 0);
    assert.equal(fetch.requests.length, 0);
  });

  it('re-decodes run A after run C and refuses changed immutable bytes', async () => {
    const fetch = successfulFetch();
    const spawn = new RecordingSpawn([['A'], ['A', 'B'], ['A', 'B', 'C'], ['B']]);

    await assert.rejects(
      runContinuationMediaScenario(input(), {
        fetch,
        spawn,
        clock: { now: () => 1_000, sleep: async () => {} },
      }),
      /cumulative replay/i,
    );
  });

  it('withholds a child error that contains resolved process credentials', async () => {
    const fetch = successfulFetch();
    const spawn: MediaScenarioSpawn = {
      async spawn() {
        throw new Error('ffmpeg rejected raw-publish-key-value');
      },
    };

    await assert.rejects(
      runContinuationMediaScenario(input(), {
        fetch,
        spawn,
        clock: { now: () => 1_000, sleep: async () => {} },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /publisher A failed/i);
        assert.doesNotMatch(error.message, /raw-publish-key-value/);
        return true;
      },
    );
  });

  it('stops and reaps a publisher when lifecycle polling refuses', async () => {
    const fetch = new QueuedFetch([
      { status: 200, body: stream(1, 1, 'ready') },
      { status: 503, body: { error: 'offline' } },
    ]);
    const spawn = new RecordingSpawn([]);

    await assert.rejects(
      runContinuationMediaScenario(input(), {
        fetch,
        spawn,
        clock: { now: () => 1_000, sleep: async () => {} },
      }),
      /failed without exposing authorization data/i,
    );
    assert.equal(spawn.processes.length, 1);
    assert.equal(spawn.processes[0].stopCalls, 1);
  });
});
