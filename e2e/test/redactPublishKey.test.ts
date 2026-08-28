import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { type E2EConfig, loadConfig } from '../src/config.js';
import { srtIngestUrl } from '../src/harness/engine.js';
import { redactPublishKey } from '../src/harness/redactPublishKey.js';

/**
 * The publish key is a live credential and the harness prints the URL carrying it.
 *
 * One such line reached a transcript on 2026-08-28. A transcript is not a place a credential can be
 * taken back out of, so the key it named has to be treated as spent, and rotating
 * `PUBLISH_KEY_SECRET` invalidates every key derived from it at once rather than only that one.
 *
 * Driven off the real `srtIngestUrl` for both engines rather than hand-written strings, because the
 * two spellings do not look alike and only one of them contains the literal `key=`. OME
 * percent-encodes the whole nested publish URL, so its key arrives as `key%3D`, and a redactor
 * matching only the plain spelling would leave an OME run leaking exactly as before while every test
 * written against SRS passed. The golden vector below is the one `test/engine.test.ts`,
 * `packages/stream-uploader` and `deploy/test/publishKey.test.js` all pin.
 */

const GOLDEN_SECRET = 'publish-key-secret-0123456789abcdef';
const GOLDEN_KEY = '2d1e344ecb833667c936399866349fbc';
const GOLDEN_PATH = 'video/demo';

const roots: string[] = [];

after(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function config(env: NodeJS.ProcessEnv): E2EConfig {
  const rootDir = mkdtempSync(join(tmpdir(), 'e2e-redact-'));
  roots.push(rootDir);
  return loadConfig({ env: { E2E_PUBLIC_HOST: '203.0.113.10', E2E_STREAM_PATH: GOLDEN_PATH, ...env }, rootDir });
}

describe('redacting the publish key out of what a run prints', () => {
  it('takes the key out of the SRS ingest URL the smoke test prints', () => {
    const url = srtIngestUrl(config({ E2E_ENGINE: 'srs', PUBLISH_KEY_SECRET: GOLDEN_SECRET }));

    const printed = redactPublishKey(url);

    assert.equal(printed.includes(GOLDEN_KEY), false, `the key survived: ${printed}`);
    assert.match(printed, /key=2d1e…REDACTED/);
  });

  /**
   * OME's is the spelling a `key=` matcher misses. The nested publish URL is percent-encoded whole,
   * which is the form measured working against real OME, so the credential arrives as `key%3D`.
   */
  it('takes the key out of the OME ingest URL, where it is percent-encoded', () => {
    const url = srtIngestUrl(config({ E2E_ENGINE: 'ome', PUBLISH_KEY_SECRET: GOLDEN_SECRET }));

    const printed = redactPublishKey(url);

    assert.equal(printed.includes(GOLDEN_KEY), false, `the key survived: ${printed}`);
    assert.match(printed, /key%3D2d1e…REDACTED/);
  });

  /**
   * A redacted URL still has a job to do. It is printed so an operator can see which host, port and
   * stream a run is dialing, and a redactor that swallows those replaces a leak with a useless line.
   */
  it('keeps everything about the URL that is not the credential', () => {
    const cfg = config({ E2E_ENGINE: 'srs', PUBLISH_KEY_SECRET: GOLDEN_SECRET });
    const url = srtIngestUrl(cfg);

    const printed = redactPublishKey(url);

    assert.equal(printed, url.replace(GOLDEN_KEY, `2d1e${'…REDACTED'}`));
    assert.match(printed, new RegExp(`^srt://203\\.0\\.113\\.10:${cfg.ports.srt}\\?streamid=#!::r=video/demo\\?key=`));
    assert.match(printed, /,m=publish$/);
  });

  it('leaves a keyless URL exactly as it was, on either engine', () => {
    for (const engine of ['srs', 'ome']) {
      const url = srtIngestUrl(config({ E2E_ENGINE: engine }));

      assert.equal(redactPublishKey(url), url, `the keyless ${engine} URL was rewritten`);
    }
  });

  it('leaves text carrying no key at all untouched', () => {
    const line = '  uploader: {"status":"ok","activeStreams":1}';

    assert.equal(redactPublishKey(line), line);
  });

  /**
   * The first four characters stay so two runs are still tellable apart in a log, which is what the
   * line is printed for. Four is far short of the 128 bits the key is, so it narrows nothing.
   */
  it('keeps the first four characters, so two different keys still read as different', () => {
    const mine = redactPublishKey('?key=aaaabbbbccccddddeeeeffff00001111');
    const theirs = redactPublishKey('?key=zzzzbbbbccccddddeeeeffff00001111');

    assert.equal(mine, '?key=aaaa…REDACTED');
    assert.notEqual(mine, theirs);
  });

  it('redacts every key in a line, not only the first', () => {
    const two = `first srt://h:1?streamid=#!::r=a/b?key=${GOLDEN_KEY},m=publish then ?key=${GOLDEN_KEY}`;

    const printed = redactPublishKey(two);

    assert.equal(printed.includes(GOLDEN_KEY), false, `a key survived: ${printed}`);
    assert.equal(printed.match(/…REDACTED/g)?.length, 2);
  });

  /** A short value is still a credential, and a redactor that only handles long ones is not one. */
  it('redacts a value shorter than the four characters it keeps', () => {
    assert.equal(redactPublishKey('?key=ab,m=publish'), '?key=ab…REDACTED,m=publish');
  });

  it('leaves an empty value alone, because there is no credential there to hide', () => {
    assert.equal(redactPublishKey('?key=,m=publish'), '?key=,m=publish');
  });

  /**
   * The second channel the URL reaches an operator through, and the one nobody writes deliberately.
   * ffmpeg names the URL it could not reach in its own stderr, which the bench prints on a publisher
   * that died before the uploader announced anything.
   */
  it('redacts the URL ffmpeg quotes back in an error, and keeps the diagnosis', () => {
    const said =
      `[srt @ 0x7f9] Connection to srt://203.0.113.10:10021?streamid=#!::r=video/demo?key=${GOLDEN_KEY},` +
      'm=publish failed: Connection timed out';

    const printed = redactPublishKey(said);

    assert.equal(printed.includes(GOLDEN_KEY), false, `the key survived: ${printed}`);
    assert.match(printed, /Connection timed out$/);
  });

  it('does not disturb a query parameter that is not the key', () => {
    const line = '?streamid=abc&monkeyed=no&app=live';

    assert.equal(redactPublishKey(line), line);
  });
});
