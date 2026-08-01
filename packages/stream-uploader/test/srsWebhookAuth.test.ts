import express from 'express';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { createSrsEngine, createSrsEngineFromEnv, SrsEngineOptions } from '../src/engines/srs.js';
import {
  hasValidWebhookToken,
  MIN_SRS_WEBHOOK_TOKEN_LENGTH,
  redactWebhookToken,
  SRS_WEBHOOK_TOKEN_PARAM,
} from '../src/engines/srs/webhookToken.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';

import { startTestApi } from './helpers/apiTestServer.js';

const TOKEN = 'srs-webhook-token-0123456789abcdef';

interface Attempt {
  status: number;
  startedStreams: string[];
}

async function postStreams(query: string, options: SrsEngineOptions = { webhookToken: TOKEN }): Promise<Attempt> {
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

  const engine = createSrsEngine('/tmp/media-unused', options);
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

  it('gates every route on the router itself, not only through the app', async () => {
    // The router carries its own gate so mounting it alone is safe. Driving it without the
    // app-level gate is the only thing that proves the mount covers routes beyond /streams:
    // moving the check into the /streams handler leaves /hls open and every other test green.
    const reached: string[] = [];
    const orchestrator = {
      startStream: () => (reached.push('startStream'), true),
      stopStream: async () => {},
      handleSegment: () => (reached.push('handleSegment'), { accepted: true }),
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

      for (const route of ['/streams', '/hls']) {
        const response = await fetch(`http://127.0.0.1:${port}${engine.prefix}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'on_publish', app: 'live', stream: 'demo', file: 'x.ts', seq_no: 1 }),
        });
        assert.equal(response.status, 401, `${route} must be gated by the router itself`);
      }

      assert.deepEqual(reached, [], 'no handler may run for an unauthenticated caller');
    } finally {
      server.close();
    }
  });

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

  for (const attempt of [
    { name: 'no token at all', query: '' },
    // Two empty strings encode to two zero-length buffers, which timingSafeEqual calls equal. The
    // empty-token guard is the only thing between an unconfigured engine and an open webhook.
    { name: 'an empty token, matching the empty configured one', query: `?${SRS_WEBHOOK_TOKEN_PARAM}=` },
  ]) {
    it(`rejects ${attempt.name} when the engine was built without a token`, async () => {
      const { status, startedStreams } = await postStreams(attempt.query, { webhookToken: '' });

      assert.equal(status, 401);
      assert.deepEqual(startedStreams, [], 'an unconfigured engine must reject rather than open up');
    });
  }

  describe('createSrsEngineFromEnv', () => {
    // The factory that reads the environment had no tests at all: mutation showed that swapping
    // required() for an optional default, or dropping the token on the way to createSrsEngine
    // entirely, both left the suite green. That is the helper-is-right, wiring-is-broken shape.
    const original = process.env.SRS_WEBHOOK_TOKEN;

    after(() => {
      if (original === undefined) {
        delete process.env.SRS_WEBHOOK_TOKEN;
      } else {
        process.env.SRS_WEBHOOK_TOKEN = original;
      }
    });

    it('refuses to build without SRS_WEBHOOK_TOKEN in the environment', () => {
      delete process.env.SRS_WEBHOOK_TOKEN;

      assert.throws(() => createSrsEngineFromEnv(), /SRS_WEBHOOK_TOKEN/);
    });

    it('refuses to build when the environment supplies an unusable token', () => {
      process.env.SRS_WEBHOOK_TOKEN = 'too-short';

      assert.throws(() => createSrsEngineFromEnv(), /at least/);
    });

    it('says nothing about a loaded engine when the token is unusable', () => {
      // The log line used to sit ahead of validation, so a too-short token announced a successfully
      // loaded engine and then threw.
      process.env.SRS_WEBHOOK_TOKEN = 'too-short';
      const infos: string[] = [];
      const originalInfo = console.info;
      console.info = (...args: unknown[]) => void infos.push(args.join(' '));

      try {
        assert.throws(() => createSrsEngineFromEnv());
      } finally {
        console.info = originalInfo;
      }

      assert.ok(
        !infos.some((line) => line.includes('SRS engine loaded')),
        `a failed load must not report success, got: ${JSON.stringify(infos)}`,
      );
    });

    it('wires the environment token through to the gate', async () => {
      // Pins the call site rather than the helper: the token has to reach createSrsEngine.
      process.env.SRS_WEBHOOK_TOKEN = TOKEN;
      const engine = createSrsEngineFromEnv();
      const orchestrator = {
        startStream: () => true,
        stopStream: async () => {},
        handleSegment: () => ({ accepted: true }),
        handleSegmentLoss: () => true,
      } as unknown as StreamOrchestrator;

      const app = express();
      app.use(express.json());
      app.use(engine.prefix, engine.createRouter(orchestrator));
      const server = app.listen(0);

      try {
        await once(server, 'listening');
        const { port } = server.address() as AddressInfo;
        const url = `http://127.0.0.1:${port}${engine.prefix}/streams`;
        const body = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'on_publish', app: 'live', stream: 'demo' }),
        };

        assert.equal((await fetch(`${url}?${SRS_WEBHOOK_TOKEN_PARAM}=${TOKEN}`, body)).status, 200);
        assert.equal((await fetch(`${url}?${SRS_WEBHOOK_TOKEN_PARAM}=wrong`, body)).status, 401);
      } finally {
        server.close();
      }
    });
  });

  it('warns at construction that an unconfigured engine will reject everything', () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));

    try {
      createSrsEngine('/tmp/media-unused', {});
    } finally {
      console.warn = original;
    }

    assert.ok(
      warnings.some((line) => line.includes('No webhook token configured')),
      `construction must say so, got: ${JSON.stringify(warnings)}`,
    );
  });
});

describe('SRS webhook gate on the production app', () => {
  // The engine tests above hand-build a bare express app. This block drives createApiApp with the
  // engine mounted, which is the only thing that exercises middleware ordering against the parsers.
  function startedStreamsSpy(): { calls: string[]; orchestrator: StreamOrchestrator } {
    const calls: string[] = [];
    return {
      calls,
      orchestrator: {
        startStream: (streamId: string) => {
          calls.push(streamId);
          return true;
        },
        stopStream: async () => {},
        handleSegment: () => ({ accepted: true }),
        handleSegmentLoss: () => true,
        getHealthSignals: () => ({
          activeStreams: 0,
          queuePressure: 'low',
          maxConsecutiveManifestFailures: 0,
          maxConsecutiveSegmentFailures: 0,
          msSinceCatalogAnnounceFailed: null,
          msSinceStatePersistFailed: null,
          msSinceSegmentLoss: null,
          msSinceStreamActivity: null,
        }),
      } as unknown as StreamOrchestrator,
    };
  }

  function rawPost(path: string, body: string): string {
    return (
      `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    );
  }

  const UNPARSEABLE_BODY = '{"action":';
  const OVERSIZED_BODY = JSON.stringify({ pad: 'x'.repeat(200_000) });

  // Both routes, not just /streams. Mutation showed that moving the gate out of the shared mount
  // and into the /streams handler left /hls answering anonymous callers 200 with the suite green.
  // /hls reaches the segment read-and-delete path and the stamp-spending upload, so an untested
  // route sharing a mount is not a covered route.
  for (const route of ['/engines/srs/streams', '/engines/srs/hls']) {
    it(`rejects an unauthenticated ${route} and never reaches the orchestrator`, async () => {
      const { calls, orchestrator } = startedStreamsSpy();
      const api = await startTestApi(orchestrator, [createSrsEngine('/tmp/media-unused', { webhookToken: TOKEN })]);

      try {
        const response = await api.request(route, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'on_publish', app: 'live', stream: 'demo', file: 'x.ts', seq_no: 1 }),
        });

        assert.equal(response.status, 401);
        assert.deepEqual(calls, [], 'no handler on this router may run for an unauthenticated caller');
      } finally {
        await api.close();
      }
    });
  }

  it('redacts the credential in the request log, end to end', async () => {
    // The redaction tests call the helper directly with hand-written strings. Deleting the call at
    // its only production site left every one of them green, so this drives the real app instead.
    const infos: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => void infos.push(args.join(' '));

    const { orchestrator } = startedStreamsSpy();
    const api = await startTestApi(orchestrator, [createSrsEngine('/tmp/media-unused', { webhookToken: TOKEN })]);

    try {
      await api.request(`/engines/srs/streams?${SRS_WEBHOOK_TOKEN_PARAM}=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'on_publish', app: 'live', stream: 'demo' }),
      });
    } finally {
      console.info = originalInfo;
      await api.close();
    }

    const httpLine = infos.find((line) => line.includes('[HTTP]') && line.includes('/engines/srs/streams'));
    assert.ok(httpLine, `expected a request log line, got: ${JSON.stringify(infos)}`);
    assert.ok(!httpLine.includes(TOKEN), `the credential must not reach the log, got: ${httpLine}`);
    assert.ok(httpLine.includes('token=REDACTED'), `expected the redacted marker, got: ${httpLine}`);
    // The tail has to survive too: a redactor that swallows the status and duration is not a fix.
    assert.match(httpLine, /\b200\b/, `the status must survive redaction, got: ${httpLine}`);
  });

  for (const route of ['/engines/srs/streams', '/engines/srs/hls']) {
    it(`names ${route} in the rejection log, with the credential redacted`, async () => {
      // One line covered five causes and both routes, so an operator could not tell an on_publish
      // rejection from an on_hls one, and the line carried originalUrl with the token still in it.
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));

      const { orchestrator } = startedStreamsSpy();
      const api = await startTestApi(orchestrator, [createSrsEngine('/tmp/media-unused', { webhookToken: TOKEN })]);

      try {
        await api.request(`${route}?${SRS_WEBHOOK_TOKEN_PARAM}=${'w'.repeat(TOKEN.length)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'on_publish', app: 'live', stream: 'demo' }),
        });
      } finally {
        console.warn = original;
        await api.close();
      }

      const rejection = warnings.find((line) => line.includes('[SRS] Rejected webhook'));
      assert.ok(rejection, `expected a rejection line, got: ${JSON.stringify(warnings)}`);
      assert.ok(rejection.includes(route), `the line must name the route, got: ${rejection}`);
      assert.ok(rejection.includes('REDACTED'), `the line must redact the credential, got: ${rejection}`);
    });

    it(`refuses an anonymous oversized body on ${route} before parsing it`, async () => {
      // A 500 here would mean the parser ran first: the gate must be ahead of it, or an anonymous
      // caller costs the process a full parse and gets an unhandled-error line into the log.
      const { orchestrator } = startedStreamsSpy();
      const api = await startTestApi(orchestrator, [createSrsEngine('/tmp/media-unused', { webhookToken: TOKEN })]);

      try {
        assert.equal(await api.rawRequest(rawPost(route, OVERSIZED_BODY)), 401);
        assert.equal(await api.rawRequest(rawPost(route, UNPARSEABLE_BODY)), 401);
      } finally {
        await api.close();
      }
    });
  }
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
    // The spellings below all authenticate, because express decodes the parameter name before it
    // reaches req.query. A redactor narrower than the gate writes a live credential to the log.
    {
      name: 'a percent-encoded first character in the parameter name',
      url: `/engines/srs/hls?%74oken=${TOKEN}`,
      expected: '/engines/srs/hls?%74oken=REDACTED',
    },
    {
      name: 'a fully percent-encoded parameter name',
      url: `/engines/srs/hls?%74%6F%6B%65%6E=${TOKEN}`,
      expected: '/engines/srs/hls?%74%6F%6B%65%6E=REDACTED',
    },
    {
      name: 'a repeated token parameter, both occurrences',
      url: `/engines/srs/hls?token=${TOKEN}&token=${TOKEN}`,
      expected: '/engines/srs/hls?token=REDACTED&token=REDACTED',
    },
    {
      name: 'a token followed by a fragment',
      url: `/engines/srs/hls?token=${TOKEN}#done`,
      expected: '/engines/srs/hls?token=REDACTED#done',
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

  it('leaves a different parameter that merely contains the name untouched', () => {
    // Over-redaction is cheap but not free: a parameter the gate would never read as the
    // credential should survive, or the log stops being useful for diagnosing anything else.
    assert.equal(redactWebhookToken('/x?mytoken=abc&refresh_token=def'), '/x?mytoken=abc&refresh_token=def');
  });

  it('rejects a single-element array without relying on the length check', () => {
    // Express gives req.query.token an array for a repeated parameter. The suite passed that case
    // through the length check by accident rather than through the type guard, so a single-element
    // array, whose coerced bytes would otherwise line up, pins the guard itself.
    const asArray = { query: { [SRS_WEBHOOK_TOKEN_PARAM]: [TOKEN] } } as never;

    assert.equal(hasValidWebhookToken(asArray, TOKEN), false);
  });

  it('uses the parameter name that srs.conf.template actually sends', () => {
    // The contract is with the template, not with the tests: the auth tests build their query from
    // the exported constant, so renaming it would rename both sides and stay green while every real
    // SRS webhook started failing.
    const template = readFileSync(new URL('../../../engines/srs/srs.conf.template', import.meta.url), 'utf8');

    assert.match(
      template,
      new RegExp(`\\?${SRS_WEBHOOK_TOKEN_PARAM}=SRS_WEBHOOK_TOKEN_PLACEHOLDER`),
      'the code and the SRS config template must agree on the parameter name',
    );
  });

  it('does not throw on a malformed query string', () => {
    assert.equal(redactWebhookToken('/x?%'), '/x?%');
    assert.equal(redactWebhookToken(`/x?${SRS_WEBHOOK_TOKEN_PARAM}=%E0%A4`), '/x?token=REDACTED');
  });
});
