import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, STREAM_STATUS_LIVE } from '../src/types.js';
import { MAX_STREAM_ID_LENGTH } from '../src/utils/streamId.js';

import { ApiTestServer, startTestApi } from './helpers/apiTestServer.js';
import { makeRecordingCatalog, makeTestOrchestrator } from './helpers/fakes.js';

const VALID_STREAM_ID = 'live/one';
/** A second stream that is genuinely accepted, for tests that need a fact to wait on. */
const CONTROL_STREAM_ID = 'live/two';
const SETTLE_CEILING_MS = 4_000;

interface CatalogEntry {
  mediatype?: string;
  state?: string;
}

describe('request validation at the API boundary (S1.5)', () => {
  const servers: ApiTestServer[] = [];
  after(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  async function start(...args: Parameters<typeof startTestApi>): Promise<ApiTestServer> {
    const server = await startTestApi(...args);
    servers.push(server);
    return server;
  }

  function startStream(api: ApiTestServer, body: unknown) {
    return api.request('/stream/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function postSegment(api: ApiTestServer, streamId: string, headers: Record<string, string> = {}) {
    return api.request('/stream/segment', {
      method: 'POST',
      headers: {
        'content-type': 'video/mp2t',
        'x-stream-id': streamId,
        'x-segment-index': '0',
        'x-duration': '2',
        ...headers,
      },
      body: Buffer.from('segment'),
    });
  }

  describe('mediatype is an enum, not a string the caller chooses', () => {
    // The acceptance criterion names this value. What makes it more than a type check is where an
    // unchecked one ends up: `mediatype` is copied onto the catalog entry that is published to the
    // Swarm feed, so the caller writes a field of a public record, and it is persisted in the
    // recovery state, so it outlives a restart of the process that accepted it.
    it('answers 400 for a mediatype outside the enum', async () => {
      const api = await start(makeTestOrchestrator());

      const { status, body } = await startStream(api, { streamId: VALID_STREAM_ID, mediatype: 'admin' });

      assert.equal(status, 400);
      assert.deepEqual(body, {
        ok: false,
        error: `mediatype must be "${MEDIA_TYPE_AUDIO}" or "${MEDIA_TYPE_VIDEO}"`,
        statusCode: 400,
      });
    });

    it('keeps a refused mediatype out of the catalog feed', async () => {
      const published: CatalogEntry[] = [];
      const api = await start(makeTestOrchestrator({}, {}, undefined, makeRecordingCatalog(published)));

      await startStream(api, { streamId: VALID_STREAM_ID, mediatype: 'admin' });
      // The segment matters as much as the start. A stream is announced to the catalog when its
      // first segment lands, not when it starts, so a version of this test that only starts the
      // stream asserts that nothing was published in a situation where nothing would be published
      // either way. It measured no difference at all against a schema with the enum removed.
      const refusedSegment = await postSegment(api, VALID_STREAM_ID);

      assert.equal(
        refusedSegment.status,
        404,
        'the refused start registered the stream anyway, so its media is on its way to the feed',
      );

      // A stream that is accepted, so the wait below ends on a fact rather than on a timeout, and so
      // the recording catalog is shown to be recording. Sequenced after the refused stream's own
      // segment: an entry for that one, if the enum let it through, is therefore already published
      // by the time this one appears.
      await startStream(api, { streamId: CONTROL_STREAM_ID, mediatype: MEDIA_TYPE_VIDEO });
      await postSegment(api, CONTROL_STREAM_ID);
      await api.requestUntil(
        '/health',
        () => published.some((entry) => entry.state === STREAM_STATUS_LIVE),
        SETTLE_CEILING_MS,
      );

      assert.deepEqual(
        published.filter((entry) => entry.mediatype === 'admin'),
        [],
        `a mediatype the enum refuses reached the published catalog: ${JSON.stringify(published)}`,
      );
    });

    for (const [name, value] of [
      ['a near miss on the enum', 'Video'],
      ['an array', ['video']],
      ['an object', { toString: 'video' }],
      ['null', null],
    ] as const) {
      it(`answers 400 for ${name}`, async () => {
        const api = await start(makeTestOrchestrator());

        const { status } = await startStream(api, { streamId: VALID_STREAM_ID, mediatype: value });

        assert.equal(status, 400, `mediatype ${JSON.stringify(value)} was accepted`);
      });
    }
  });

  describe('streamId is charset-restricted', () => {
    const REFUSED: [string, string][] = [
      ['a bare traversal', '../etc/passwd'],
      ['a traversal in a later part', 'live/../../etc/passwd'],
      ['a backslash traversal', '..\\windows'],
      ['an absolute path', '/etc/passwd'],
      ['a trailing slash, a second spelling of one id', 'live/one/'],
      ['a doubled slash, a second spelling of one id', 'live//one'],
      ['a space', 'live/one two'],
      ['a newline, which would forge a log line', 'live/one\nfake'],
      ['a null byte', 'live/one\u0000fake'],
      ['a percent escape', 'live/%2e%2e'],
      ['a part that starts with a dot', 'live/.hidden'],
      ['the empty string', ''],
      ['longer than the cap', `live/${'a'.repeat(MAX_STREAM_ID_LENGTH)}`],
    ];

    for (const [name, streamId] of REFUSED) {
      it(`answers 400 for ${name}`, async () => {
        const api = await start(makeTestOrchestrator());

        const { status } = await startStream(api, { streamId, mediatype: MEDIA_TYPE_VIDEO });

        assert.equal(status, 400, `streamId ${JSON.stringify(streamId)} was accepted`);
      });
    }

    // The other half of the criterion. A charset that refuses what the engines themselves build
    // would take the service down on the next real broadcast rather than harden it.
    for (const streamId of ['live/one', 'video/demo', 'a', 'app/sub/stream', 'live/cam-1_v2.0']) {
      it(`accepts ${JSON.stringify(streamId)}, which is a shape the engines produce`, async () => {
        const api = await start(makeTestOrchestrator());

        const { status } = await startStream(api, { streamId, mediatype: MEDIA_TYPE_VIDEO });

        assert.equal(status, 200, `a stream id the engines build was refused: ${streamId}`);
      });
    }

    it('refuses the same charset on the ingest header, not only on the control body', async () => {
      const api = await start(makeTestOrchestrator());

      const { status } = await api.request('/stream/segment', {
        method: 'POST',
        headers: {
          'content-type': 'video/mp2t',
          'x-stream-id': '../../etc/passwd',
          'x-segment-index': '0',
          'x-duration': '2',
        },
        body: Buffer.from('segment'),
      });

      assert.equal(status, 400, 'the ingest route takes its stream id from a header and validated nothing');
    });

    it('refuses it on the status query too, where a caller reaches an id it never started', async () => {
      const api = await start(makeTestOrchestrator());

      const { status } = await api.request(`/stream/status?streamId=${encodeURIComponent('../../etc/passwd')}`);

      assert.equal(status, 400);
    });
  });

  describe('numeric ingest headers', () => {
    // `parseInt` and `parseFloat` stop at the first character they cannot use, so each of these was
    // previously read as a number the caller did not send rather than refused.
    for (const [header, value] of [
      ['x-segment-index', '5 GB'],
      ['x-segment-index', '1.5'],
      ['x-segment-index', '-1'],
      ['x-segment-index', ''],
      ['x-duration', '2 seconds'],
      ['x-duration', ''],
    ] as const) {
      it(`answers 400 for ${header}: ${JSON.stringify(value)}`, async () => {
        const api = await start(makeTestOrchestrator());
        await startStream(api, { streamId: VALID_STREAM_ID, mediatype: MEDIA_TYPE_VIDEO });

        const { status } = await postSegment(api, VALID_STREAM_ID, { [header]: value });

        assert.equal(status, 400, `${header}: ${JSON.stringify(value)} was accepted`);
      });
    }
  });
});
