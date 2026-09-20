import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { provisionManagedFixtureStream } from '../src/continuation/adminFixture.js';
import type { ProcessInvocation, ProcessResult } from '../src/continuation/provisioner.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const STREAM_ID = '11111111-1111-4111-8111-111111111111';
const TOPIC = '22222222-2222-4222-8222-222222222222';
const UPLOADER_ID = '33333333-3333-4333-8333-333333333333';
const PASSWORD = 'synthetic-admin-password';
const COOKIE = 'web2_admin_session=synthetic-cookie';
const PUBLISH_KEY = '0123456789abcdef0123456789abcdef';

describe('continuation admin fixture bootstrap', () => {
  it('creates a process-routed owner and publishes one enrolled managed stream', async () => {
    const processCalls: ProcessInvocation[] = [];
    const httpCalls: Array<{ url: string; init: RequestInit }> = [];
    const bodies = [
      { user: { id: STREAM_ID } },
      { id: STREAM_ID, topic: TOPIC, status: 'draft' },
      {
        stream: {
          id: STREAM_ID,
          topic: TOPIC,
          status: 'published',
          lifecycle: {
            version: 1,
            revision: 1,
            runNumber: 1,
            state: 'ready',
            permission: 'open',
            canContinue: false,
          },
        },
        feed: { index: 1 },
      },
      { streamId: `video/${TOPIC}`, publishKey: PUBLISH_KEY },
    ];
    const statuses = [200, 201, 200, 200];
    const result = await provisionManagedFixtureStream(
      {
        fixtureId: FIXTURE_ID,
        uploaderId: UPLOADER_ID,
        apiContainerId: 'admin-api-container-id',
        adminBaseUrl: 'http://127.0.0.1:18080',
        username: 'srs-a1b2c3d4-owner',
        password: PASSWORD,
        now: () => Date.parse('2026-09-21T00:00:00.000Z'),
      },
      {
        process: {
          async run(invocation: ProcessInvocation): Promise<ProcessResult> {
            processCalls.push(structuredClone(invocation));
            return { stdout: '', stderr: '' };
          },
        },
        fetch: async (input, init) => {
          httpCalls.push({ url: String(input), init: structuredClone(init ?? {}) });
          const body = bodies.shift();
          assert.ok(body);
          return new Response(JSON.stringify(body), {
            status: statuses.shift(),
            headers: httpCalls.length === 1
              ? { 'content-type': 'application/json', 'set-cookie': `${COOKIE}; HttpOnly; SameSite=Lax; Path=/` }
              : { 'content-type': 'application/json' },
          });
        },
      },
    );

    assert.deepEqual(result.stream, { id: STREAM_ID, topic: TOPIC, mediaType: 'video' });
    assert.equal(result.uploaderId, UPLOADER_ID);
    assert.equal(result.ownerCookie, COOKIE);
    assert.equal(result.publishKey, PUBLISH_KEY);
    assert.deepEqual(processCalls[0]?.args, [
      'exec', '-i', 'admin-api-container-id', 'node', 'dist/cli.js',
      'user:add', 'srs-a1b2c3d4-owner', '--password-stdin', '--admin',
    ]);
    assert.equal(processCalls[0]?.stdin, `${PASSWORD}\n`);
    assert.doesNotMatch(JSON.stringify(processCalls[0]?.args), new RegExp(PASSWORD));
    assert.equal(new Headers(httpCalls[1]?.init.headers).get('cookie'), COOKIE);
    assert.equal(new Headers(httpCalls[2]?.init.headers).get('cookie'), COOKIE);
    assert.equal(new Headers(httpCalls[3]?.init.headers).get('cookie'), COOKIE);
    assert.match(String(httpCalls[1]?.init.body), /scheduledStartTime/);
    assert.deepEqual(bodies, []);
  });

  it('refuses a publish result that was not enrolled into the assigned managed lifecycle', async () => {
    const bodies = [
      { user: { id: STREAM_ID } },
      { id: STREAM_ID, topic: TOPIC, status: 'draft' },
      { stream: { id: STREAM_ID, topic: TOPIC, status: 'published' }, feed: { index: 1 } },
    ];
    const statuses = [200, 201, 200];

    await assert.rejects(
      provisionManagedFixtureStream(
        {
          fixtureId: FIXTURE_ID,
          uploaderId: UPLOADER_ID,
          apiContainerId: 'admin-api-container-id',
          adminBaseUrl: 'http://127.0.0.1:18080',
          username: 'srs-a1b2c3d4-owner',
          password: PASSWORD,
          now: () => Date.parse('2026-09-21T00:00:00.000Z'),
        },
        {
          process: { run: async () => ({ stdout: '', stderr: '' }) },
          fetch: async () => {
            const body = bodies.shift();
            assert.ok(body);
            return new Response(JSON.stringify(body), {
              status: statuses.shift(),
              headers: { 'content-type': 'application/json', 'set-cookie': `${COOKIE}; Path=/` },
            });
          },
        },
      ),
      /managed lifecycle/i,
    );
  });
});
