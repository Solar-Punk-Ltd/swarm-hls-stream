import { describe, expect, it } from 'vitest';

import {
  describeProbeOutcome,
  GATEWAY_PROBE_PATH,
  gatewayLabel,
  normalizeGatewayUrl,
  probeGateway,
} from '../src/components/DomainSelector/gatewayProbe';

const BEE_HEALTH = '{"status":"ok","version":"2.8.2","apiVersion":"7.3.0"}';

function answering(status: number, body = BEE_HEALTH): typeof fetch {
  return ((_url: string) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      text: () => Promise.resolve(body),
    } as unknown as Response)) as unknown as typeof fetch;
}

function refusing(): typeof fetch {
  return ((_url: string) => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
}

describe('normalizeGatewayUrl', () => {
  it('strips whitespace and trailing slashes', () => {
    expect(normalizeGatewayUrl('  http://localhost:1663///  ')).toBe('http://localhost:1663');
  });

  it('adds http:// to a bare host:port, which is how an address gets copied out of Swarm Desktop', () => {
    expect(normalizeGatewayUrl('localhost:1663')).toBe('http://localhost:1663');
    expect(normalizeGatewayUrl('192.168.1.20:1633')).toBe('http://192.168.1.20:1633');
  });

  it('leaves an explicit scheme alone, whatever its case', () => {
    expect(normalizeGatewayUrl('HTTPS://gateway.example')).toBe('HTTPS://gateway.example');
  });

  it('keeps a path-only default such as /bee as it is', () => {
    expect(normalizeGatewayUrl('/bee/')).toBe('/bee');
  });

  it('returns an empty string for nothing, so the caller can refuse it', () => {
    expect(normalizeGatewayUrl('   ')).toBe('');
  });
});

describe('probeGateway', () => {
  it('asks the health endpoint under the given base', async () => {
    let asked = '';
    const fetcher = ((url: string) => {
      asked = url;
      return answering(200)(url);
    }) as unknown as typeof fetch;
    await probeGateway('http://localhost:1663', { fetcher });
    expect(asked).toBe(`http://localhost:1663${GATEWAY_PROBE_PATH}`);
  });

  it('reports ok when the node answers 2xx', async () => {
    expect(await probeGateway('http://localhost:1663', { fetcher: answering(200) })).toEqual({ kind: 'ok' });
  });

  it('reports not-bee when a web server with a fallback route answers 200 with its index page', async () => {
    const index = '<!doctype html><html><head><title>Multimedia Streaming over Swarm</title></head></html>';
    expect(await probeGateway('http://localhost:4173', { fetcher: answering(200, index) })).toEqual({
      kind: 'not-bee',
    });
  });

  it('still reports ok for a Bee node whose health status is not ok, because it is a Bee node', async () => {
    expect(await probeGateway('http://localhost:1633', { fetcher: answering(200, '{"status":"nok"}') })).toEqual({
      kind: 'ok',
    });
  });

  it('reports rejected with the status when something else answers', async () => {
    expect(await probeGateway('http://localhost:8080', { fetcher: answering(404) })).toEqual({
      kind: 'rejected',
      status: 404,
    });
  });

  it('reports unreachable, rather than throwing, when the fetch is refused', async () => {
    expect(await probeGateway('http://localhost:1', { fetcher: refusing() })).toEqual({ kind: 'unreachable' });
  });

  it('reports unreachable when the node accepts and never answers', async () => {
    const silent = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
    expect(await probeGateway('http://localhost:1663', { fetcher: silent, timeoutMs: 20 })).toEqual({
      kind: 'unreachable',
    });
  });
});

describe('describeProbeOutcome', () => {
  it('tells an unreachable viewer about CORS, because a browser hides that cause behind a failed fetch', () => {
    expect(describeProbeOutcome({ kind: 'unreachable' })).toContain('cors-allowed-origins');
  });

  it('names the status when something answered with an error', () => {
    expect(describeProbeOutcome({ kind: 'rejected', status: 502 })).toContain('502');
  });

  it('says plainly that the thing answering is not a Bee node', () => {
    expect(describeProbeOutcome({ kind: 'not-bee' })).toContain('not a Bee node');
  });
});

describe('gatewayLabel', () => {
  it('names the default rather than showing a path a viewer would not recognise', () => {
    expect(gatewayLabel('/bee', '/bee')).toBe('Default gateway');
  });

  it('shows a custom node as its host', () => {
    expect(gatewayLabel('http://localhost:1663', '/bee')).toBe('localhost:1663');
  });

  it('falls back to the raw value when it is not a URL', () => {
    expect(gatewayLabel('/other-proxy', '/bee')).toBe('/other-proxy');
  });
});
