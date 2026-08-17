import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = join(ROOT, 'deploy/scripts');
const GATE = join(SCRIPTS, 'stage-fingerprint.sh');
const DRIVER = join(SCRIPTS, 'byte-source-arms.sh');

/**
 * The gate that refuses a sitting whose stage is not publishing the segment length it asked for.
 *
 * ⛔⛔⛔ Every test here asserts an EXIT CODE, and most of them assert a NON-ZERO one. The first
 * revision of this gate exited 0 without running and printed nothing, because a python comment
 * carrying an apostrophe closed the shell string it was embedded in. It passed every case it was
 * written to refuse, in silence. A test that only checked the happy path would have gone green on it,
 * which is why the refusals are the bulk of what follows.
 */

const cleanups = [];
after(() => cleanups.forEach((fn) => fn()));

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'stage-fingerprint-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function srsConf(fragment, aofRatio) {
  return [
    'vhost __defaultVhost__ {',
    '  hls {',
    '    enabled         on;',
    `    hls_fragment    ${fragment};`,
    `    hls_aof_ratio   ${aofRatio};`,
    '    hls_window      30;',
    '  }',
    '}',
    '',
  ].join('\n');
}

function playlist(duration, count) {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:1'];
  for (let i = 0; i < count; i += 1) {
    lines.push(`#EXTINF:${duration},`, `seg${i}.ts`);
  }
  return `${lines.join('\n')}\n`;
}

/** @returns The gate's exit code and combined output, never throwing, because a refusal is the point. */
async function gate({ fragment = 0.25, aofRatio = 10, segment = 0.501, segments = 12, gop = '0.5', files = {} }) {
  const dir = workspace();
  const confPath = join(dir, 'srs.conf');
  const playlistPath = join(dir, 'index.m3u8');
  writeFileSync(confPath, files.conf ?? srsConf(fragment, aofRatio));
  if (files.playlist !== null) {
    writeFileSync(playlistPath, files.playlist ?? playlist(segment, segments));
  }

  try {
    const { stdout } = await run(GATE, ['--gop', String(gop), '--conf-file', confPath, '--playlist-file', playlistPath]);
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

describe('stage-fingerprint accepts a stage that matches', () => {
  it('passes the shipping profile: hls_fragment 0.25 against a 0.5s GOP', async () => {
    const { code, output } = await gate({});
    assert.equal(code, 0);
    assert.match(output, /matches what the driver asked for/);
  });

  it('reports the observed median and the segment count it judged on', async () => {
    const { output } = await gate({ segments: 9 });
    assert.match(output, /observed median 0\.501s over 9 segments/);
  });

  it('accepts a stage whose fragment equals the GOP asked for', async () => {
    const { code } = await gate({ fragment: 2.0, aofRatio: 2.1, segment: 2.002, gop: '2.0' });
    assert.equal(code, 0);
  });
});

describe('stage-fingerprint refuses a stage that does not', () => {
  /**
   * ⛔⛔⛔ THE CASE THE GATE EXISTS FOR, and the one an earlier design passed.
   *
   * Comparing the observed median against `ceil(fragment/gop)*gop` agrees with itself by
   * construction: a neighbour sets `hls_fragment 2.0`, SRS publishes 2.0s segments, the prediction
   * says 2.0s, and the check is satisfied while the driver labels everything 0.5s. The driver's GOP
   * has to be the reference, never the stage's own arithmetic.
   */
  it('refuses when hls_fragment forces a segment longer than the GOP asked for', async () => {
    const { code, output } = await gate({ fragment: 2.0, aofRatio: 2.1, segment: 2.002, gop: '0.5' });
    assert.equal(code, 1);
    assert.match(output, /REFUSING TO START/);
    assert.match(output, /cannot be published on this stage at all/);
  });

  it('refuses when the stage publishes something other than its own config predicts', async () => {
    const { code, output } = await gate({ segment: 1.001 });
    assert.equal(code, 1);
    assert.match(output, /not delivering the keyframe cadence/);
  });

  it('refuses a GOP that leaves the range hls_aof_ratio allows', async () => {
    const { code, output } = await gate({ gop: '5.0' });
    assert.equal(code, 1);
    assert.match(output, /outside the \[0\.25, 2\.5\]/);
  });

  it('keeps a small keyframe overshoot inside tolerance', async () => {
    const { code } = await gate({ segment: 0.53 });
    assert.equal(code, 0);
  });
});

describe('stage-fingerprint refuses when it learned nothing', () => {
  /**
   * ⛔⛔⛔ "I could not find a playlist" and "the playlist shows nothing wrong" are the same return
   * value to anything that only looks for a mismatch. Every one of these is a way of learning
   * nothing, and a gate that approves on them protects nothing while reporting that it did.
   */
  it('refuses when the config carries no hls_fragment', async () => {
    const { code, output } = await gate({ files: { conf: 'vhost x {\n  hls {\n    hls_window 30;\n  }\n}\n' } });
    assert.equal(code, 1);
    assert.match(output, /hls_fragment and hls_aof_ratio is not in the config/);
  });

  it('refuses an empty config rather than reading absent directives as zero', async () => {
    const { code, output } = await gate({ files: { conf: '' } });
    assert.equal(code, 1);
    assert.match(output, /empty or unreadable/);
  });

  it('refuses a playlist file that does not exist', async () => {
    const { code, output } = await gate({ files: { playlist: null } });
    assert.notEqual(code, 0);
    assert.match(output, /holds 0 segments/);
  });

  it('refuses a playlist holding no #EXTINF at all', async () => {
    const { code, output } = await gate({ files: { playlist: '#EXTM3U\n#EXT-X-TARGETDURATION:1\n' } });
    assert.notEqual(code, 0);
    assert.match(output, /holds 0 segments/);
  });

  /**
   * Separated from a refusal so the driver can retry a broadcast that has only just started, and
   * distinguishable by exit code so it cannot retry a real mismatch until its deadline runs out.
   */
  it('reports too few segments as not-ready (3) rather than as a verdict', async () => {
    const { code, output } = await gate({ segments: 3 });
    assert.equal(code, 3);
    assert.match(output, /NOT READY/);
    assert.doesNotMatch(output, /REFUSING TO START/);
  });

  it('refuses rather than defaulting when no GOP is given', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'srs.conf'), srsConf(0.25, 10));
    writeFileSync(join(dir, 'index.m3u8'), playlist(0.501, 12));
    const result = await run(GATE, ['--conf-file', join(dir, 'srs.conf'), '--playlist-file', join(dir, 'index.m3u8')])
      .then(() => ({ code: 0 }))
      .catch((error) => ({ code: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }));
    assert.equal(result.code, 2);
    assert.match(result.output, /--gop is required/);
  });
});

describe('byte-source-arms consults the gate before it spends a broadcast', () => {
  const driver = readFileSync(DRIVER, 'utf8');

  it('calls the fingerprint and stops the publisher when it refuses', () => {
    assert.match(driver, /stage_matches_the_gop_we_asked_for/);
    assert.match(driver, /stage-fingerprint\.sh/);
  });

  /**
   * ⛔ The gate has to sit between the broadcast reaching ingest and the first arm running. Earlier is
   * impossible, because nothing has published a playlist yet. Later means a mismatch is discovered
   * after arms have already been paid for.
   */
  it('runs it after the stream is live and before the publisher lead', () => {
    const live = driver.indexOf('wait_for_active_stream;');
    const check = driver.indexOf('if ! stage_matches_the_gop_we_asked_for');
    const lead = driver.indexOf('leading the first arm by');
    assert.ok(live > 0 && check > 0 && lead > 0, 'all three anchors are present');
    assert.ok(check > live, 'the fingerprint runs after the stream reaches the uploader');
    assert.ok(check < lead, 'the fingerprint runs before the sitting waits out the publisher lead');
  });

  it('retries only the not-ready code, so a real mismatch is not retried to the deadline', () => {
    assert.match(driver, /\[ "\$\{status\}" -ne 3 \] && return 1/);
  });

  it('reads the GOP it passed the publisher, not a second copy of the number', () => {
    assert.match(driver, /--gop "\$\{GOP_SECONDS\}"/);
  });
});
