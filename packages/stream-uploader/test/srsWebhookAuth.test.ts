import express from 'express';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { createSrsEngine } from '../src/engines/srs.js';
import {
  MIN_SRS_WEBHOOK_TOKEN_LENGTH,
  redactWebhookToken,
  SRS_WEBHOOK_TOKEN_PARAM,
} from '../src/engines/srs/webhookToken.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';

const TOKEN = 'srs-webhook-token-0123456789abcdef';

interface Attempt {
  status: number;
  startedStreams: string[];
}

async function postStreams(query: string): Promise<Attempt> {
  const startedStreams: string[] = [];
  const orchestrator = {
    startStream: (streamId: string) => {
      startedStreams.push(streamId);
      return true;
    },
    stopStream: async () => {},
    handleSegment: () => ({ accepted: true }),
    handleSegmentLoss: () => true,
  } as unknown as StreamOrchestrator;

  const engine = createSrsEngine('/tmp/media-unused', { webhookToken: TOKEN });
  const app = express();
  app.use(express.json());
  app.use(engine.prefix, engine.createRouter(orchestrator));

  const server = app.listen(0);
  try {
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${engine.prefix}/streams${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'on_publish', app: 'live', stream: 'demo' }),
    });
    return { status: response.status, startedStreams };
  } finally {
    server.close();
  }
}

describe('SRS webhook auth (S1.2)', () => {
  after(() => {});

  it('rejects an unauthenticated webhook and never reaches the orchestrator', async () => {
    // The acceptance criterion, and the reason it matters: this route reaches the same
    // stamp-spending path /stream/segment reaches, so an open webhook is the same funds drain.
    const { status, startedStreams } = await postStreams('');

    assert.equal(status, 401);
    assert.deepEqual(startedStreams, [], 'the orchestrator must not be reached by an unauthenticated caller');
  });

  it('accepts a correctly tokenised webhook', async () => {
    const { status, startedStreams } = await postStreams(`?${SRS_WEBHOOK_TOKEN_PARAM}=${TOKEN}`);

    assert.equal(status, 200);
    assert.deepEqual(startedStreams, ['live/demo']);
  });

  const BAD_QUERIES = [
    { name: 'a wrong token of the same length', query: `?${SRS_WEBHOOK_TOKEN_PARAM}=${'x'.repeat(TOKEN.length)}` },
    { name: 'a prefix of the real token', query: `?${SRS_WEBHOOK_TOKEN_PARAM}=${TOKEN.slice(0, -1)}` },
    { name: 'an empty token parameter', query: `?${SRS_WEBHOOK_TOKEN_PARAM}=` },
    { name: 'the token under a different parameter name', query: `?secret=${TOKEN}` },
    { name: 'a repeated token parameter, which express parses as an array', query: `?token=${TOKEN}&token=${TOKEN}` },
    {
      // U+0173 keeps 0x73 as its low byte, so a latin1 comparison would read this as the real
      // token. A query parameter is percent-decoded as UTF-8, so latin1 is the wrong encoding here.
      name: 'a token whose code points alias onto the real bytes under latin1',
      query: `?${SRS_WEBHOOK_TOKEN_PARAM}=${encodeURIComponent(`ų${TOKEN.slice(1)}`)}`,
    },
  ];

  for (const bad of BAD_QUERIES) {
    it(`rejects ${bad.name}`, async () => {
      const { status, startedStreams } = await postStreams(bad.query);

      assert.equal(status, 401);
      assert.deepEqual(startedStreams, []);
    });
  }

  it('refuses to build an engine with a token that cannot survive a URL', () => {
    assert.throws(() => createSrsEngine('/tmp/media-unused', { webhookToken: 'a token with spaces and padding!!' }), {
      message: /unreserved URL characters/,
    });
  });

  it('refuses to build an engine with a token short enough to guess', () => {
    assert.throws(
      () => createSrsEngine('/tmp/media-unused', { webhookToken: 'a'.repeat(MIN_SRS_WEBHOOK_TOKEN_LENGTH - 1) }),
      { message: /at least/ },
    );
  });

  it('sets the floor at the documented length', () => {
    assert.equal(MIN_SRS_WEBHOOK_TOKEN_LENGTH, 32);
  });
});

describe('SRS webhook token redaction', () => {
  // The secret is in the URL because SRS offers no other channel, so every place a URL is written
  // down is a place it leaks. The request log is the one that outlives the request.
  const CASES: { name: string; url: string; expected: string }[] = [
    {
      name: 'the only parameter',
      url: `/engines/srs/hls?token=${TOKEN}`,
      expected: '/engines/srs/hls?token=REDACTED',
    },
    {
      name: 'the first of several',
      url: `/engines/srs/hls?token=${TOKEN}&app=live`,
      expected: '/engines/srs/hls?token=REDACTED&app=live',
    },
    {
      name: 'a later parameter',
      url: `/engines/srs/hls?app=live&token=${TOKEN}`,
      expected: '/engines/srs/hls?app=live&token=REDACTED',
    },
    {
      name: 'an uppercase parameter name',
      url: `/engines/srs/hls?TOKEN=${TOKEN}`,
      expected: '/engines/srs/hls?TOKEN=REDACTED',
    },
  ];

  for (const testCase of CASES) {
    it(`redacts the token as ${testCase.name}`, () => {
      const redacted = redactWebhookToken(testCase.url);

      assert.equal(redacted, testCase.expected);
      assert.ok(!redacted.includes(TOKEN), 'the secret must not survive anywhere in the line');
    });
  }

  it('leaves a url with no token untouched', () => {
    assert.equal(redactWebhookToken('/stream/start'), '/stream/start');
  });
});
