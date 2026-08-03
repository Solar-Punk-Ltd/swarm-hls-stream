import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { type E2EConfig, loadConfig } from '../src/config.js';
import { getEngine, srtIngestUrl } from '../src/harness/engine.js';

/**
 * The SRT ingest URL is the one thing in the harness that no assertion downstream can catch being
 * wrong: a malformed streamid is refused during the handshake, no segment is ever produced, and
 * every scenario fails on its warmup wait rather than on what it was written to test.
 */

const roots: string[] = [];

after(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function config(env: NodeJS.ProcessEnv): E2EConfig {
  const rootDir = mkdtempSync(join(tmpdir(), 'e2e-engine-'));
  roots.push(rootDir);
  return loadConfig({ env: { E2E_PUBLIC_HOST: '203.0.113.10', ...env }, rootDir });
}

describe('SRS ingest', () => {
  // SRS's documented publish form. ffmpeg passes the literal `#!::r=...` through to libsrt, so the
  // `#` is not a fragment delimiter here and must survive into the URL as written.
  it('builds the #!::r= streamid with m=publish', () => {
    const cfg = config({ E2E_ENGINE: 'srs', E2E_PORT_SLOT: '2' });
    assert.equal(srtIngestUrl(cfg), 'srt://203.0.113.10:10021?streamid=#!::r=live/stream,m=publish');
  });

  it('follows the port slot, because SRS ingest is a profile service', () => {
    assert.match(srtIngestUrl(config({ E2E_ENGINE: 'srs', E2E_PORT_SLOT: '7' })), /:10071\?/);
  });

  it('restarts the srs container belonging to its own profile', () => {
    const cfg = config({ E2E_ENGINE: 'srs', E2E_PROFILE: 'streamer1' });
    assert.equal(getEngine(cfg).mediaContainer(cfg), 'streamer1-srs-1');
  });

  it('watches for the published and unpublished markers', () => {
    const engine = getEngine(config({ E2E_ENGINE: 'srs' }));
    assert.match('[SRS] Stream published: stream-7 (video)', engine.publishedMarker);
    assert.match('[SRS] Stream unpublished: stream-7', engine.unpublishedMarker);
    assert.doesNotMatch('[SRS] Stream unpublished: stream-7', engine.publishedMarker);
  });
});

describe('OME ingest', () => {
  // OME derives app and stream from the streamid, and the uploader's admission parser reads them
  // from a full srt:// URL, so one is embedded rather than the bare path SRS takes.
  it('embeds a full srt URL in the streamid', () => {
    const cfg = config({ E2E_ENGINE: 'ome' });
    assert.equal(srtIngestUrl(cfg), 'srt://203.0.113.10:10081?streamid=srt://203.0.113.10:10081/video/stream');
  });

  // The difference from SRS that a shared implementation would get wrong. OME's port comes from its
  // engine env and is never slot-shifted, so the ingest URL must not move with the slot.
  it('does not follow the port slot', () => {
    const withSlot = srtIngestUrl(config({ E2E_ENGINE: 'ome', E2E_PORT_SLOT: '5' }));
    const withoutSlot = srtIngestUrl(config({ E2E_ENGINE: 'ome' }));
    assert.equal(withSlot, withoutSlot, 'the OME ingest URL moved with the port slot');
  });

  it('restarts the ome container belonging to its own profile', () => {
    const cfg = config({ E2E_ENGINE: 'ome', E2E_PROFILE: 'streamer1' });
    assert.equal(getEngine(cfg).mediaContainer(cfg), 'streamer1-ome-1');
  });

  it('watches for the opening and closing markers', () => {
    const engine = getEngine(config({ E2E_ENGINE: 'ome' }));
    assert.match('[OME] Stream opening: stream-7 (video)', engine.publishedMarker);
    assert.match('[OME] Stream closing: stream-7', engine.unpublishedMarker);
  });

  // OME cold-starts slower than SRS, and a grace shared between them would either race OME's
  // restart or waste time on every SRS run.
  it('allows a longer reconnect grace than SRS', () => {
    assert.ok(
      getEngine(config({ E2E_ENGINE: 'ome' })).reconnectGraceMs >
        getEngine(config({ E2E_ENGINE: 'srs' })).reconnectGraceMs,
    );
  });
});

describe('engine markers do not match the other engine', () => {
  // Both engines run the same downstream assertions, so a marker matching either would let an SRS
  // run pass while attached to an OME deployment, reporting on a stack it never drove.
  it('keeps the SRS and OME markers disjoint', () => {
    const srs = getEngine(config({ E2E_ENGINE: 'srs' }));
    const ome = getEngine(config({ E2E_ENGINE: 'ome' }));
    assert.doesNotMatch('[OME] Stream opening: s', srs.publishedMarker);
    assert.doesNotMatch('[SRS] Stream published: s', ome.publishedMarker);
    assert.doesNotMatch('[OME] Stream closing: s', srs.unpublishedMarker);
    assert.doesNotMatch('[SRS] Stream unpublished: s', ome.unpublishedMarker);
  });
});

describe('a custom stream path reaches the URL', () => {
  it('is used by both engines', () => {
    assert.match(
      srtIngestUrl(config({ E2E_ENGINE: 'srs', E2E_STREAM_PATH: 'live/other' })),
      /r=live\/other,m=publish$/,
    );
    assert.match(srtIngestUrl(config({ E2E_ENGINE: 'ome', E2E_STREAM_PATH: 'audio/other' })), /\/audio\/other$/);
  });
});

/**
 * That the URL this suite dials carries the credential the deployment demands. See SEC-28 and SEC-29.
 *
 * Every scenario here published with no key at all until 2026-08-03, so against a deployment with
 * `PUBLISH_KEY_SECRET` set, all of them failed at the first admission. That failure is the expensive
 * kind: the engine refuses the handshake, no segment is produced, and each scenario waits out its
 * warmup and reports a publisher timeout, which reads as a broken stack rather than a missing key.
 *
 * **Pinned to the golden vector rather than to `derivePublishKey`'s own output**, which is the whole
 * point. Asserting the URL contains what the function just returned would pass with both sides
 * broken in the same direction. This literal is the same one `packages/stream-uploader` and
 * `deploy/test/publishKey.test.js` pin, so the publisher, the verifier and the operator CLI are three
 * independent files agreeing on one string. If they ever disagree, every key issued is refused and it
 * looks exactly like a broadcaster's typo.
 */
describe('the publish key in the ingest URL', () => {
  const GOLDEN_SECRET = 'publish-key-secret-0123456789abcdef';
  const GOLDEN_KEY = '2d1e344ecb833667c936399866349fbc';
  const GOLDEN_PATH = 'video/demo';

  it('SRS carries the key inside the r= value, ahead of m=publish', () => {
    const cfg = config({
      E2E_ENGINE: 'srs',
      E2E_STREAM_PATH: GOLDEN_PATH,
      PUBLISH_KEY_SECRET: GOLDEN_SECRET,
    });

    assert.match(srtIngestUrl(cfg), new RegExp(`streamid=#!::r=video/demo\\?key=${GOLDEN_KEY},m=publish$`));
  });

  it('OME carries the key in the nested streamid, percent-encoded', () => {
    const cfg = config({
      E2E_ENGINE: 'ome',
      E2E_STREAM_PATH: GOLDEN_PATH,
      PUBLISH_KEY_SECRET: GOLDEN_SECRET,
    });

    assert.ok(
      srtIngestUrl(cfg).includes(`%3Fkey%3D${GOLDEN_KEY}`),
      'the key has to survive into the streamid, and the second ? has to be encoded',
    );
  });

  /**
   * The property SEC-28 rests on, asserted where it can actually be got wrong. Deriving against the
   * secret alone, or against a constant, would authenticate every scenario against every stream, and
   * the multi-stream scenario is the only place that shows.
   */
  it('derives a different key per stream, so one scenario cannot publish as another', () => {
    const cfg = config({ E2E_ENGINE: 'srs', PUBLISH_KEY_SECRET: GOLDEN_SECRET });

    const mine = srtIngestUrl(cfg, 'live/one');
    const theirs = srtIngestUrl(cfg, 'live/two');

    assert.notEqual(mine, theirs);
    assert.equal(mine.includes(GOLDEN_KEY), false, 'and neither is the key for some third stream');
  });

  /** The keyless shape is the one confirmed live, so it is pinned byte for byte against drift. */
  it('leaves both URLs exactly as they were when no secret is configured', () => {
    const srs = config({ E2E_ENGINE: 'srs', E2E_PORT_SLOT: '2' });
    const ome = config({ E2E_ENGINE: 'ome' });

    assert.equal(srtIngestUrl(srs), 'srt://203.0.113.10:10021?streamid=#!::r=live/stream,m=publish');
    assert.equal(srtIngestUrl(ome).includes('key'), false);
    assert.equal(srtIngestUrl(ome).includes('%'), false, 'and it is not encoded either');
  });

  /**
   * A secret the service would have refused at startup fails here instead, because the alternative
   * is every scenario timing out against an uploader that never came up.
   */
  it('refuses a secret too short for the service to have accepted', () => {
    assert.throws(() => config({ E2E_ENGINE: 'srs', PUBLISH_KEY_SECRET: 'too-short' }), /at least 32 characters/);
  });
});
