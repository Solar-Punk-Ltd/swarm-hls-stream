import { BeeResponseError, FeedIndex, PrivateKey } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  AdminApiClient,
  ManagedRenditionReport,
  ManagedRenditionReportResponse,
} from '../src/libs/AdminApiClient.js';
import { AdminLadderRegistry } from '../src/libs/AdminLadderRegistry.js';
import { BeePublisherPool } from '../src/libs/BeePublisherPool.js';
import { LadderIdentity } from '../src/libs/LadderRegistry.js';
import { ManagedMasterStore } from '../src/libs/ManagedMasterStore.js';
import { ManagedRenditionStore } from '../src/libs/ManagedRenditionStore.js';
import { MasterFeedWriter } from '../src/libs/MasterFeedWriter.js';
import { MEDIA_TYPE_VIDEO, Rendition } from '../src/types.js';

const ADMIN_URL = 'http://admin.test:9877';
const ADMIN_TOKEN = 'admin-api-token-0123456789abcdef';
const STREAM_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_A = '22222222-2222-4222-8222-222222222222';
const CLAIM_B = '44444444-4444-4444-8444-444444444444';
const GROUP = '55555555-5555-4555-8555-555555555555';
const TEST_KEY = '0'.repeat(63) + '1';
const OBSERVED_AT = '2026-09-20T10:00:00.000Z';

const rung = (name: string, height: number, final?: { index: number; duration: number }): Rendition => ({
  name,
  topic: name === '360p' ? '33333333-3333-4333-8333-333333333333' : '66666666-6666-4666-8666-666666666666',
  width: (height * 16) / 9,
  height,
  bandwidth: height * 2_000,
  avgBandwidth: height * 1_800,
  ...(final ?? {}),
});

const expected = [rung('360p', 360), rung('720p', 720)];

function identity(runNumber: number, claimId: string): LadderIdentity {
  return {
    title: 'managed ladder',
    owner: '0xowner',
    group: GROUP,
    mediatype: MEDIA_TYPE_VIDEO,
    adminStreamId: STREAM_ID,
    managedRun: {
      runNumber,
      uploaderId: 'srs-uploader-a',
      claimId,
      expectedRenditions: expected,
    },
  };
}

function response(
  request: ManagedRenditionReport,
  runNumber: number,
  claimId: string,
  renditionRevision: number,
  renditions: Rendition[],
): ManagedRenditionReportResponse {
  const finished = renditions.length === expected.length && renditions.every((item) => item.index !== undefined);
  return {
    lifecycleVersion: 1,
    streamId: STREAM_ID,
    runNumber,
    revision: 9,
    uploaderId: request.uploaderId,
    claimId,
    renditionRevision,
    renditions,
    ladder: {
      finished,
      flippedToFinished: finished,
      duration: finished ? Math.max(...renditions.map((item) => item.duration!)) : null,
    },
  };
}

interface Harness {
  registry: AdminLadderRegistry;
  reports: ManagedRenditionReport[];
  urls: string[];
  masters: string[];
}

function makeHarness(
  root: string,
  answer: (request: ManagedRenditionReport, call: number) => ManagedRenditionReportResponse | Promise<ManagedRenditionReportResponse>,
): Harness {
  const reports: ManagedRenditionReport[] = [];
  const urls: string[] = [];
  const masters: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    const report = JSON.parse(String(init?.body)) as ManagedRenditionReport;
    reports.push(report);
    return new Response(JSON.stringify(await answer(report, reports.length)), { status: 200 });
  }) as typeof globalThis.fetch;
  const bee = {
    makeFeedReader: () => ({
      downloadPayload: async () => {
        throw new BeeResponseError('GET', '/feeds', 'Not Found.', undefined, 404, 'Not Found');
      },
    }),
    makeFeedWriter: () => ({
      uploadPayload: async (_stamp: string, payload: unknown, options: { index: FeedIndex }) => {
        masters.push(`${options.index.toBigInt()}:${String(payload)}`);
        return { reference: { toHex: () => 'a'.repeat(64) } };
      },
    }),
  };
  const publishers = {
    coordinator: () => ({ rung: 'coordinator', stamp: 'stamp', bee }),
  } as unknown as BeePublisherPool;
  return {
    registry: new AdminLadderRegistry({
      client: new AdminApiClient({ baseUrl: ADMIN_URL, token: ADMIN_TOKEN, fetcher, sleep: async () => {} }),
      masterWriter: new MasterFeedWriter(publishers, new PrivateKey(TEST_KEY)),
      managedStore: new ManagedRenditionStore(path.join(root, 'renditions')),
      managedMasterStore: new ManagedMasterStore(path.join(root, 'masters')),
      observedAt: () => OBSERVED_AT,
    }),
    reports,
    urls,
    masters,
  };
}

describe('managed AdminLadderRegistry', () => {
  const roots: string[] = [];
  const makeRoot = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-admin-ladder-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the run-scoped route and retries the exact durable event after restart', async () => {
    const root = makeRoot();
    const first = makeHarness(root, (report) => response(report, 2, CLAIM_A, 1, [report.rendition]));
    await first.registry.upsertRendition(identity(2, CLAIM_A), expected[0]);

    const restarted = makeHarness(root, (report) => response(report, 2, CLAIM_A, 1, [report.rendition]));
    await restarted.registry.upsertRendition(identity(2, CLAIM_A), expected[0]);

    assert.equal(
      first.urls[0],
      `${ADMIN_URL}/api/internal/streams/${STREAM_ID}/runs/2/renditions/360p`,
    );
    assert.deepEqual(restarted.reports[0], first.reports[0]);
    assert.equal(first.reports[0].observedAt, OBSERVED_AT);
    assert.equal(first.reports[0].renditionSequence, 1);
  });

  it('does not publish a delayed old-run aggregate after a newer run', async () => {
    const root = makeRoot();
    let releaseOld!: (value: ManagedRenditionReportResponse) => void;
    const oldResponse = new Promise<ManagedRenditionReportResponse>((resolve) => {
      releaseOld = resolve;
    });
    const harness = makeHarness(root, (report, call) => {
      if (call === 1) {
        return oldResponse;
      }
      return response(report, 3, CLAIM_B, 1, [report.rendition]);
    });

    const old = harness.registry.upsertRendition(identity(2, CLAIM_A), expected[0]);
    await harness.registry.upsertRendition(identity(3, CLAIM_B), expected[0]);
    releaseOld(response(harness.reports[0], 2, CLAIM_A, 1, [harness.reports[0].rendition]));
    await old;

    assert.equal(harness.masters.length, 1);
  });

  it('does not publish an older aggregate revision that arrives last', async () => {
    const root = makeRoot();
    let releaseOlder!: (value: ManagedRenditionReportResponse) => void;
    const olderResponse = new Promise<ManagedRenditionReportResponse>((resolve) => {
      releaseOlder = resolve;
    });
    const harness = makeHarness(root, (report, call) => {
      if (call === 1) {
        return olderResponse;
      }
      return response(report, 2, CLAIM_A, 2, [expected[0], report.rendition]);
    });

    const older = harness.registry.upsertRendition(identity(2, CLAIM_A), expected[0]);
    await harness.registry.upsertRendition(identity(2, CLAIM_A), expected[1]);
    releaseOlder(response(harness.reports[0], 2, CLAIM_A, 1, [harness.reports[0].rendition]));
    await older;

    assert.equal(harness.masters.length, 1);
    assert.match(harness.masters[0], new RegExp(expected[0].topic));
    assert.match(harness.masters[0], new RegExp(expected[1].topic));
  });
});
