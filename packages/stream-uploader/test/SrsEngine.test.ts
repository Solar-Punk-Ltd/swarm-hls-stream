import express from 'express';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import { createSrsEngine, resolveSegmentPath } from '../src/engines/srs.js';
import { SRS_WEBHOOK_TOKEN_PARAM } from '../src/engines/srs/webhookToken.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { REJECT_QUEUE_FULL, type SegmentResult } from '../src/types.js';

import { listenOnLoopback } from './helpers/loopbackServer.js';

const MEDIA_ROOT = '/srv/media';
const SRS_PREFIX = './objs/nginx/html/';

// The three vectors from the SEC-2 acceptance criteria. Each reaches the handler on an
// unauthenticated webhook, and the handler reads then deletes whatever the path names.
const ESCAPING_PATHS = [
  { name: 'an absolute path, which path.resolve would adopt wholesale', file: '/etc/shadow' },
  { name: 'a bare traversal', file: '../../etc/passwd' },
  { name: 'a traversal hidden behind the expected prefix', file: `${SRS_PREFIX}../../../etc/passwd` },
];

const TEST_WEBHOOK_TOKEN = 'srs-webhook-token-0123456789abcdef';

describe('resolveSegmentPath containment (SEC-2)', () => {
  for (const { name, file } of ESCAPING_PATHS) {
    it(`rejects ${name}`, () => {
      assert.equal(resolveSegmentPath(MEDIA_ROOT, file), undefined);
    });
  }

  it('rejects the media root itself, which is a directory rather than a segment', () => {
    assert.equal(resolveSegmentPath(MEDIA_ROOT, SRS_PREFIX), undefined);
  });

  it('rejects a sibling directory that merely starts with the root path', () => {
    assert.equal(resolveSegmentPath(MEDIA_ROOT, '../media-evil/segment.ts'), undefined);
  });

  it('resolves a legitimate segment under the media root', () => {
    assert.equal(
      resolveSegmentPath(MEDIA_ROOT, `${SRS_PREFIX}video/demo-1.ts`),
      path.join(MEDIA_ROOT, 'video/demo-1.ts'),
    );
  });

  it('resolves against a relative media root the same way the running uploader does', () => {
    assert.equal(
      resolveSegmentPath('./media', `${SRS_PREFIX}video/demo-1.ts`),
      path.resolve('./media', 'video/demo-1.ts'),
    );
  });
});

interface SegmentCall {
  streamId: string;
  segmentIndex: number;
  size: number;
}

interface LossCall {
  streamId: string;
  firstIndex: number;
  count: number;
}

function fakeOrchestrator(calls: SegmentCall[], losses: LossCall[] = [], outcome: SegmentResult = { accepted: true }): StreamOrchestrator {
  return {
    handleSegment: (streamId: string, segmentIndex: number, _duration: number, data: Buffer) => {
      calls.push({ streamId, segmentIndex, size: data.length });
      return outcome;
    },
    handleSegmentLoss: (streamId: string, firstIndex: number, count: number) => {
      losses.push({ streamId, firstIndex, count });
      return true;
    },
  } as unknown as StreamOrchestrator;
}

async function postHls(mediaRoot: string, orchestrator: StreamOrchestrator, file?: string): Promise<number> {
  const engine = createSrsEngine(mediaRoot, { webhookToken: TEST_WEBHOOK_TOKEN });
  const app = express();
  app.use(express.json());
  app.use(engine.prefix, engine.createRouter(orchestrator));

  const { server, baseUrl } = await listenOnLoopback(app);
  try {
    const response = await fetch(`${baseUrl}${engine.prefix}/hls?${SRS_WEBHOOK_TOKEN_PARAM}=${TEST_WEBHOOK_TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'on_hls', app: 'video', stream: 'demo', file, seq_no: 1, duration: 4 }),
    });
    return response.status;
  } finally {
    server.close();
  }
}

const SEGMENT_BYTES = 'segment-bytes';
const DECOY_BYTES = 'do-not-touch';

interface RecordedCall {
  arguments: unknown[];
}

interface FsSpy {
  mock: { calls: RecordedCall[] };
}

// The first path argument of every recorded call. A total call count would be the wrong instrument
// here: tsx's loader and undici both read files of their own while a request is in flight, so the
// count is not attributable to the code under test.
function pathsPassedTo(spy: FsSpy): string[] {
  return spy.mock.calls.map((call) => String(call.arguments[0]));
}

describe('SRS /hls route reaches the filesystem only inside the media root (SEC-2)', () => {
  let sandbox: string;
  let mediaRoot: string;
  let decoyPath: string;
  let segmentPath: string;

  // The decoy sits one level above the media root and really exists, so a vulnerable handler reads
  // and deletes it. Pointing these cases at /etc/passwd instead would pass for the wrong reason:
  // the path resolves to nothing under a temp root, so the spies would read zero either way.
  before(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-media-'));
    mediaRoot = path.join(sandbox, 'media');
    decoyPath = path.join(sandbox, 'outside.ts');
    segmentPath = path.join(mediaRoot, 'video', 'demo-1.ts');
    fs.mkdirSync(path.join(mediaRoot, 'video'), { recursive: true });
  });

  beforeEach(() => {
    fs.writeFileSync(decoyPath, DECOY_BYTES);
    fs.writeFileSync(segmentPath, SEGMENT_BYTES);
  });

  afterEach(() => {
    mock.restoreAll();
  });

  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Spying rather than stubbing: the happy-path case below asserts these same spies DID record a
  // read and a delete, which is what proves a zero count on an escaping path means containment and
  // not a spy that was never wired to the module under test.
  const escapingRouteCases = [
    { name: 'an absolute path to a file outside the root', file: () => decoyPath },
    { name: 'a bare traversal', file: () => '../outside.ts' },
    { name: 'a traversal behind a plausible segment directory', file: () => `${SRS_PREFIX}video/../../outside.ts` },
  ];

  for (const { name, file } of escapingRouteCases) {
    it(`touches no file for ${name}`, async () => {
      const readFileSync = mock.method(fs, 'readFileSync');
      const rmSync = mock.method(fs, 'rmSync');
      const calls: SegmentCall[] = [];

      const status = await postHls(mediaRoot, fakeOrchestrator(calls), file());

      assert.equal(status, 200, 'SRS treats a non-200 as an ingest error, so a rejection still answers 200');
      assert.ok(!pathsPassedTo(readFileSync).includes(decoyPath), `read ${decoyPath} for ${file()}`);
      assert.ok(!pathsPassedTo(rmSync).includes(decoyPath), `deleted ${decoyPath} for ${file()}`);
      assert.equal(calls.length, 0, 'an escaping path must never reach the orchestrator, which spends stamp funds');
      assert.equal(fs.readFileSync(decoyPath, 'utf8'), DECOY_BYTES, 'the file outside the media root survives intact');
    });
  }

  // The request body is an unchecked cast at the handler boundary, so `file` can be absent at
  // runtime whatever the type says. Validating it belongs with the request schemas in S1.5. What
  // belongs here is that the boundary fails closed instead of reaching the media volume on its way
  // to failing, which is the property a future refactor could quietly lose.
  it('fails closed when the body carries no file field', async () => {
    const readFileSync = mock.method(fs, 'readFileSync');
    const rmSync = mock.method(fs, 'rmSync');
    const calls: SegmentCall[] = [];

    const status = await postHls(mediaRoot, fakeOrchestrator(calls));

    assert.equal(status, 200);
    const touched = [...pathsPassedTo(readFileSync), ...pathsPassedTo(rmSync)].filter((p) => p.startsWith(sandbox));
    assert.deepEqual(touched, [], 'a malformed body must not reach the media volume at all');
    assert.equal(calls.length, 0);
  });

  it('reads, uploads and then deletes a legitimate segment', async () => {
    const readFileSync = mock.method(fs, 'readFileSync');
    const rmSync = mock.method(fs, 'rmSync');
    const calls: SegmentCall[] = [];

    const status = await postHls(mediaRoot, fakeOrchestrator(calls), `${SRS_PREFIX}video/demo-1.ts`);

    assert.equal(status, 200);
    assert.ok(pathsPassedTo(readFileSync).includes(segmentPath), 'the segment inside the media root must be read');
    assert.deepEqual(calls, [{ streamId: 'video/demo', segmentIndex: 1, size: SEGMENT_BYTES.length }]);
    assert.ok(pathsPassedTo(rmSync).includes(segmentPath), 'an accepted segment must be deleted');
    assert.equal(fs.existsSync(segmentPath), false, 'an accepted segment is removed from the media volume');
  });
});

/**
 * Every one of these answers 200 and drops the segment, which is correct: SRS reads a rejected
 * `on_hls` as permission to drop the rest of the broadcast silently rather than as a retry. What was
 * missing is the other half. Without the loss being reported, `segments_lost_total` stays at zero
 * through a queue-full episode, the health signal aged off it never moves, and the manifest names
 * the segments either side of the hole as contiguous, so a viewer's player is told a join is seamless
 * when media is missing from it. Until this landed, the only engine that reported a loss was the OME
 * puller, which is the one that is deferred.
 */
describe('a segment SRS delivered and the uploader never took is accounted as lost', () => {
  let sandbox: string;
  let mediaRoot: string;
  let segmentPath: string;

  before(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-loss-'));
    mediaRoot = path.join(sandbox, 'media');
    segmentPath = path.join(mediaRoot, 'video', 'demo-1.ts');
    fs.mkdirSync(path.join(mediaRoot, 'video'), { recursive: true });
  });

  beforeEach(() => {
    fs.writeFileSync(segmentPath, SEGMENT_BYTES);
  });

  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const LOST_ONCE = [{ streamId: 'video/demo', firstIndex: 1, count: 1 }];

  it('reports the loss when the uploader refuses the segment under backpressure', async () => {
    const losses: LossCall[] = [];

    const status = await postHls(
      mediaRoot,
      fakeOrchestrator([], losses, { accepted: false, reason: REJECT_QUEUE_FULL }),
      `${SRS_PREFIX}video/demo-1.ts`,
    );

    assert.equal(status, 200, 'answering a rejection would cost the rest of the broadcast rather than buy a retry');
    assert.deepEqual(losses, LOST_ONCE);
  });

  it('reports the loss when the segment file is gone before it can be read', async () => {
    fs.rmSync(segmentPath);
    const losses: LossCall[] = [];

    const status = await postHls(mediaRoot, fakeOrchestrator([], losses), `${SRS_PREFIX}video/demo-1.ts`);

    assert.equal(status, 200);
    assert.deepEqual(losses, LOST_ONCE);
  });

  it('reports the loss when the named path escapes the media root', async () => {
    const losses: LossCall[] = [];

    const status = await postHls(mediaRoot, fakeOrchestrator([], losses), '../outside.ts');

    assert.equal(status, 200);
    assert.deepEqual(losses, LOST_ONCE);
  });

  // The control for the three above. Without it they would all pass against a handler that reported
  // every segment as lost.
  it('reports nothing when the segment is taken', async () => {
    const losses: LossCall[] = [];
    const calls: SegmentCall[] = [];

    const status = await postHls(mediaRoot, fakeOrchestrator(calls, losses), `${SRS_PREFIX}video/demo-1.ts`);

    assert.equal(status, 200);
    assert.equal(calls.length, 1, 'the segment must actually have reached the uploader for this to be a control');
    assert.deepEqual(losses, []);
  });
});
