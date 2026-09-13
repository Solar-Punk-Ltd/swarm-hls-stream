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
import { describe, it } from 'node:test';

import {
  ADMIN_STATE_LIVE,
  ADMIN_STATE_VOD,
  AdminApiClient,
  AdminStreamDraft,
  MAX_STATE_REPORT_ATTEMPTS,
  MIN_ADMIN_API_TOKEN_LENGTH,
  STATE_REPORT_ACCEPTED,
  STATE_REPORT_ALREADY_SETTLED,
  STATE_REPORT_BACKOFF_MS,
  STATE_REPORT_FAILED,
  stateWasReported,
} from '../src/libs/AdminApiClient.js';
import { MEDIA_TYPE_VIDEO } from '../src/types.js';

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

interface Received {
  method: string;
  url: string;
  authorization: string | undefined;
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
  options: { lookupTimeoutMs?: number; reportTimeoutMs?: number; baseUrlSuffix?: string } = {},
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
