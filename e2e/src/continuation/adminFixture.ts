import { FixtureRefusal } from './fixture.js';
import type { BoundedProcess } from './provisioner.js';

const FIXTURE_ID = /^srs-continuation-20260920-([a-z0-9]{8,16})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const SAFE_USERNAME = /^[A-Za-z0-9_.-]{1,100}$/;
const PUBLISH_KEY = /^[0-9a-f]{32}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const SESSION_COOKIE = 'web2_admin_session=';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ManagedFixtureStreamInput {
  fixtureId: string;
  uploaderId: string;
  apiContainerId: string;
  adminBaseUrl: string;
  username: string;
  password: string;
  now?: () => number;
}

export interface ManagedFixtureStreamSession {
  stream: { id: string; topic: string; mediaType: 'video' };
  uploaderId: string;
  ownerCookie: string;
  publishKey: string;
}

interface ManagedFixtureStreamDependencies {
  process: BoundedProcess;
  fetch?: Fetch;
}

/** Creates the fixture owner through the CLI, then publishes one managed placeholder through the owner API. */
export async function provisionManagedFixtureStream(
  input: ManagedFixtureStreamInput,
  dependencies: ManagedFixtureStreamDependencies,
): Promise<ManagedFixtureStreamSession> {
  const suffix = validateInput(input);
  const baseUrl = loopbackBaseUrl(input.adminBaseUrl);
  const fetchImpl = dependencies.fetch ?? fetch;
  try {
    await dependencies.process.run({
      file: 'docker',
      args: [
        'exec',
        '-i',
        input.apiContainerId,
        'node',
        'dist/cli.js',
        'user:add',
        input.username,
        '--password-stdin',
        '--admin',
      ],
      stdin: `${input.password}\n`,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    });
  } catch {
    throw new FixtureRefusal('admin fixture owner creation failed without exposing child output');
  }

  const login = await request(
    fetchImpl,
    baseUrl,
    '/api/auth/login',
    {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ username: input.username, password: input.password }),
    },
    new Set([200]),
  );
  const ownerCookie = sessionCookie(login.response);
  if (ownerCookie === null) {
    throw new FixtureRefusal('admin fixture login did not set a bounded session cookie');
  }

  const scheduledStartTime = new Date((input.now ?? Date.now)() + 60_000).toISOString();
  const created = objectBody(
    (
      await request(
        fetchImpl,
        baseUrl,
        '/api/streams',
        {
          method: 'POST',
          headers: ownerHeaders(ownerCookie, true),
          body: JSON.stringify({
            title: `Continuation fixture ${suffix}`,
            description: 'Isolated continuation acceptance fixture',
            tags: ['continuation-fixture'],
            mediaType: 'video',
            scheduledStartTime,
          }),
        },
        new Set([201]),
      )
    ).body,
    'admin fixture stream create',
  );
  const stream = streamIdentity(created, 'admin fixture stream create');
  if (created.status !== 'draft') {
    throw new FixtureRefusal('admin fixture stream did not start as a draft');
  }

  const published = objectBody(
    (
      await request(
        fetchImpl,
        baseUrl,
        `/api/streams/${stream.id}/publish`,
        {
          method: 'POST',
          headers: ownerHeaders(ownerCookie, true),
        },
        new Set([200]),
      )
    ).body,
    'admin fixture stream publish',
  );
  const publishedStream = objectBody(published.stream, 'admin fixture published stream');
  const publishedIdentity = streamIdentity(publishedStream, 'admin fixture published stream');
  if (
    publishedIdentity.id !== stream.id ||
    publishedIdentity.topic !== stream.topic ||
    publishedStream.status !== 'published'
  ) {
    throw new FixtureRefusal('admin fixture publish result changed the stream identity');
  }
  const ownerView = objectBody(
    (
      await request(
        fetchImpl,
        baseUrl,
        `/api/streams/${stream.id}`,
        {
          method: 'GET',
          headers: ownerHeaders(ownerCookie, false),
        },
        new Set([200]),
      )
    ).body,
    'admin fixture managed owner read',
  );
  const ownerIdentity = streamIdentity(ownerView, 'admin fixture managed owner read');
  const lifecycle = objectBody(ownerView.lifecycle, 'admin fixture managed lifecycle');
  if (
    ownerIdentity.id !== stream.id ||
    ownerIdentity.topic !== stream.topic ||
    lifecycle.version !== 1 ||
    lifecycle.revision !== 1 ||
    lifecycle.runNumber !== 1 ||
    lifecycle.state !== 'ready' ||
    lifecycle.permission !== 'open'
  ) {
    throw new FixtureRefusal('admin fixture stream was not enrolled into the assigned managed lifecycle');
  }

  const ingest = objectBody(
    (
      await request(
        fetchImpl,
        baseUrl,
        `/api/streams/${stream.id}/ingest`,
        {
          method: 'GET',
          headers: ownerHeaders(ownerCookie, false),
        },
        new Set([200]),
      )
    ).body,
    'admin fixture ingest details',
  );
  if (
    ingest.streamId !== `video/${stream.topic}` ||
    typeof ingest.publishKey !== 'string' ||
    !PUBLISH_KEY.test(ingest.publishKey)
  ) {
    throw new FixtureRefusal('admin fixture ingest details do not match the managed stream');
  }
  return {
    stream: { ...stream, mediaType: 'video' },
    uploaderId: input.uploaderId,
    ownerCookie,
    publishKey: ingest.publishKey,
  };
}

function validateInput(input: ManagedFixtureStreamInput): string {
  const fixture = FIXTURE_ID.exec(input.fixtureId);
  if (
    !fixture ||
    !SAFE_ID.test(input.uploaderId) ||
    !SAFE_ID.test(input.apiContainerId) ||
    !SAFE_USERNAME.test(input.username) ||
    input.password.length < 1 ||
    Buffer.byteLength(input.password) > 16 * 1024 ||
    /[\0\r\n]/.test(input.password)
  ) {
    throw new FixtureRefusal('admin fixture stream input is malformed');
  }
  return fixture[1] ?? '';
}

function loopbackBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FixtureRefusal('admin fixture base URL is malformed');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new FixtureRefusal('admin fixture base URL must be an uncredentialed loopback endpoint');
  }
  return url;
}

async function request(
  fetchImpl: Fetch,
  baseUrl: URL,
  path: string,
  init: RequestInit,
  accepted: ReadonlySet<number>,
): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, baseUrl), {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new FixtureRefusal('admin fixture request failed without exposing request data');
  }
  const body = await boundedJson(response);
  if (!accepted.has(response.status)) {
    throw new FixtureRefusal(`admin fixture request returned HTTP ${response.status}`);
  }
  return { response, body };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) {
    throw new FixtureRefusal('admin fixture response body is missing');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    total += next.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new FixtureRefusal('admin fixture response exceeded its byte bound');
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
  } catch {
    throw new FixtureRefusal('admin fixture response is not bounded JSON');
  }
}

function sessionCookie(response: Response): string | null {
  const values = response.headers.getSetCookie?.() ?? [];
  const fallback = response.headers.get('set-cookie');
  for (const header of fallback === null ? values : [...values, fallback]) {
    const pair = header.split(';', 1)[0]?.trim() ?? '';
    if (
      pair.startsWith(SESSION_COOKIE) &&
      pair.length > SESSION_COOKIE.length &&
      pair.length <= 4096 &&
      !/[\r\n]/.test(pair)
    ) {
      return pair;
    }
  }
  return null;
}

function writeHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-requested-with': 'web2-admin' };
}

function ownerHeaders(cookie: string, write: boolean): Record<string, string> {
  return {
    accept: 'application/json',
    cookie,
    ...(write ? writeHeaders() : {}),
  };
}

function objectBody(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FixtureRefusal(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function streamIdentity(value: Record<string, unknown>, label: string): { id: string; topic: string } {
  if (
    typeof value.id !== 'string' ||
    !UUID.test(value.id) ||
    typeof value.topic !== 'string' ||
    !UUID.test(value.topic)
  ) {
    throw new FixtureRefusal(`${label} identity is malformed`);
  }
  return { id: value.id, topic: value.topic };
}
