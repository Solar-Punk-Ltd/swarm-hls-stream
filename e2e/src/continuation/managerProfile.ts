import { setTimeout as waitFor } from 'node:timers/promises';

import { FixtureRefusal } from './fixture.js';

const FIXTURE_ID = /^srs-continuation-20260920-([a-z0-9]{8,16})$/;
const PROFILE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/;
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INTERNAL_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const REQUESTED_WITH_HEADER = 'x-requested-with';
const REQUESTED_WITH_VALUE = 'streaming-infra-manager';
const SESSION_COOKIE = 'sim_session=';
const EXPECTED_COMPONENTS = ['srs', 'stream-uploader'] as const;
const TERMINAL_STATUSES = new Set(['RUNNING', 'STOPPED', 'ERROR']);
const TRANSITIONAL_STATUSES = new Set(['DEPLOYING', 'STOPPING', 'REMOVING']);

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ManagerProfileClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  fetch?: Fetch;
  wait?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  maximumPolls?: number;
}

export interface CreateHeldUploaderProfileInput {
  fixtureId: string;
  expectedPortSlot: number;
  beeUrl: string;
  privateKey: string;
}

export interface HeldUploaderProfile {
  name: string;
  instanceId: string;
  portSlot: number;
}

interface ProfileResponse {
  name: string;
  instanceId: string;
  portSlot: number;
  status: string;
  components: readonly string[];
  pendingStamp: boolean;
  containers: readonly string[];
}

export function managerUploaderProfileName(fixtureId: string): string {
  const match = FIXTURE_ID.exec(fixtureId);
  if (!match) {
    throw new FixtureRefusal('manager profile fixture identity is malformed');
  }
  const name = `srs-${match[1]}-uploader`;
  if (!PROFILE_NAME.test(name) || name.length > 31) {
    throw new FixtureRefusal('manager uploader profile name is malformed');
  }
  return name;
}

/** Creates the real manager-owned uploader identity while its uploader remains held for postage. */
export class FetchManagerProfileClient {
  private readonly baseUrl: URL;
  private readonly fetch: Fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maximumPolls: number;
  private readonly username: string;
  private readonly password: string;

  constructor(options: ManagerProfileClientOptions) {
    this.baseUrl = managerBaseUrl(options.baseUrl);
    this.username = credential(options.username, 'manager username');
    this.password = credential(options.password, 'manager password');
    this.fetch = options.fetch ?? fetch;
    this.wait = options.wait ?? (async (milliseconds) => { await waitFor(milliseconds); });
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 1_000, 1, 10_000, 'profile poll interval');
    this.maximumPolls = boundedInteger(options.maximumPolls ?? 600, 1, 1_200, 'profile poll count');
  }

  async createHeldUploaderProfile(input: CreateHeldUploaderProfileInput): Promise<HeldUploaderProfile> {
    const name = managerUploaderProfileName(input.fixtureId);
    const portSlot = boundedInteger(input.expectedPortSlot, 1, 99, 'manager profile port slot');
    const beeUrl = internalBeeUrl(input.beeUrl);
    const privateKey = credential(input.privateKey, 'manager profile private key');
    const sessionCookie = await this.login();

    const created = profileFrom(
      await this.jsonRequest('/profiles', {
        method: 'POST',
        headers: authenticatedHeaders(sessionCookie, true),
        body: JSON.stringify({
          name,
          kind: 'custom',
          components: EXPECTED_COMPONENTS,
          bee_url: beeUrl,
          private_key: privateKey,
        }),
      }, new Set([202])),
      'manager profile create',
    );
    assertProfileIdentity(created, name, portSlot);

    for (let attempt = 0; attempt < this.maximumPolls; attempt += 1) {
      if (attempt > 0) {
        await this.wait(this.pollIntervalMs);
      }
      const current = profileFrom(
        await this.jsonRequest(`/profiles/${encodeURIComponent(name)}`, {
          method: 'GET',
          headers: authenticatedHeaders(sessionCookie, false),
        }, new Set([200])),
        'manager profile readback',
      );
      assertProfileIdentity(current, name, portSlot, created.instanceId);
      if (TRANSITIONAL_STATUSES.has(current.status)) {
        continue;
      }
      if (!TERMINAL_STATUSES.has(current.status)) {
        throw new FixtureRefusal('manager profile readback status is malformed');
      }
      if (current.status !== 'RUNNING') {
        throw new FixtureRefusal('manager profile did not reach the running held state');
      }
      assertHeldUploader(current);
      return { name, instanceId: current.instanceId, portSlot };
    }
    throw new FixtureRefusal('manager profile did not reach a terminal state within the poll bound');
  }

  private async login(): Promise<string> {
    const response = await this.fetch(this.url('/auth/login'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
      },
      body: JSON.stringify({ username: this.username, password: this.password }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 204) {
      throw new FixtureRefusal(`manager login returned HTTP ${response.status}`);
    }
    const setCookies = response.headers.getSetCookie?.() ?? [];
    const fallback = response.headers.get('set-cookie');
    const cookie = sessionCookieFrom(fallback === null ? setCookies : [...setCookies, fallback]);
    if (cookie === null) {
      throw new FixtureRefusal('manager login did not set a bounded session cookie');
    }
    return cookie;
  }

  private async jsonRequest(path: string, init: RequestInit, accepted: ReadonlySet<number>): Promise<unknown> {
    const response = await this.fetch(this.url(path), {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!accepted.has(response.status)) {
      throw new FixtureRefusal(`manager profile request returned HTTP ${response.status}`);
    }
    return boundedJson(response, MAX_RESPONSE_BYTES);
  }

  private url(path: string): URL {
    return new URL(`${this.baseUrl.pathname.replace(/\/$/, '')}${path}`, this.baseUrl);
  }
}

function managerBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FixtureRefusal('manager profile base URL is malformed');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new FixtureRefusal('manager profile base URL must be an uncredentialed loopback HTTP URL');
  }
  return url;
}

function internalBeeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FixtureRefusal('manager profile Bee URL is malformed');
  }
  if (
    url.protocol !== 'http:' ||
    url.port !== '1633' ||
    !INTERNAL_HOST.test(url.hostname) ||
    url.hostname === 'localhost' ||
    url.username !== '' ||
    url.password !== '' ||
    !['', '/'].includes(url.pathname) ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new FixtureRefusal('manager profile Bee URL must be the bounded internal fixture API');
  }
  return url.origin;
}

function credential(value: string, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16 * 1024) {
    throw new FixtureRefusal(`${label} is missing or exceeds its byte bound`);
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new FixtureRefusal(`${label} is outside its allowed range`);
  }
  return value;
}

function authenticatedHeaders(cookie: string, write: boolean): Record<string, string> {
  return {
    accept: 'application/json',
    cookie,
    ...(write
      ? {
          'content-type': 'application/json',
          [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
        }
      : {}),
  };
}

function sessionCookieFrom(headers: readonly string[]): string | null {
  let session: string | null = null;
  for (const header of headers) {
    const pair = header.split(';', 1)[0]?.trim() ?? '';
    if (!pair.startsWith(SESSION_COOKIE)) {
      continue;
    }
    if (pair.length <= SESSION_COOKIE.length || pair.length > 4096 || /[\r\n]/.test(pair)) {
      session = null;
      continue;
    }
    session = pair;
  }
  return session;
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (response.body === null) {
    throw new FixtureRefusal('manager profile response body is missing');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let next = await reader.read();
  while (!next.done) {
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new FixtureRefusal('manager profile response exceeded its byte bound');
    }
    chunks.push(next.value);
    next = await reader.read();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
  } catch {
    throw new FixtureRefusal('manager profile response is not valid bounded JSON');
  }
}

function profileFrom(value: unknown, label: string): ProfileResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FixtureRefusal(`${label} is malformed`);
  }
  const raw = value as Record<string, unknown>;
  const containers = Array.isArray(raw.containers)
    ? raw.containers.map((container) => {
        if (container === null || typeof container !== 'object' || Array.isArray(container)) {
          throw new FixtureRefusal(`${label} containers are malformed`);
        }
        const service = (container as Record<string, unknown>).service;
        if (typeof service !== 'string' || service.length > 100) {
          throw new FixtureRefusal(`${label} containers are malformed`);
        }
        return service;
      })
    : null;
  if (
    typeof raw.name !== 'string' ||
    typeof raw.instance_id !== 'string' ||
    !INSTANCE_ID.test(raw.instance_id) ||
    !Number.isSafeInteger(raw.port_slot) ||
    typeof raw.status !== 'string' ||
    !Array.isArray(raw.components) ||
    raw.components.some((component) => typeof component !== 'string') ||
    typeof raw.pendingStamp !== 'boolean' ||
    containers === null
  ) {
    throw new FixtureRefusal(`${label} is malformed`);
  }
  return {
    name: raw.name,
    instanceId: raw.instance_id,
    portSlot: Number(raw.port_slot),
    status: raw.status,
    components: raw.components as string[],
    pendingStamp: raw.pendingStamp,
    containers,
  };
}

function assertProfileIdentity(
  profile: ProfileResponse,
  expectedName: string,
  expectedPortSlot: number,
  expectedInstanceId?: string,
): void {
  if (
    profile.name !== expectedName ||
    profile.portSlot !== expectedPortSlot ||
    (expectedInstanceId !== undefined && profile.instanceId !== expectedInstanceId) ||
    profile.components.length !== EXPECTED_COMPONENTS.length ||
    profile.components.some((component, index) => component !== EXPECTED_COMPONENTS[index])
  ) {
    throw new FixtureRefusal('manager profile identity or stored component order changed');
  }
}

function assertHeldUploader(profile: ProfileResponse): void {
  const srsCount = profile.containers.filter((service) => service === 'srs').length;
  const uploaderCount = profile.containers.filter((service) => service === 'stream-uploader').length;
  if (!profile.pendingStamp || srsCount !== 1 || uploaderCount !== 0) {
    throw new FixtureRefusal('manager profile did not keep stream-uploader held while SRS started');
  }
}
