/**
 * The two calls admin mode is built on, driven over a real socket. See `src/libs/AdminApiClient.ts`.
 *
 * ⛔ Over a real HTTP server rather than a stubbed `fetch`, because half of what this client is for
 * lives below the function call: the bearer header, the path it builds out of an ingest id, the
 * abort window, and what node's fetch does with a body that is not JSON. A stub proves the branches
 * and none of those, and the branches are the easy half.
 *
 * The two calls have deliberately opposite failure policies — a lookup throws on everything except a
 * clean 404 because a publish gate is holding a broadcaster open, and a report never throws and
 * retries instead because the thing it describes has already happened. Both halves are asserted
 * here, because each one looks like a bug from the other's side.
 */

import express from 'express';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import {
  ADMIN_STATE_LIVE,
  ADMIN_STATE_VOD,
  AdminApiClient,
  AdminStreamDraft,
  ManagedClaimRequest,
  ManagedContinuationPreparation,
  ManagedRunReport,
  MAX_STATE_REPORT_ATTEMPTS,
  MIN_ADMIN_API_TOKEN_LENGTH,
  STATE_REPORT_ACCEPTED,
  STATE_REPORT_ALREADY_SETTLED,
  STATE_REPORT_BACKOFF_MS,
  STATE_REPORT_FAILED,
  stateWasReported,
} from '../src/libs/AdminApiClient.js';
import { MEDIA_TYPE_VIDEO, Rendition } from '../src/types.js';

import { listenOnLoopback } from './helpers/loopbackServer.js';

const TOKEN = 'admin-api-token-0123456789abcdef';
const STREAM_ID = 'video/demo';
const ADMIN_STREAM_ID = 'str_01HZY';

/** A draft shaped the way the admin contract states it, so `asDraft` accepts it. */
const DRAFT: AdminStreamDraft = {
  id: ADMIN_STREAM_ID,
  topic: 'declared-topic-0001',
  owner: '0xowner',
  mediaType: MEDIA_TYPE_VIDEO,
  title: 'A declared broadcast',
  status: 'draft',
  publishKey: 'declared-publish-key',
};

const digestFixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/managed-report-digest-v1.json', import.meta.url), 'utf8'),
) as { report: ManagedRunReport; sha256HexParts: string[] };
const vodReconciliationFixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/managed-vod-reconciliation-v1.json', import.meta.url), 'utf8'),
) as {
  report: ManagedRunReport;
  reconciledCompletedRecording: unknown;
  sha256HexParts: string[];
};

interface Received {
  method: string;
  url: string;
  authorization: string | undefined;
  lifecycleVersion: string | undefined;
  body: unknown;
}

/** What a case tells the fake admin to do with the request it just took. */
type Handler = (req: express.Request, res: express.Response, call: number) => void;

interface Harness {
  client: AdminApiClient;
  /** Every request the admin actually received, in order. */
  received: Received[];
  /** Every wait the retry ladder asked for, so the policy is read rather than timed. */
  sleeps: number[];
}

async function withAdmin(
  handle: Handler,
  drive: (harness: Harness) => Promise<void>,
  options: {
    lookupTimeoutMs?: number;
    reportTimeoutMs?: number;
    baseUrlSuffix?: string;
    lifecycleVersion?: 1;
  } = {},
): Promise<void> {
  const received: Received[] = [];
  const sleeps: number[] = [];

  const app = express();
  app.use(express.json());
  app.use((req, res) => {
    received.push({
      method: req.method,
      url: req.originalUrl,
      authorization: req.get('authorization'),
      lifecycleVersion: req.get('x-stream-lifecycle-version'),
      body: req.method === 'POST' ? req.body : undefined,
    });
    handle(req, res, received.length);
  });

  const { server, baseUrl } = await listenOnLoopback(app);
  try {
    const client = new AdminApiClient({
      baseUrl: `${baseUrl}${options.baseUrlSuffix ?? ''}`,
      token: TOKEN,
      lookupTimeoutMs: options.lookupTimeoutMs,
      reportTimeoutMs: options.reportTimeoutMs,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      lifecycleVersion: options.lifecycleVersion,
    });
    await drive({ client, received, sleeps });
  } finally {
    server.close();
  }
}

/** Answers the same status to every request, which is what a retry ladder has to be measured against. */
const always =
  (status: number, body: unknown = {}): Handler =>
  (_req, res) => {
    res.status(status).json(body);
  };

describe('the admin API client, looking a draft up by ingest id', () => {
  it('asks the contract path, carries the bearer token, and reads the draft back', async () => {
    await withAdmin(always(200, DRAFT), async ({ client, received }) => {
      assert.deepEqual(await client.lookupByIngestId(STREAM_ID), DRAFT);

      assert.equal(received.length, 1);
      assert.equal(received[0].method, 'GET');
      assert.equal(received[0].url, `/api/internal/streams/by-ingest/${STREAM_ID}`);
      assert.equal(received[0].authorization, `Bearer ${TOKEN}`);
    });
  });

  /**
   * A configured `ADMIN_API_URL` with a trailing slash is the ordinary way to write a base url, and
   * `${base}/api/...` would make it `//api/...`. A router answers that with a 404, and a 404 on this
   * call means "nobody declared this stream" rather than "your url is wrong", so the deployment would
   * refuse every publish and say the broadcaster's own id was at fault.
   */
  it('does not turn a trailing slash on the base url into a second one in the path', async () => {
    await withAdmin(
      always(200, DRAFT),
      async ({ client, received }) => {
        await client.lookupByIngestId(STREAM_ID);
        assert.equal(received[0].url, `/api/internal/streams/by-ingest/${STREAM_ID}`);
      },
      { baseUrlSuffix: '/' },
    );
  });

  it('answers null for a 404, which is the one outcome that means nobody declared it', async () => {
    await withAdmin(always(404, { error: 'stream_not_found' }), async ({ client }) => {
      assert.equal(await client.lookupByIngestId(STREAM_ID), null);
    });
  });

  /**
   * ⛔ Not null. The caller turns null into "refuse this publish because it was never announced", and
   * a rejected token spelled that way is indistinguishable to a broadcaster from a stream they forgot
   * to create, while being a completely different thing to whoever is on call.
   */
  it('throws on a 401 rather than reporting it as an undeclared stream', async () => {
    await withAdmin(always(401, { error: 'unauthorized' }), async ({ client }) => {
      await assert.rejects(() => client.lookupByIngestId(STREAM_ID), /401/);
    });
  });

  it('throws on a 5xx', async () => {
    await withAdmin(always(503), async ({ client }) => {
      await assert.rejects(() => client.lookupByIngestId(STREAM_ID), /503/);
    });
  });

  /**
   * A 200 whose body is missing `publishKey` would otherwise arrive with `undefined` as the expected
   * credential, and an undefined expectation compared against a presented key is the one comparison
   * that must never be reached. Screened here rather than at the gate, so every caller gets it.
   */
  it('throws on a 200 whose body is not a draft', async () => {
    const withoutKey = { ...DRAFT } as Partial<AdminStreamDraft>;
    delete withoutKey.publishKey;

    await withAdmin(always(200, withoutKey), async ({ client }) => {
      await assert.rejects(() => client.lookupByIngestId(STREAM_ID), /not a stream/);
    });
  });

  it('throws on a media type the contract does not name', async () => {
    await withAdmin(always(200, { ...DRAFT, mediaType: 'hologram' }), async ({ client }) => {
      await assert.rejects(() => client.lookupByIngestId(STREAM_ID), /not a stream/);
    });
  });

  /**
   * ⛔ Node's fetch has no default timeout, so an admin that accepts the connection and then holds it
   * open would stall the publish gate for as long as the socket lives. SRS waits on `on_publish`
   * before it admits a publisher, so that is a broadcaster hanging rather than a broadcaster refused.
   */
  it('gives up on an admin that accepts the connection and never answers', async () => {
    await withAdmin(
      () => {
        /* deliberately never replies */
      },
      async ({ client }) => {
        await assert.rejects(() => client.lookupByIngestId(STREAM_ID));
      },
      { lookupTimeoutMs: 100 },
    );
  });
});

describe('the admin API client, negotiating lifecycle v1', () => {
  const managed = {
    ...DRAFT,
    lifecycleVersion: 1 as const,
    mode: 'managed' as const,
    expectedRenditions: [],
    lifecycle: {
      revision: 7,
      runNumber: 2,
      state: 'ready' as const,
      permission: 'open' as const,
      uploaderId: 'srs-157-90-34-105',
    },
  };

  it('sends the version header and accepts the managed envelope', async () => {
    await withAdmin(
      always(200, managed),
      async ({ client, received }) => {
        assert.deepEqual(await client.lookupByIngestId(STREAM_ID), managed);
        assert.equal(received[0].lifecycleVersion, '1');
      },
      { lifecycleVersion: 1 },
    );
  });

  it('accepts an explicit negotiated legacy row', async () => {
    const legacy = { ...DRAFT, lifecycleVersion: 1 as const, mode: 'legacy' as const };
    await withAdmin(always(200, legacy), async ({ client }) => {
      assert.deepEqual(await client.lookupByIngestId(STREAM_ID), legacy);
    }, { lifecycleVersion: 1 });
  });

  for (const [name, body] of [
    ['missing envelope', DRAFT],
    ['unsupported version', { ...managed, lifecycleVersion: 2 }],
    ['malformed managed lifecycle', { ...managed, lifecycle: { ...managed.lifecycle, runNumber: 0 } }],
  ] as const) {
    it(`refuses a ${name}`, async () => {
      await withAdmin(always(200, body), async ({ client }) => {
        await assert.rejects(() => client.lookupByIngestId(STREAM_ID), /lifecycle/);
      }, { lifecycleVersion: 1 });
    });
  }

  it('refuses an expected rendition array that is not in lexical name order', async () => {
    const expected = (name: string, topic: string) => ({
      avgBandwidth: 700_000,
      bandwidth: 700_000,
      height: 360,
      name,
      topic,
      width: 640,
    });
    const body = {
      ...managed,
      expectedRenditions: [
        expected('720p', '77777777-7777-4777-8777-777777777777'),
        expected('360p', '33333333-3333-4333-8333-333333333333'),
      ],
    };

    await withAdmin(always(200, body), async ({ client }) => {
      await assert.rejects(() => client.lookupByIngestId(STREAM_ID), /lifecycle/);
    }, { lifecycleVersion: 1 });
  });

  it('claims the exact run and validates the returned binding', async () => {
    const request: ManagedClaimRequest = {
      lifecycleVersion: 1,
      expectedRevision: 7,
      uploaderId: 'srs-157-90-34-105',
      requestId: '33333333-3333-4333-8333-333333333333',
    };
    const claimed = {
      lifecycleVersion: 1 as const,
      streamId: DRAFT.id,
      revision: 8,
      runNumber: 2,
      uploaderId: request.uploaderId,
      claimId: '44444444-4444-4444-8444-444444444444',
      expectedRenditions: [],
      state: 'claimed' as const,
      permission: 'claimed' as const,
    };
    await withAdmin(always(200, claimed), async ({ client, received }) => {
      assert.deepEqual(await client.claimManagedRun(DRAFT.id, 2, request), claimed);
      assert.equal(received[0].url, `/api/internal/streams/${DRAFT.id}/runs/2/claims`);
      assert.deepEqual(received[0].body, request);
    }, { lifecycleVersion: 1 });
  });

  it('refuses a claim response bound to another stream', async () => {
    const request: ManagedClaimRequest = {
      lifecycleVersion: 1,
      expectedRevision: 7,
      uploaderId: 'srs-157-90-34-105',
      requestId: '33333333-3333-4333-8333-333333333333',
    };
    await withAdmin(
      always(200, {
        lifecycleVersion: 1,
        streamId: 'another-stream',
        revision: 8,
        runNumber: 2,
        uploaderId: request.uploaderId,
        claimId: '44444444-4444-4444-8444-444444444444',
        expectedRenditions: [],
        state: 'claimed',
        permission: 'claimed',
      }),
      async ({ client }) => {
        await assert.rejects(() => client.claimManagedRun(DRAFT.id, 2, request), /claimed managed run/);
      },
      { lifecycleVersion: 1 },
    );
  });

  it('polls and acknowledges the exact managed continuation preparation', async () => {
    const uploaderId = 'srs-157-90-34-105';
    const operation = {
      lifecycleVersion: 1 as const,
      operationId: '11111111-1111-4111-8111-111111111111',
      requestId: '22222222-2222-4222-8222-222222222222',
      streamId: '33333333-3333-4333-8333-333333333333',
      topic: 'a'.repeat(64),
      mediaType: MEDIA_TYPE_VIDEO,
      uploaderId,
      previousRunNumber: 2,
      nextRunNumber: 3,
      revision: 11,
      status: 'pending' as const,
      retainedRecording: {
        runNumber: 2,
        checkpointReference: '44444444-4444-4444-8444-444444444444',
        master: { topic: 'a'.repeat(64), index: 7, reference: 'b'.repeat(64), duration: 12 },
        expectedRenditions: [],
        renditions: [],
      },
    };
    const preparation: ManagedContinuationPreparation = {
      lifecycleVersion: 1,
      uploaderId,
      expectedRevision: operation.revision,
      status: 'ready',
      checkpointReference: '55555555-5555-4555-8555-555555555555',
    };
    await withAdmin(
      (req, res) => {
        if (req.method === 'GET') {
          res.json({ continuations: [operation] });
          return;
        }
        res.json({
          operation: {
            ...operation,
            revision: operation.revision + 1,
            status: 'ready',
            checkpointReference: preparation.checkpointReference,
          },
        });
      },
      async ({ client, received }) => {
        assert.deepEqual(await client.listManagedContinuations(uploaderId), [operation]);
        await client.reportManagedContinuationPreparation(operation.streamId, operation.operationId, preparation);
        assert.equal(received[0].url, `/api/internal/uploaders/${uploaderId}/continuations`);
        assert.equal(
          received[1].url,
          `/api/internal/streams/${operation.streamId}/continuations/${operation.operationId}/preparation`,
        );
        assert.deepEqual(received[1].body, preparation);
      },
      { lifecycleVersion: 1 },
    );
  });

  it('refuses continuation work assigned to another uploader', async () => {
    await withAdmin(
      always(200, {
        continuations: [
          {
            lifecycleVersion: 1,
            operationId: '11111111-1111-4111-8111-111111111111',
            requestId: '22222222-2222-4222-8222-222222222222',
            streamId: '33333333-3333-4333-8333-333333333333',
            topic: 'a'.repeat(64),
            mediaType: MEDIA_TYPE_VIDEO,
            uploaderId: 'another-uploader',
            previousRunNumber: 2,
            nextRunNumber: 3,
            revision: 11,
            status: 'pending',
          },
        ],
      }),
      async ({ client }) => {
        await assert.rejects(() => client.listManagedContinuations('srs-157-90-34-105'), /invalid continuation/);
      },
      { lifecycleVersion: 1 },
    );
  });

  it('retries a managed report with the exact same sequence and observed time', async () => {
    const report: ManagedRunReport = {
      lifecycleVersion: 1,
      runNumber: 2,
      uploaderId: 'srs-157-90-34-105',
      claimId: '44444444-4444-4444-8444-444444444444',
      eventSequence: 3,
      observedAt: '2026-09-20T10:11:00.000Z',
      state: 'closed',
      reason: 'reconnect_timeout',
    };
    await withAdmin(
      (_req, res, call) => res.status(call === 1 ? 503 : 200).json({}),
      async ({ client, received }) => {
        assert.equal(await client.reportManagedRun(DRAFT.id, 2, report), STATE_REPORT_ACCEPTED);
        assert.equal(received.length, 2);
        assert.deepEqual(received[0].body, report);
        assert.deepEqual(received[1].body, report);
      },
      { lifecycleVersion: 1 },
    );
  });

  for (const conflict of ['event_conflict', 'assignment_mismatch'] as const) {
    it(`does not settle a managed VOD report on ${conflict}`, async () => {
      const report: ManagedRunReport = {
        lifecycleVersion: 1,
        runNumber: 2,
        uploaderId: 'srs-157-90-34-105',
        claimId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 4,
        observedAt: '2026-09-20T10:11:05.000Z',
        state: 'vod',
        completedRecording: { runNumber: 2, checkpointReference: 'checkpoint-a' },
      };
      await withAdmin(
        (req, res) => {
          if (req.method === 'POST') {
            res.status(409).json({ error: conflict });
          } else {
            res.status(409).json({ error: conflict });
          }
        },
        async ({ client, received }) => {
          assert.equal(await client.reportManagedRun(DRAFT.id, 2, report), STATE_REPORT_FAILED);
          assert.deepEqual(received.map((request) => request.method), ['POST', 'GET']);
        },
        { lifecycleVersion: 1 },
      );
    });
  }

  it('settles a conflict only when the run read proves the exact event', async () => {
    const report = digestFixture.report;
    await withAdmin(
      (req, res) => {
        if (req.method === 'POST') {
          res.status(409).json({ error: 'event_conflict' });
          return;
        }
        res.json({
          lifecycleVersion: 1,
          streamId: DRAFT.id,
          runNumber: 2,
          revision: 10,
          uploaderId: report.uploaderId,
          claimId: report.claimId,
          expectedRenditions: [],
          state: 'waiting',
          permission: 'claimed',
          lastAcceptedEvent: {
            sequence: report.eventSequence,
            digest: digestFixture.sha256HexParts.join(''),
          },
        });
      },
      async ({ client }) => {
        assert.equal(await client.reportManagedRun(DRAFT.id, 2, report), STATE_REPORT_ALREADY_SETTLED);
      },
      { lifecycleVersion: 1 },
    );
  });

  it('reconciles a VOD report when admin returns the same rendition set in name order', async () => {
    const { report, reconciledCompletedRecording, sha256HexParts } = vodReconciliationFixture;
    await withAdmin(
      (req, res) => {
        if (req.method === 'POST') {
          res.status(409).json({ error: 'event_conflict' });
          return;
        }
        res.json({
          lifecycleVersion: 1,
          streamId: DRAFT.id,
          runNumber: 2,
          revision: 10,
          uploaderId: report.uploaderId,
          claimId: report.claimId,
          expectedRenditions: [],
          state: 'vod',
          permission: 'closed',
          lastAcceptedEvent: {
            sequence: report.eventSequence,
            digest: sha256HexParts.join(''),
          },
          completedRecording: reconciledCompletedRecording,
        });
      },
      async ({ client }) => {
        assert.equal(await client.reportManagedRun(DRAFT.id, 2, report), STATE_REPORT_ALREADY_SETTLED);
      },
      { lifecycleVersion: 1 },
    );
  });
});

describe('the admin API client, reporting where a broadcast got to', () => {
  it('posts the contract path and body for a live report', async () => {
    await withAdmin(always(200), async ({ client, received }) => {
      assert.equal(await client.reportState(ADMIN_STREAM_ID, { state: ADMIN_STATE_LIVE }), STATE_REPORT_ACCEPTED);

      assert.equal(received.length, 1);
      assert.equal(received[0].method, 'POST');
      assert.equal(received[0].url, `/api/internal/streams/${ADMIN_STREAM_ID}/state`);
      assert.equal(received[0].authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(received[0].body, { state: 'live' });
    });
  });

  it('carries the feed index and the duration on a vod report', async () => {
    await withAdmin(always(200), async ({ client, received }) => {
      const report = { state: ADMIN_STATE_VOD, index: 42, duration: 137.5 } as const;
      assert.equal(await client.reportState(ADMIN_STREAM_ID, report), STATE_REPORT_ACCEPTED);
      assert.deepEqual(received[0].body, { state: 'vod', index: 42, duration: 137.5 });
    });
  });

  /**
   * ⛔ 409 is neither a success nor a failure, and it must not be retried. The admin answers it for a
   * transition it cannot make from the state it holds, and the ordinary way to reach that is a report
   * this uploader already delivered before a crash. Retried, a finalize resumed after a crash would
   * spend the whole ladder discovering what the first answer said.
   */
  it('treats a 409 as settled and asks exactly once', async () => {
    await withAdmin(always(409, { error: 'invalid_state_transition' }), async ({ client, received, sleeps }) => {
      const outcome = await client.reportState(ADMIN_STREAM_ID, { state: ADMIN_STATE_LIVE });

      assert.equal(outcome, STATE_REPORT_ALREADY_SETTLED);
      assert.equal(stateWasReported(outcome), true, 'a state the admin already holds is a state that was reported');
      assert.equal(received.length, 1, 'a 409 does not become true by being asked again');
      assert.deepEqual(sleeps, []);
    });
  });

  it('retries a 502 and reports the state once the admin comes back', async () => {
    await withAdmin(
      (_req, res, call) => (call === 1 ? res.status(502).json({ error: 'publish_failed' }) : res.status(200).json({})),
      async ({ client, received, sleeps }) => {
        assert.equal(await client.reportState(ADMIN_STREAM_ID, { state: ADMIN_STATE_LIVE }), STATE_REPORT_ACCEPTED);
        assert.equal(received.length, 2);
        assert.deepEqual(sleeps, [STATE_REPORT_BACKOFF_MS[0]]);
      },
    );
  });

  /**
   * The ladder is bounded and the bound is the point: a report is made from a finalize, and a
   * finalize that waits for ever is a broadcast that never becomes a recording. The waits are read
   * off the injected sleep rather than timed, so the policy is asserted and the suite does not spend
   * four seconds proving it.
   */
  it('gives up after the bounded number of attempts, without throwing', async () => {
    await withAdmin(always(500), async ({ client, received, sleeps }) => {
      const outcome = await client.reportState(ADMIN_STREAM_ID, {
        state: ADMIN_STATE_VOD,
        index: 3,
        duration: 10,
      });

      assert.equal(outcome, STATE_REPORT_FAILED);
      assert.equal(stateWasReported(outcome), false);
      assert.equal(received.length, MAX_STATE_REPORT_ATTEMPTS);
      assert.deepEqual(
        sleeps,
        [...STATE_REPORT_BACKOFF_MS],
        'one wait between each pair of attempts, and none after the last',
      );
    });
  });

  it('does not retry a 4xx that is not 409, because a refused token does not heal', async () => {
    await withAdmin(always(401, { error: 'unauthorized' }), async ({ client, received, sleeps }) => {
      assert.equal(await client.reportState(ADMIN_STREAM_ID, { state: ADMIN_STATE_LIVE }), STATE_REPORT_FAILED);
      assert.equal(received.length, 1);
      assert.deepEqual(sleeps, []);
    });
  });

  /**
   * A timeout is the case the ladder exists for: the admin was not reachable at all. It must be
   * retried and it must not escape as an exception, because the caller is a live manifest publish or
   * a finalize and neither is improved by one travelling up through it.
   */
  it('retries an admin that never answers, and still answers with a value', async () => {
    await withAdmin(
      () => {
        /* deliberately never replies */
      },
      async ({ client, received, sleeps }) => {
        assert.equal(await client.reportState(ADMIN_STREAM_ID, { state: ADMIN_STATE_LIVE }), STATE_REPORT_FAILED);
        assert.equal(received.length, MAX_STATE_REPORT_ATTEMPTS);
        assert.deepEqual(sleeps, [...STATE_REPORT_BACKOFF_MS]);
      },
      { reportTimeoutMs: 100 },
    );
  });
});

/**
 * The rendition report, which is what carries an ABR ladder in admin mode.
 *
 * ⛔ Its failure policy is `reportState`'s and not `lookupByIngestId`'s: never throws, retries what is
 * worth retrying, and answers `null` for a failure the caller acts on. What is NOT shared is the
 * reading of a 409 — the state route answers one for a transition it already holds, which is settled,
 * and this route answers one for a stream that is still a draft or has a write in flight, which is
 * "not yet". The caller re-attempts the whole report on its own announce cadence either way.
 *
 * ⛔ And the body is screened rather than cast, because what is built out of it is the master playlist
 * every viewer of the broadcast resolves.
 */
describe('the admin API client, reporting one rung of a ladder', () => {
  const RUNG: Rendition = {
    name: '720p',
    width: 1280,
    height: 720,
    topic: 'rung-topic-0001',
    bandwidth: 2_800_000,
    avgBandwidth: 2_400_000,
  };

  /** The merged ladder as the contract states it, so `asRenditionReport` accepts it. */
  const MERGED = {
    stream: { id: ADMIN_STREAM_ID },
    renditions: [RUNG],
    ladder: { finished: false, flippedToFinished: false, duration: null },
    feed: { owner: '0xowner', topic: 'declared-topic-0001', topicHex: '00', index: 7, entryCount: 1 },
  };

  it('posts the contract path and the rung as its body, and reads the merged ladder back', async () => {
    await withAdmin(always(200, MERGED), async ({ client, received }) => {
      const report = await client.reportRendition(ADMIN_STREAM_ID, RUNG);

      assert.equal(received.length, 1);
      assert.equal(received[0].method, 'POST');
      assert.equal(received[0].url, `/api/internal/streams/${ADMIN_STREAM_ID}/renditions`);
      assert.equal(received[0].authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(received[0].body, RUNG);
      assert.deepEqual(report?.renditions, [RUNG]);
      assert.deepEqual(report?.ladder, { finished: false, flippedToFinished: false, duration: null });
    });
  });

  it('reads the flip and the duration back off a ladder that finished', async () => {
    const finished = {
      ...MERGED,
      renditions: [{ ...RUNG, index: 9, duration: 12 }],
      ladder: { finished: true, flippedToFinished: true, duration: 12 },
    };

    await withAdmin(always(200, finished), async ({ client }) => {
      const report = await client.reportRendition(ADMIN_STREAM_ID, { ...RUNG, index: 9, duration: 12 });

      assert.deepEqual(report?.ladder, { finished: true, flippedToFinished: true, duration: 12 });
      assert.equal(report?.renditions[0].index, 9);
    });
  });

  /**
   * ⛔ The one number that orders answers the way the admin merged them. Four rungs report concurrently
   * and their answers can arrive in another order; without this the registry would write whichever merge
   * landed last, and an older one landing last takes a rung off the master. See `AdminLadderRegistry.adopt`.
   */
  it('reads the catalog write index off the reply, and answers null for a body that carries none', async () => {
    await withAdmin(always(200, MERGED), async ({ client }) => {
      assert.equal((await client.reportRendition(ADMIN_STREAM_ID, RUNG))?.feedIndex, 7);
    });
    await withAdmin(always(200, { ...MERGED, feed: undefined }), async ({ client }) => {
      assert.equal((await client.reportRendition(ADMIN_STREAM_ID, RUNG))?.feedIndex, null);
    });
  });

  it('reads the stream′s status off the reply, and answers null for a body that carries none', async () => {
    await withAdmin(always(200, { ...MERGED, stream: { id: ADMIN_STREAM_ID, status: 'live' } }), async ({ client }) => {
      assert.equal((await client.reportRendition(ADMIN_STREAM_ID, RUNG))?.streamStatus, 'live');
    });
    await withAdmin(always(200, MERGED), async ({ client }) => {
      assert.equal((await client.reportRendition(ADMIN_STREAM_ID, RUNG))?.streamStatus, null);
    });
  });

  it('retries a 502 and merges the rung once the admin comes back', async () => {
    await withAdmin(
      (_req, res, call) =>
        call === 1 ? res.status(502).json({ error: 'publish_failed' }) : res.status(200).json(MERGED),
      async ({ client, received, sleeps }) => {
        assert.notEqual(await client.reportRendition(ADMIN_STREAM_ID, RUNG), null);
        assert.equal(received.length, 2, 'the merge is idempotent, so repeating the whole report is safe');
        assert.deepEqual(sleeps, [STATE_REPORT_BACKOFF_MS[0]]);
      },
    );
  });

  it('gives up after the ladder and answers null rather than throwing', async () => {
    await withAdmin(always(503), async ({ client, received, sleeps }) => {
      assert.equal(await client.reportRendition(ADMIN_STREAM_ID, RUNG), null);
      assert.equal(received.length, MAX_STATE_REPORT_ATTEMPTS);
      assert.deepEqual(sleeps, [...STATE_REPORT_BACKOFF_MS]);
    });
  });

  /**
   * ⛔ Not settled, and not retried inside the ladder either. The admin answers 409 for a stream that
   * is still a draft or whose catalog write is in flight; four seconds of asking again buys nothing for
   * the first, and the caller's own thirty second cadence covers the second.
   */
  it('answers null for a 409 without spending the ladder on it', async () => {
    await withAdmin(always(409, { error: 'invalid_state' }), async ({ client, received, sleeps }) => {
      assert.equal(await client.reportRendition(ADMIN_STREAM_ID, RUNG), null);
      assert.equal(received.length, 1);
      assert.deepEqual(sleeps, []);
    });
  });

  /**
   * ⛔ A 200 whose body is not a ladder is a failure, never an empty ladder. The renditions here become
   * `EXT-X-STREAM-INF` lines and a rung feed address: a missing `topic` would address a feed at
   * `Topic.fromString(undefined)` and a missing `bandwidth` would write `BANDWIDTH=undefined` into a
   * tag hls.js parses, and both are broadcasts that publish and cannot be played.
   */
  for (const [name, body] of [
    ['a rendition missing its topic', { ...MERGED, renditions: [{ ...RUNG, topic: undefined }] }],
    ['a rendition whose bandwidth is not a number', { ...MERGED, renditions: [{ ...RUNG, bandwidth: 'fast' }] }],
    ['a rendition carrying an index with no duration', { ...MERGED, renditions: [{ ...RUNG, index: 9 }] }],
    ['no ladder state at all', { ...MERGED, ladder: undefined }],
    ['renditions that are not a list', { ...MERGED, renditions: { '720p': RUNG } }],
    ['a body that is not an object', 'a merged ladder'],
  ] as const) {
    it(`answers null for ${name}`, async () => {
      await withAdmin(always(200, body), async ({ client }) => {
        assert.equal(await client.reportRendition(ADMIN_STREAM_ID, RUNG), null);
      });
    });
  }
});

/**
 * The boot-time half of the owner check. Both services have to sign as one address or the admin's
 * catalog entries point viewers at feeds nobody writes, and nothing on the wire says so: every report
 * answers 200. So boot reads the admin's public config and compares. Never throws, because an admin
 * that is not up yet is a deploy ordering and the publish gate compares each declaration's owner anyway.
 */
describe('the admin API client, reading the feed owner', () => {
  const CONFIG = { feed: { owner: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', topic: 't', topicHex: '00' } };

  it('reads the owner off the public config', async () => {
    await withAdmin(always(200, CONFIG), async ({ client, received }) => {
      assert.equal(await client.fetchFeedOwner(), CONFIG.feed.owner);
      assert.equal(received[0].method, 'GET');
      assert.equal(received[0].url, '/api/config');
    });
  });

  for (const [name, handle] of [
    ['the admin answers 5xx', always(503)],
    ['the body carries no feed owner', always(200, { feed: { topic: 't' } })],
    ['the body is not an object', always(200, 'nope')],
  ] as const) {
    it(`answers null, and does not throw, when ${name}`, async () => {
      await withAdmin(handle, async ({ client }) => {
        assert.equal(await client.fetchFeedOwner(), null);
      });
    });
  }

  it('answers null when the admin cannot be reached at all', async () => {
    const client = new AdminApiClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, lookupTimeoutMs: 200 });
    assert.equal(await client.fetchFeedOwner(), null);
  });
});

describe('the admin API token', () => {
  /**
   * Refused where the client is built rather than where it is used, so a deployment configured with
   * a guessable token cannot come up and start resolving publishes against it. Same floor as
   * `API_AUTH_TOKEN` and the SRS webhook token, deliberately.
   */
  it('refuses a client built on a token shorter than the floor', () => {
    assert.throws(
      () => new AdminApiClient({ baseUrl: 'http://admin.test', token: 'a'.repeat(MIN_ADMIN_API_TOKEN_LENGTH - 1) }),
      /ADMIN_API_TOKEN/,
    );
  });

  it('accepts one exactly at the floor', () => {
    assert.doesNotThrow(
      () => new AdminApiClient({ baseUrl: 'http://admin.test', token: 'a'.repeat(MIN_ADMIN_API_TOKEN_LENGTH) }),
    );
  });
});
