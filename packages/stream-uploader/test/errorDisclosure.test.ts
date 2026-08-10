import { Router } from 'express';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createOmeEngine } from '../src/engines/ome.js';
import { EnginePlugin } from '../src/engines/types.js';
import { ErrorHandler } from '../src/libs/ErrorHandler.js';
import { Logger } from '../src/libs/Logger.js';
import { LOG_LEVEL_ERROR } from '../src/libs/logLevels.js';
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import {
  MEDIA_TYPE_VIDEO,
  STOP_FAILURE_FINALIZE_FAILED,
  STREAM_LIFECYCLE_FAILED,
  STREAM_STATUS_VOD,
} from '../src/types.js';

import { ApiTestServer, NO_AUTH_HEADER, startTestApi } from './helpers/apiTestServer.js';
import { makeFakeCatalog, makeTestOrchestrator } from './helpers/fakes.js';

const STREAM_ID = 'live/one';
const SETTLE_CEILING_MS = 4_000;

/**
 * A Bee failure that reads like a real one. Every part of it is something that must not reach a
 * caller: where the node lives, where this process keeps its data, and which internal call failed.
 */
const INTERNAL_URL = 'http://bee-node.internal:1633';
const INTERNAL_PATH = '/srv/swarm/uploader/state/live_one.json';
const LEAKY_MESSAGE = `POST ${INTERNAL_URL}/bzz failed: ENOENT ${INTERNAL_PATH} (batch 4f8a stamp exhausted)`;

const DISCLOSURES = [
  ['a node URL', INTERNAL_URL],
  ['a host and port', 'bee-node.internal:1633'],
  ['a filesystem path', INTERNAL_PATH],
  ['an internal batch id', '4f8a'],
] as const;

/** The whole of what a caller is told for a failure this service owns. Written out, not imported. */
const GENERIC_500 = { ok: false, error: 'Internal server error', statusCode: 500 };

/**
 * A failure shape, and the whole of what a caller may see for it.
 *
 * `clientErrorStatus` reads `expose`, `status` and `statusCode` off whatever error reaches it, and
 * `http-errors` sets all three consistently, so the body parsers that reach it in production only
 * ever exercise one point of that space. Every shape the guard exists to refuse is outside it, which
 * is why the guard could be deleted a line at a time with the suite still green.
 */
const DECLARED_STATUS_CASES = [
  { what: 'an error declaring no status at all', props: {}, status: 500, body: GENERIC_500 },
  { what: 'a 4xx that was never marked exposable', props: { status: 404 }, status: 500, body: GENERIC_500 },
  {
    what: 'an exposable status carried only on statusCode',
    props: { expose: true, statusCode: 413 },
    status: 413,
    body: { ok: false, error: 'Request body too large', statusCode: 413 },
  },
  {
    what: 'an exposable status carried only on status',
    props: { expose: true, status: 400 },
    status: 400,
    body: { ok: false, error: 'Malformed request body', statusCode: 400 },
  },
  { what: 'an exposable 5xx', props: { expose: true, status: 500 }, status: 500, body: GENERIC_500 },
  { what: 'an exposable 3xx', props: { expose: true, status: 302 }, status: 500, body: GENERIC_500 },
  {
    what: 'an exposable status that is not a number',
    props: { expose: true, statusCode: '404' },
    status: 500,
    body: GENERIC_500,
  },
  {
    what: 'an exposable 4xx this service has no wording for',
    props: { expose: true, status: 429 },
    status: 429,
    body: { ok: false, error: 'Bad request', statusCode: 429 },
  },
  // 4xx-shaped and still not a status. `res.status()` throws on a fraction, and a throw inside the
  // error handler is answered by express's own, which sends the stack and this deployment's absolute
  // paths to whoever provoked it. A range check alone let that through.
  {
    what: 'an exposable status that is not a whole number',
    props: { expose: true, status: 400.5 },
    status: 500,
    body: GENERIC_500,
  },
] as const;

const THROWING_PREFIX = '/engines/throwing';

/**
 * An engine router that throws a chosen error, so the handler can be driven with a failure no body
 * parser produces. Mounted like any other engine, so the error travels the real middleware chain.
 */
function engineThatThrows(error: unknown): EnginePlugin {
  return {
    name: 'throwing',
    prefix: THROWING_PREFIX,
    createRouter: () => {
      const router = Router();
      router.get('/', () => {
        throw error;
      });
      return router;
    },
  };
}

/** Named so the frame it leaves in `stack` is something a test can look for. */
function thrownInsideDrainUploader(): Error {
  return new Error(LEAKY_MESSAGE);
}

/**
 * A catalog whose VOD write rejects, which is the path that actually carries an error verbatim to
 * the caller.
 *
 * Found by mutation rather than by reading. The first version of this test failed the manifest
 * upload instead, and the four disclosure assertions below passed against the unfixed code: the
 * uploader wraps that failure in `Failed to upload VOD manifest for stream <id>`, which discloses
 * nothing but the caller's own stream id. `streamCatalog.addStream` at the end of `finalize` is not
 * wrapped, so whatever the Swarm feed write rejects with reaches `drainUploader` intact.
 *
 * The live announce is let through, so the stream reaches a normal running state first and the
 * failure under test is the finalize.
 */
function makeLeakyCatalog(): StreamCatalog {
  return makeFakeCatalog({
    addStream: async (entry: { state?: string }) => {
      if (entry.state === STREAM_STATUS_VOD) {
        throw new Error(LEAKY_MESSAGE);
      }
    },
  });
}

interface StatusBody {
  state?: string;
  reason?: string;
}

describe('responses do not carry internals (S1.7)', () => {
  const servers: ApiTestServer[] = [];
  after(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  async function start(...args: Parameters<typeof startTestApi>): Promise<ApiTestServer> {
    const server = await startTestApi(...args);
    servers.push(server);
    return server;
  }

  function hasActiveStreams(count: number): (body: unknown) => boolean {
    return (body) => (body as { activeStreams?: number }).activeStreams === count;
  }

  /**
   * Drives a stop whose finalize rejects, then reads the outcome back.
   *
   * `/stream/stop` answers 202 before the drain runs, so the failure is only visible through
   * `/stream/status`. That is exactly why the original acceptance criterion could not detect this:
   * it was phrased about a 404, and this is a 200.
   */
  async function failedStopReport(): Promise<StatusBody> {
    const api = await start(makeTestOrchestrator({}, {}, undefined, makeLeakyCatalog()));

    await api.request('/stream/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamId: STREAM_ID, mediatype: MEDIA_TYPE_VIDEO }),
    });
    await api.requestUntil('/health', hasActiveStreams(1), SETTLE_CEILING_MS);
    await api.request('/stream/segment', {
      method: 'POST',
      headers: {
        'content-type': 'video/mp2t',
        'x-stream-id': STREAM_ID,
        'x-segment-index': '0',
        'x-duration': '2',
      },
      body: Buffer.from('segment'),
    });
    await api.request('/stream/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamId: STREAM_ID }),
    });

    const { body } = await api.requestUntil(
      `/stream/status?streamId=${encodeURIComponent(STREAM_ID)}`,
      (parsed) => (parsed as StatusBody).state === STREAM_LIFECYCLE_FAILED,
      SETTLE_CEILING_MS,
    );

    return body as StatusBody;
  }

  for (const [name, disclosure] of DISCLOSURES) {
    it(`keeps ${name} out of the failed stop report`, async () => {
      const report = await failedStopReport();

      assert.ok(
        !JSON.stringify(report).includes(disclosure),
        `the status body carries ${disclosure}: ${JSON.stringify(report)}`,
      );
    });
  }

  // The other half of the criterion, and the one that stops the fix from being "return nothing". A
  // caller polling a stop needs to know it failed and whether anything may still happen.
  it('still reports the failure actionably', async () => {
    const report = await failedStopReport();

    assert.equal(report.state, STREAM_LIFECYCLE_FAILED);
    assert.equal(report.reason, STOP_FAILURE_FINALIZE_FAILED);
  });

  /**
   * The SEC-12 residue. PR #35 moved the gate ahead of the parsers for `/stream/*`, which left the
   * engine prefixes: OME signs its own request body, so it has no app-level gate to sit behind, and
   * a malformed body there reached `express.json` from an anonymous caller and answered 500 with an
   * ERROR log line per request. That put the 5xx rate and the error channel operators alert on under
   * the control of anyone who could reach the port.
   */
  describe('a body this service cannot read is the caller’s fault, not a 500 (SEC-12)', () => {
    async function postToUngatedEngine(body: string, headers: Record<string, string> = {}) {
      const engine = createOmeEngine('http://ome:8081', 60_000, { admissionSecret: 'secret' });
      const api = await start(makeTestOrchestrator(), [engine]);

      return api.request(`${engine.prefix}/admission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...NO_AUTH_HEADER, ...headers },
        body,
      });
    }

    // The whole body and not its `error` field alone. `ok` is what a caller branches on, and a
    // refusal that carries `ok: true` reads as a request that was taken.
    it('answers 400 for a truncated JSON body', async () => {
      const { status, body } = await postToUngatedEngine('{"request":{"status":"opening"');

      assert.equal(status, 400, 'a malformed body still answers 5xx, so an anonymous caller drives the error rate');
      assert.deepEqual(body, { ok: false, error: 'Malformed request body', statusCode: 400 });
    });

    it('answers 413 for a body over the control ceiling', async () => {
      const overCeiling = JSON.stringify({ pad: 'x'.repeat(200 * 1024) });

      const { status, body } = await postToUngatedEngine(overCeiling);

      assert.equal(status, 413, 'an oversized body answers 5xx rather than naming the ceiling it crossed');
      assert.deepEqual(body, { ok: false, error: 'Request body too large', statusCode: 413 });
    });

    // The third status the parsers raise, and the one with no wording of its own until it is asked
    // for: an encoding this service does not decompress is refused before any of the body is read.
    it('answers 415 for a body in an encoding it cannot read', async () => {
      const { status, body } = await postToUngatedEngine('{"request":{}}', { 'content-encoding': 'nope' });

      assert.equal(status, 415, 'an unreadable encoding is the sender’s fault, not this service’s');
      assert.deepEqual(body, { ok: false, error: 'Unsupported content type or encoding', statusCode: 415 });
    });

    // The parser quotes the body back in its own message, so passing its text through would hand an
    // attacker a reflection channel and, on the size error, name the exact configured limit.
    it('does not echo the parser’s own message', async () => {
      const marker = 'REFLECT-ME-9d3f';

      const { body } = await postToUngatedEngine(`{"${marker}":`);

      assert.ok(
        !JSON.stringify(body).includes(marker),
        `the response reflected the request body: ${JSON.stringify(body)}`,
      );
    });
  });

  /**
   * Which failures a caller is allowed to be told about, and in whose words.
   *
   * A status the error declared is only answered back when the error also says it is the caller's to
   * see, and only for the 4xx range this service has decided to attribute. Everything else collapses
   * to the one generic 500, because a status is disclosure too: answering an internal Bee 404 as a
   * 404 tells a caller their own request was at fault and moves the failure off the channel operators
   * alert on. See SEC-12.
   */
  describe('the status answered back comes from the error, and is bounded (SEC-12)', () => {
    async function answerFor(props: Record<string, unknown>) {
      const engine = engineThatThrows(Object.assign(new Error(LEAKY_MESSAGE), props));
      const api = await start(makeTestOrchestrator(), [engine]);

      return api.request(THROWING_PREFIX, { headers: NO_AUTH_HEADER });
    }

    for (const { what, props, status, body } of DECLARED_STATUS_CASES) {
      it(`answers ${what} with ${status} and nothing more`, async () => {
        const answer = await answerFor(props);

        assert.equal(answer.status, status, `the caller was answered ${answer.status}`);
        assert.deepEqual(answer.body, body);
      });
    }
  });

  /**
   * The other direction, and what makes withholding all of the above affordable: everything kept from
   * a caller has to reach an operator. Every failure in this service is reported through the one
   * shared `ErrorHandler`, and the suites that care about a report replace `handleError` with a spy,
   * so nothing held what it writes.
   */
  describe('the shared error handler reports internals where only an operator can read them', () => {
    function reportedLines(error: unknown, context?: string): string[] {
      const lines: string[] = [];
      const logger = Logger.getInstance();
      const previous = logger.configure({ level: LOG_LEVEL_ERROR, sink: (_level, line) => lines.push(line) });
      try {
        ErrorHandler.getInstance().handleError(error, context);
      } finally {
        logger.configure(previous);
      }
      return lines;
    }

    it('names the context it was given, and carries the stack the response withholds', () => {
      const lines = reportedLines(thrownInsideDrainUploader(), 'StreamUploader.uploadSegment');

      assert.equal(lines.length, 1, 'one failure is one line');
      const [line] = lines;
      assert.ok(line.includes('StreamUploader.uploadSegment'), `the line does not say what failed: ${line}`);
      assert.ok(line.includes(LEAKY_MESSAGE), `the line does not say why it failed: ${line}`);
      assert.ok(
        line.includes('thrownInsideDrainUploader'),
        `the line carries no stack, which is the one place it is allowed to be: ${line}`,
      );
    });

    it('says the context is unknown when it was given none, rather than leaving a gap', () => {
      const lines = reportedLines(new Error(LEAKY_MESSAGE));

      assert.equal(lines.length, 1);
      assert.ok(lines[0].includes('unknown context'), `a report from nowhere reads as one from ${lines[0]}`);
    });
  });
});
