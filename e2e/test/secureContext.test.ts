import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { secureContextArgs } from '../src/browser/secureContext.js';

describe('the flag that makes a plain-http client a secure context', () => {
  it('names the exact origin of an http client on a non-loopback host, which is what --own-network runs reach', () => {
    assert.deepEqual(secureContextArgs('http://host.docker.internal:10074'), [
      '--unsafely-treat-insecure-origin-as-secure=http://host.docker.internal:10074',
    ]);
  });

  it('names the origin only, never a path the driver appended', () => {
    assert.deepEqual(secureContextArgs('http://192.168.1.20:10074/#/watch/video/a/b?qoe=1'), [
      '--unsafely-treat-insecure-origin-as-secure=http://192.168.1.20:10074',
    ]);
  });

  it('adds nothing for loopback, which Chrome already treats as secure', () => {
    assert.deepEqual(secureContextArgs('http://127.0.0.1:10074'), []);
    assert.deepEqual(secureContextArgs('http://localhost:5173'), []);
    assert.deepEqual(secureContextArgs('http://client.localhost:10074'), []);
    assert.deepEqual(secureContextArgs('http://[::1]:10074'), []);
  });

  it('adds nothing for https, which is a secure context on any host', () => {
    assert.deepEqual(secureContextArgs('https://stream.example.org'), []);
  });

  it('adds nothing when there is no client URL or it is not a URL, so the driver fails on its own terms', () => {
    assert.deepEqual(secureContextArgs(undefined), []);
    assert.deepEqual(secureContextArgs(''), []);
    assert.deepEqual(secureContextArgs('not a url'), []);
  });
});
