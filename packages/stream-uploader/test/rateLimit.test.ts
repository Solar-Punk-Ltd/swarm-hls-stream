import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createRateLimiter } from '../src/api/middleware/rateLimit.js';
import { MAX_SEGMENT_BODY, RequestLimits } from '../src/api/requestLimits.js';
import { MEDIA_TYPE_VIDEO } from '../src/types.js';

import { ApiTestServer, NO_AUTH_HEADER, startTestApi } from './helpers/apiTestServer.js';
import { makeTestOrchestrator, neverSettles } from './helpers/fakes.js';

const STREAM_ID = 'live/one';
const OTHER_STREAM_ID = 'live/two';
const SETTLE_CEILING_MS = 4_000;

/** Wide enough that no test here can roll over mid-run. Rollover is driven by the unit tests below. */
const NO_ROLLOVER_MS = 600_000;

const QUEUE_FULL_MESSAGE = 'Queue full';
const PER_STREAM_MESSAGE = 'Too many segments for this stream';
const GLOBAL_MESSAGE = 'Too many requests';

interface ErrorBody {
  error?: string;
  statusCode?: number;
}

describe('rate limits (S1.6)', () => {
  const servers: ApiTestServer[] = [];
  after(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  async function start(...args: Parameters<typeof startTestApi>): Promise<ApiTestServer> {
    const server = await startTestApi(...args);
    servers.push(server);
    return server;
  }

  function limits(overrides: Partial<RequestLimits> = {}): RequestLimits {
    return { windowMs: NO_ROLLOVER_MS, globalMax: 10_000, perStreamMax: 10_000, ...overrides };
  }

  function startStream(api: ApiTestServer, streamId = STREAM_ID) {
    return api.request('/stream/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamId, mediatype: MEDIA_TYPE_VIDEO }),
    });
  }

  function postSegment(api: ApiTestServer, index: number, streamId = STREAM_ID, body = 'segment') {
    return api.request('/stream/segment', {
      method: 'POST',
      headers: {
        'content-type': 'video/mp2t',
        'x-stream-id': streamId,
        'x-segment-index': String(index),
        'x-duration': '2',
      },
      body: Buffer.from(body),
    });
  }

  function hasActiveStreams(count: number): (body: unknown) => boolean {
    return (body) => (body as { activeStreams?: number }).activeStreams === count;
  }

  /**
   * The acceptance criterion, as amended on 2026-08-01.
   *
   * The original read "exceeding the per-stream rate returns 429 with Retry-After", which HEAD
   * already satisfied with no limiter at all: `/stream/segment` answers exactly that from queue
   * backpressure. So the criterion is written around the case that separates the two. The queue
   * ceiling here is 100 against a rate of 3, and the uploads resolve, so every segment below would
   * be accepted on the old code and the refusal can only be the rate.
   */
  it('refuses a caller that exceeds the configured rate while its queue is nearly empty', async () => {
    const PER_STREAM_MAX = 3;
    const api = await start(makeTestOrchestrator({ maxQueueSize: 100 }), [], limits({ perStreamMax: PER_STREAM_MAX }));

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1), SETTLE_CEILING_MS);

    const accepted = [];
    for (let index = 0; index < PER_STREAM_MAX; index++) {
      accepted.push(await postSegment(api, index));
    }
    const refused = await postSegment(api, PER_STREAM_MAX);

    assert.deepEqual(
      accepted.map((response) => response.status),
      [200, 200, 200],
      'the segments under the rate were not all accepted, so the refusal below is not the rate',
    );
    assert.equal(refused.status, 429);
    assert.equal((refused.body as ErrorBody).error, PER_STREAM_MESSAGE);
  });

  it('sends Retry-After with the refusal', async () => {
    const api = await start(makeTestOrchestrator(), [], limits({ perStreamMax: 1 }));

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1), SETTLE_CEILING_MS);
    await postSegment(api, 0);
    const { status, headers } = await postSegment(api, 1);

    assert.equal(status, 429);
    assert.ok(Number(headers?.['retry-after']) > 0, `Retry-After was ${String(headers?.['retry-after'])}`);
  });

  /**
   * What "distinguishable" has to mean to be worth anything. Both faults answer 429 on the same
   * route, and an operator reading only the status cannot tell a broadcaster sending too fast from
   * a Bee that has stopped draining the queue. The remedies are opposite: slow the sender, or look
   * at storage. So the two bodies are asserted against each other in one test rather than each
   * being asserted alone, which would pass with both wordings identical.
   */
  it('says something different from a full queue, which answers 429 on the same route', async () => {
    const rateLimited = await start(makeTestOrchestrator({ maxQueueSize: 100 }), [], limits({ perStreamMax: 1 }));
    await startStream(rateLimited);
    await rateLimited.requestUntil('/health', hasActiveStreams(1), SETTLE_CEILING_MS);
    await postSegment(rateLimited, 0);
    const tooFast = await postSegment(rateLimited, 1);

    // A Bee that accepts the connection and never answers, so the single queue slot stays occupied.
    // Posted until refused rather than a fixed count: the queue reports what is waiting and not what
    // is running, so the first segment occupies the worker and leaves the slot free behind it.
    const backedUp = await start(makeTestOrchestrator({ maxQueueSize: 1 }, { uploadData: neverSettles }), [], limits());
    await startStream(backedUp);
    await backedUp.requestUntil('/health', hasActiveStreams(1), SETTLE_CEILING_MS);
    let tooDeep = await postSegment(backedUp, 0);
    for (let index = 1; index < 6 && tooDeep.status !== 429; index++) {
      tooDeep = await postSegment(backedUp, index);
    }

    assert.equal(tooFast.status, 429);
    assert.equal(tooDeep.status, 429);
    assert.equal((tooDeep.body as ErrorBody).error, QUEUE_FULL_MESSAGE, 'the queue-full path stopped being reachable');
    assert.notEqual(
      (tooFast.body as ErrorBody).error,
      (tooDeep.body as ErrorBody).error,
      'too fast and too deep answer with the same body, so a caller cannot tell which fault it hit',
    );
  });

  it('spends one stream’s budget without touching another’s', async () => {
    const api = await start(makeTestOrchestrator(), [], limits({ perStreamMax: 1 }));

    await startStream(api, STREAM_ID);
    await startStream(api, OTHER_STREAM_ID);
    await api.requestUntil('/health', hasActiveStreams(2), SETTLE_CEILING_MS);

    await postSegment(api, 0, STREAM_ID);
    const exhausted = await postSegment(api, 1, STREAM_ID);
    const untouched = await postSegment(api, 0, OTHER_STREAM_ID);

    assert.equal(exhausted.status, 429);
    assert.equal(untouched.status, 200, 'one stream exhausting its rate refused a different stream');
  });

  /**
   * The bound on the per-stream limiter's own memory. It holds an entry per distinct stream id, and
   * S1.5 bounds the length of that value but not how many different ones a caller can invent. What
   * bounds the count is this limit being reached first, so the ordering is asserted rather than
   * assumed: it is the reason the middleware is mounted where it is.
   */
  it('refuses a flood of invented stream ids on the global limit before the per-stream map grows', async () => {
    const GLOBAL_MAX = 5;
    const api = await start(makeTestOrchestrator(), [], limits({ globalMax: GLOBAL_MAX, perStreamMax: 10_000 }));

    const statuses = [];
    for (let attempt = 0; attempt < GLOBAL_MAX + 2; attempt++) {
      statuses.push(await postSegment(api, 0, `live/invented-${attempt}`));
    }

    const refusals = statuses.filter((response) => response.status === 429);
    assert.ok(refusals.length > 0, 'a flood of distinct stream ids was never refused, so the map grows unbounded');
    assert.equal(
      (refusals[0].body as ErrorBody).error,
      GLOBAL_MESSAGE,
      'the flood was refused by the per-stream limit, which means its map had already grown to hold every key',
    );
  });

  // Mounted behind the gate, so an anonymous caller cannot spend the budget of the authenticated one
  // it is meant to protect. The reverse order is the shape that turns a rate limit into the outage.
  it('does not let unauthenticated requests spend the budget', async () => {
    const api = await start(makeTestOrchestrator(), [], limits({ globalMax: 2, perStreamMax: 2 }));

    for (let attempt = 0; attempt < 5; attempt++) {
      const { status } = await api.request('/stream/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...NO_AUTH_HEADER },
        body: JSON.stringify({ streamId: STREAM_ID, mediatype: MEDIA_TYPE_VIDEO }),
      });
      assert.equal(status, 401, 'an unauthenticated caller got past the gate');
    }

    const { status } = await startStream(api);

    assert.equal(status, 200, 'anonymous requests consumed the authenticated caller’s rate budget');
  });

  it('refuses a segment body over the ceiling', async () => {
    const api = await start(makeTestOrchestrator(), [], limits());
    const overCeiling = 'x'.repeat(Number.parseInt(MAX_SEGMENT_BODY, 10) * 1024 * 1024 + 1024);

    await startStream(api);
    await api.requestUntil('/health', hasActiveStreams(1), SETTLE_CEILING_MS);
    const { status } = await postSegment(api, 0, STREAM_ID, overCeiling);

    assert.ok(status >= 400, `a body over ${MAX_SEGMENT_BODY} was accepted with ${status}`);
  });
});

/**
 * The window itself, driven through the injected clock rather than by sleeping.
 *
 * Wall-clock versions of these were tried and are the wrong instrument: a short window that the HTTP
 * tests above could roll over is also a window their own requests can straddle under contention,
 * which is how this repository acquired the flaky tests TEST-24 and TEST-31 closed.
 */
describe('the rate limit window (S1.6)', () => {
  const WINDOW_MS = 1_000;
  const KEY = 'one';

  function drive(max: number) {
    let now = 0;
    const limiter = createRateLimiter({ windowMs: WINDOW_MS, max, keyOf: () => KEY, message: 'refused' }, () => now);

    return {
      advance: (ms: number) => {
        now += ms;
      },
      /** The status a request would get, so a test reads outcomes rather than exception plumbing. */
      attempt(): { status: number; retryAfter?: string } {
        try {
          limiter({ headers: {} } as never, {} as never, () => {});
          return { status: 200 };
        } catch (error) {
          const apiError = error as { statusCode: number; retryAfter?: string };
          return { status: apiError.statusCode, retryAfter: apiError.retryAfter };
        }
      },
    };
  }

  it('serves the caller again once the window has passed', () => {
    const limiter = drive(1);

    const first = limiter.attempt();
    const refused = limiter.attempt();
    limiter.advance(WINDOW_MS);
    const afterWindow = limiter.attempt();

    assert.equal(first.status, 200);
    assert.equal(refused.status, 429, 'the limit never bit, so the recovery below proves nothing');
    assert.equal(afterWindow.status, 200, 'the limit is a ban rather than a rate: the window never rolled');
  });

  it('does not roll the window early', () => {
    const limiter = drive(1);

    limiter.attempt();
    limiter.advance(WINDOW_MS - 1);

    assert.equal(limiter.attempt().status, 429, 'the window rolled before it elapsed, so the rate is not the one set');
  });

  // A Retry-After longer than the window tells a caller to wait for a budget that already refreshed,
  // and one of zero invites an immediate retry into the same refusal.
  it('tells the caller to wait no longer than the window and no less than a second', () => {
    const limiter = drive(1);

    limiter.attempt();
    const immediately = limiter.attempt();
    limiter.advance(WINDOW_MS - 1);
    const atTheEnd = limiter.attempt();

    assert.equal(Number(immediately.retryAfter), WINDOW_MS / 1000);
    assert.equal(Number(atTheEnd.retryAfter), 1, 'a caller refused at the end of a window is told to wait a full one');
  });
});
