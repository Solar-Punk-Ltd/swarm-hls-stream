import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createOmeEngine } from '../src/engines/ome.js';
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

    it('answers 400 for a truncated JSON body', async () => {
      const { status, body } = await postToUngatedEngine('{"request":{"status":"opening"');

      assert.equal(status, 400, 'a malformed body still answers 5xx, so an anonymous caller drives the error rate');
      assert.equal((body as { error?: string }).error, 'Malformed request body');
    });

    it('answers 413 for a body over the control ceiling', async () => {
      const overCeiling = JSON.stringify({ pad: 'x'.repeat(200 * 1024) });

      const { status, body } = await postToUngatedEngine(overCeiling);

      assert.equal(status, 413, 'an oversized body answers 5xx rather than naming the ceiling it crossed');
      assert.equal((body as { error?: string }).error, 'Request body too large');
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
});
