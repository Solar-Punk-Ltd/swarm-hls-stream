import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FixtureRefusal } from '../src/continuation/fixture.js';
import {
  FetchManagerProfileClient,
  managerUploaderProfileName,
} from '../src/continuation/managerProfile.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_NAME = 'srs-a1b2c3d4-uploader';
const PRIVATE_KEY = 'synthetic-private-key';
const POSTAGE_BATCH_ID = 'ab'.repeat(32);

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: PROFILE_NAME,
    instance_id: INSTANCE_ID,
    port_slot: 1,
    status: 'RUNNING',
    components: ['srs', 'stream-uploader'],
    pendingStamp: true,
    containers: [{ service: 'srs', ports: {} }],
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FetchManagerProfileClient', () => {
  it('creates one fixture-scoped held uploader profile and verifies authoritative readback', async () => {
    const calls: FetchCall[] = [];
    const responses = [
      new Response(null, {
        status: 204,
        headers: { 'set-cookie': 'sim_session=synthetic-session; Path=/; HttpOnly; SameSite=Lax' },
      }),
      jsonResponse(profile({ status: 'DEPLOYING', containers: [] }), 202),
      jsonResponse(profile({ status: 'DEPLOYING', containers: [] })),
      jsonResponse(profile()),
    ];
    const client = new FetchManagerProfileClient({
      baseUrl: 'http://127.0.0.1:9876/api',
      username: 'fixture-operator',
      password: 'synthetic-password',
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return responses.shift() ?? jsonResponse({ unexpected: true }, 500);
      },
      wait: async () => {},
      pollIntervalMs: 1,
      maximumPolls: 3,
    });

    const result = await client.createHeldUploaderProfile({
      fixtureId: FIXTURE_ID,
      expectedPortSlot: 1,
      beeUrl: 'http://bee-queen:1633',
      privateKey: PRIVATE_KEY,
    });

    assert.deepEqual(result, {
      name: PROFILE_NAME,
      instanceId: INSTANCE_ID,
      portSlot: 1,
    });
    assert.deepEqual(calls.map((call) => [new URL(call.url).pathname, call.init?.method ?? 'GET']), [
      ['/api/auth/login', 'POST'],
      ['/api/profiles', 'POST'],
      [`/api/profiles/${PROFILE_NAME}`, 'GET'],
      [`/api/profiles/${PROFILE_NAME}`, 'GET'],
    ]);
    const submitted = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    assert.deepEqual(submitted, {
      name: PROFILE_NAME,
      kind: 'custom',
      components: ['srs', 'stream-uploader'],
      bee_url: 'http://bee-queen:1633',
      private_key: PRIVATE_KEY,
    });
    assert.equal((calls[1]?.init?.headers as Record<string, string>).cookie, 'sim_session=synthetic-session');
    assert.equal(
      (calls[1]?.init?.headers as Record<string, string>)['x-requested-with'],
      'streaming-infra-manager',
    );
  });

  it('sets the existing postage batch, starts uploader through manager, and verifies readback', async () => {
    const calls: FetchCall[] = [];
    const responses = [
      new Response(null, {
        status: 204,
        headers: { 'set-cookie': 'sim_session=synthetic-session; Path=/; HttpOnly; SameSite=Lax' },
      }),
      jsonResponse(profile({ pendingStamp: false })),
      new Response([
        'event: start',
        'data: {"script":"deploy.sh"}',
        '',
        'event: done',
        'data: {"code":0,"signal":null}',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      jsonResponse(profile({
        pendingStamp: false,
        containers: [{ service: 'srs' }, { service: 'stream-uploader' }],
      })),
    ];
    const client = new FetchManagerProfileClient({
      baseUrl: 'http://127.0.0.1:9876/api',
      username: 'fixture-operator',
      password: 'synthetic-password',
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return responses.shift() ?? jsonResponse({ unexpected: true }, 500);
      },
    });

    await client.setStampAndStartUploader({
      profile: { name: PROFILE_NAME, instanceId: INSTANCE_ID, portSlot: 1 },
      postageBatchId: POSTAGE_BATCH_ID,
    });

    assert.deepEqual(calls.map((call) => [new URL(call.url).pathname, call.init?.method ?? 'GET']), [
      ['/api/auth/login', 'POST'],
      [`/api/profiles/${PROFILE_NAME}/stamp/set`, 'POST'],
      [`/api/profiles/${PROFILE_NAME}/deploy-uploader`, 'POST'],
      [`/api/profiles/${PROFILE_NAME}`, 'GET'],
    ]);
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { stamp_id: POSTAGE_BATCH_ID });
  });

  it('refuses uploader activation without the exact successful SSE completion', async () => {
    const responses = [
      new Response(null, { status: 204, headers: { 'set-cookie': 'sim_session=fake; Path=/' } }),
      jsonResponse(profile({ pendingStamp: false })),
      new Response('event: done\ndata: {"code":7,"signal":null}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    ];
    const client = new FetchManagerProfileClient({
      baseUrl: 'http://127.0.0.1:9876/api',
      username: 'fixture-operator',
      password: 'synthetic-password',
      fetch: async () => responses.shift() ?? jsonResponse({}, 500),
    });

    await assert.rejects(
      client.setStampAndStartUploader({
        profile: { name: PROFILE_NAME, instanceId: INSTANCE_ID, portSlot: 1 },
        postageBatchId: POSTAGE_BATCH_ID,
      }),
      /guarded uploader start did not complete successfully/i,
    );
  });

  it('derives a short unique profile name from the fixture suffix', () => {
    assert.equal(managerUploaderProfileName(FIXTURE_ID), PROFILE_NAME);
    assert.equal(managerUploaderProfileName('srs-continuation-20260920-deadbeef'), 'srs-deadbeef-uploader');
  });

  it('refuses a terminal readback that started the uploader before a stamp exists', async () => {
    const answers = [
      new Response(null, { status: 204, headers: { 'set-cookie': 'sim_session=fake; Path=/' } }),
      jsonResponse(profile(), 202),
      jsonResponse(profile({ containers: [{ service: 'srs' }, { service: 'stream-uploader' }] })),
    ];
    const client = new FetchManagerProfileClient({
      baseUrl: 'http://127.0.0.1:9876/api',
      username: 'fixture-operator',
      password: 'synthetic-password',
      fetch: async () => answers.shift() ?? jsonResponse({}, 500),
      wait: async () => {},
      pollIntervalMs: 1,
      maximumPolls: 1,
    });

    await assert.rejects(
      client.createHeldUploaderProfile({
        fixtureId: FIXTURE_ID,
        expectedPortSlot: 1,
        beeUrl: 'http://bee-queen:1633',
        privateKey: PRIVATE_KEY,
      }),
      /stream-uploader.*held/i,
    );
  });

  it('keeps credentials and response bodies out of bounded refusal messages', async () => {
    const client = new FetchManagerProfileClient({
      baseUrl: 'http://127.0.0.1:9876/api',
      username: 'fixture-operator',
      password: 'sentinel-password',
      fetch: async () => jsonResponse({ detail: 'sentinel-server-body' }, 401),
      wait: async () => {},
      pollIntervalMs: 1,
      maximumPolls: 1,
    });

    await assert.rejects(
      client.createHeldUploaderProfile({
        fixtureId: FIXTURE_ID,
        expectedPortSlot: 1,
        beeUrl: 'http://bee-queen:1633',
        privateKey: 'sentinel-private-key',
      }),
      (error: unknown) => {
        assert.ok(error instanceof FixtureRefusal);
        assert.match(error.message, /login.*401/i);
        assert.doesNotMatch(error.message, /sentinel/);
        return true;
      },
    );
  });

  it('refuses non-loopback manager origins and oversized responses', async () => {
    assert.throws(
      () => new FetchManagerProfileClient({
        baseUrl: 'http://manager.example/api',
        username: 'fixture-operator',
        password: 'synthetic-password',
      }),
      /loopback/i,
    );

    const answers = [
      new Response(null, { status: 204, headers: { 'set-cookie': 'sim_session=fake; Path=/' } }),
      new Response('x'.repeat(70 * 1024), { status: 202 }),
    ];
    const client = new FetchManagerProfileClient({
      baseUrl: 'http://127.0.0.1:9876/api',
      username: 'fixture-operator',
      password: 'synthetic-password',
      fetch: async () => answers.shift() ?? jsonResponse({}, 500),
      wait: async () => {},
      pollIntervalMs: 1,
      maximumPolls: 1,
    });

    await assert.rejects(
      client.createHeldUploaderProfile({
        fixtureId: FIXTURE_ID,
        expectedPortSlot: 1,
        beeUrl: 'http://bee-queen:1633',
        privateKey: PRIVATE_KEY,
      }),
      /byte bound/i,
    );
  });
});
