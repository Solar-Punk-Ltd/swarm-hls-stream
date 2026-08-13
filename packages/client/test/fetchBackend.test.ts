import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

import {
  FETCH_BACKEND_GATEWAY,
  FETCH_BACKEND_WEEB3,
  segmentRefFromUrl,
  selectedFetchBackend,
} from '../src/components/SwarmHlsPlayer/fetchBackend';

const REF = '9c4e1f60b8a2d357e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7';
const ENCRYPTED_REF = REF + REF;

describe('choosing which backend fetches a segment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fetches through the gateway when nothing asked for anything else', () => {
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', '');

    assert.equal(selectedFetchBackend(), FETCH_BACKEND_GATEWAY);
  });

  it('fetches through weeb-3 when the build asked for it', () => {
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', FETCH_BACKEND_WEEB3);

    assert.equal(selectedFetchBackend(), FETCH_BACKEND_WEEB3);
  });

  /**
   * ⛔ A typo must not take the video away.
   *
   * The gateway path is the shipping one and weeb-3 is the experiment, so an unrecognised value is a
   * misconfigured harness rather than a request to stop playing. Failing closed here would turn one
   * wrong character in a compose file into a broadcast nobody can watch, and the symptom would be a
   * dead player rather than a message about the value.
   */
  it('falls back to the gateway on a value it does not recognise', () => {
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', 'weeb-3');

    assert.equal(selectedFetchBackend(), FETCH_BACKEND_GATEWAY);
  });
});

/**
 * Turning the url hls.js hands us back into the bare Swarm reference weeb-3 wants.
 *
 * Every segment line the uploader publishes is a bare reference as of 2026-08-13, and the client's own
 * `buildUri` prefixes it with whichever gateway this viewer chose. So by the time a fragment reaches
 * the loader it always reads `<gateway>/bytes/<ref>`, and the host half is exactly the part weeb-3
 * makes irrelevant.
 */
describe('reading a Swarm reference off a fragment url', () => {
  it('takes the reference and discards the gateway that carried it', () => {
    assert.equal(segmentRefFromUrl(`http://127.0.0.1:1633/bytes/${REF}`), REF);
  });

  it('reads the same reference whichever gateway is in front of it', () => {
    assert.equal(segmentRefFromUrl(`https://gateway.example.com:10077/bytes/${REF}`), REF);
  });

  // 64 bytes rather than 32, which is what an encrypted upload references.
  it('reads an encrypted reference, which is twice as long', () => {
    assert.equal(segmentRefFromUrl(`http://127.0.0.1:1633/bytes/${ENCRYPTED_REF}`), ENCRYPTED_REF);
  });

  it('ignores a query string and a fragment identifier', () => {
    assert.equal(segmentRefFromUrl(`http://127.0.0.1:1633/bytes/${REF}?v=2#top`), REF);
  });

  it('finds nothing in a url that names no bytes route', () => {
    assert.equal(segmentRefFromUrl('http://127.0.0.1:1633/chunks/' + REF), null);
  });

  /**
   * The reference goes straight into a wasm call, so a malformed one is worth refusing here where the
   * message can name it. A Swarm reference is 32 or 64 bytes of hex and nothing else.
   */
  it('refuses something that is not a reference at all', () => {
    assert.equal(segmentRefFromUrl('http://127.0.0.1:1633/bytes/../../etc/passwd'), null);
    assert.equal(segmentRefFromUrl('http://127.0.0.1:1633/bytes/'), null);
  });

  it('refuses hex of the wrong length, which would fail opaquely inside the node', () => {
    assert.equal(segmentRefFromUrl('http://127.0.0.1:1633/bytes/0123456789abcdef'), null);
  });
});
