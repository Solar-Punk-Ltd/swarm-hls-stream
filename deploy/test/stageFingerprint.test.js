import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * The shape `entrypoint.sh` generates once ABR_ENABLED is true: the default vhost SRS always had,
 * plus a second one carrying the transcoded rungs, each with its own `hls` block.
 */
function abrSrsConf(defaultFragment, abrFragment, aofRatio = 10) {
  return [
    srsConf(defaultFragment, aofRatio),
    'vhost abr {',
    '  hls {',
    '    enabled         on;',
    `    hls_fragment    ${abrFragment};`,
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
    const { stdout } = await run(GATE, [
      '--gop',
      String(gop),
      '--conf-file',
      confPath,
      '--playlist-file',
      playlistPath,
    ]);
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

/**
 * ⛔⛔⛔ The gate read `hls_fragment` with one `re.search`, which returns the FIRST match. That was
 * correct only because `srs.conf` held exactly one vhost. `ABR_ENABLED=true` makes `entrypoint.sh`
 * generate a second one, so a proven gate would have fingerprinted a whole sitting off whichever
 * vhost's directive came first in the file and said nothing about the other.
 *
 * Refusing on disagreement rather than picking a rule for which one wins: the two vhosts serve
 * different streams, and which one a sitting is actually publishing through is not something this
 * file can see. A gate that guesses is the failure mode, not the fix.
 */
describe('stage-fingerprint and the ABR ladder', () => {
  it('accepts a ladder config whose vhosts agree, which is what the entrypoint generates', async () => {
    const { code } = await gate({ gop: '0.5', files: { conf: abrSrsConf(0.25, 0.25) } });

    assert.equal(code, 0);
  });

  it('refuses when the two vhosts disagree, rather than fingerprinting off whichever came first', async () => {
    const { code, output } = await gate({ gop: '0.5', files: { conf: abrSrsConf(0.25, 2.0) } });

    assert.equal(code, 1, 'a config with two answers cannot produce one fingerprint');
    assert.match(output, /hls_fragment/);
    assert.match(output, /0\.25/);
    assert.match(output, /2/);
  });

  it('names both values it found, so the operator knows which vhost to look at', async () => {
    const { output } = await gate({ gop: '0.5', files: { conf: abrSrsConf(0.25, 1.5) } });

    assert.match(output, /1\.5/);
  });

  it('refuses a disagreeing aof_ratio too, since the range it bounds is half the prediction', async () => {
    const conf = [
      srsConf(0.25, 10),
      'vhost abr {',
      '  hls {',
      '    hls_fragment    0.25;',
      '    hls_aof_ratio   2.1;',
      '  }',
      '}',
      '',
    ].join('\n');
    const { code, output } = await gate({ gop: '0.5', files: { conf } });

    assert.equal(code, 1);
    assert.match(output, /hls_aof_ratio/);
  });

  /**
   * The premise, read off the real files rather than off the fixture above.
   *
   * `abrSrsConf` is a hand-written stand-in, so on its own it proves the gate handles a two-vhost
   * config without proving the deployment produces one. This reads the template and the entrypoint
   * that generates the second vhost, so if ABR's config generation changes shape the reason for the
   * fix stops being true out loud rather than quietly.
   */
  it('is handed a config declaring hls_fragment more than once once the ladder is on', () => {
    const template = readFileSync(join(ROOT, 'engines/srs/srs.conf.template'), 'utf8');
    const entrypoint = readFileSync(join(ROOT, 'engines/srs/entrypoint.sh'), 'utf8');
    const inTemplate = (template.match(/^\s*hls_fragment\s/gm) ?? []).length;
    const inGeneratedVhost = (entrypoint.match(/^\s*hls_fragment\s/gm) ?? []).length;

    assert.ok(inTemplate >= 1, 'the default vhost stopped declaring a fragment');
    assert.ok(inGeneratedVhost >= 1, 'the generated ABR vhost stopped declaring its own fragment');
    assert.ok(
      inTemplate + inGeneratedVhost > 1,
      'one declaration only, so reading the first match would be safe and this whole arm is moot',
    );
  });

  /**
   * A ladder publishes five playlists, one per rung plus the source. The wrapper used to hand over
   * the newest single one, so four rungs went unchecked and a sitting could run on a profile nothing
   * had looked at.
   */
  it('judges every playlist it is given, not just the first', async () => {
    const dir = workspace();
    const confPath = join(dir, 'srs.conf');
    writeFileSync(confPath, srsConf(0.25, 10));
    const good = join(dir, 'rung-720p.m3u8');
    const bad = join(dir, 'rung-1080p.m3u8');
    writeFileSync(good, playlist(0.501, 12));
    writeFileSync(bad, playlist(2.0, 12));

    // ⛔ The bad one FIRST. The wrapper's argument parsing is last-wins, so passing it second would
    // let a gate that judges only the final `--playlist-file` refuse for the wrong reason and go
    // green without ever looking at more than one playlist.
    const result = await run(GATE, [
      '--gop',
      '0.5',
      '--conf-file',
      confPath,
      '--playlist-file',
      bad,
      '--playlist-file',
      good,
    ]).then(
      () => ({ code: 0, output: '' }),
      (error) => ({ code: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }),
    );

    assert.equal(result.code, 1, 'one rung publishing 2.0s against a 0.5s GOP is a mismatch');
    assert.match(result.output, /rung-1080p/);
  });

  it('reports which playlist it judged, so a passing ladder says what it covered', async () => {
    const dir = workspace();
    const confPath = join(dir, 'srs.conf');
    writeFileSync(confPath, srsConf(0.25, 10));
    const a = join(dir, 'rung-360p.m3u8');
    const b = join(dir, 'rung-720p.m3u8');
    writeFileSync(a, playlist(0.501, 12));
    writeFileSync(b, playlist(0.499, 12));

    const { stdout } = await run(GATE, [
      '--gop',
      '0.5',
      '--conf-file',
      confPath,
      '--playlist-file',
      a,
      '--playlist-file',
      b,
    ]);

    assert.match(stdout, /rung-360p/);
    assert.match(stdout, /rung-720p/);
  });
});

/**
 * The container path, which the file overrides above deliberately bypass.
 *
 * ⛔ A listing and a read are answered differently here because real `docker exec` does: `find ... |
 * head -n` emits paths and `cat` emits content. A stub that returned playlist text for both would
 * have the gate looking for a file called `#EXTM3U`, which is exactly how the driver's own stub
 * starved it of every playlist once the discovery became two steps.
 */
describe('stage-fingerprint reading a container', () => {
  /** A `docker` on PATH that answers the two reads the gate makes, per rung. */
  function fakeDocker(rungNames, secondsByRung = {}) {
    const dir = workspace();
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'docker'),
      `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] !== 'exec') process.exit(0);
const asked = argv[argv.length - 1] || '';
const rungs = ${JSON.stringify(rungNames)};
const seconds = ${JSON.stringify(secondsByRung)};
if (asked.includes('srs.conf')) {
  process.stdout.write('vhost __defaultVhost__ {\\n  hls {\\n    hls_fragment    0.25;\\n    hls_aof_ratio   10;\\n  }\\n}\\n');
} else if (asked.includes('-name') && asked.includes('m3u8')) {
  const limit = Number((asked.match(/head -(\\d+)/) || [])[1] || '1');
  process.stdout.write(rungs.slice(0, limit).map((r) => '/hls/live/' + r + '/index.m3u8').join('\\n') + '\\n');
} else if (asked.includes('m3u8')) {
  const rung = (asked.match(/live\\/([^/]+)\\//) || [])[1];
  let out = '#EXTM3U\\n';
  for (let i = 0; i < 12; i += 1) out += '#EXTINF:' + (seconds[rung] ?? '0.501') + ',\\nseg' + i + '.ts\\n';
  process.stdout.write(out);
}
process.exit(0);
`,
      { mode: 0o755 },
    );
    return bin;
  }

  async function containerGate(bin, extra = []) {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    try {
      const { stdout } = await run(GATE, ['--container', 'srs-1', '--gop', '0.5', ...extra], { env });
      return { code: 0, output: stdout };
    } catch (error) {
      return { code: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  }

  it('judges the newest playlist when no rung count is given, as it did before ABR existed', async () => {
    const { code, output } = await containerGate(fakeDocker(['live']));

    assert.equal(code, 0);
    assert.match(output, /live\.m3u8/, 'the rung has to be named, or a refusal cannot say which one');
  });

  it('judges one playlist per rung when the driver says how many there are', async () => {
    const { code, output } = await containerGate(fakeDocker(['r360', 'r720', 'r1080', 'r480']), ['--rungs', '4']);

    assert.equal(code, 0);
    for (const rung of ['r360', 'r720', 'r1080', 'r480']) {
      assert.match(output, new RegExp(`${rung}\\.m3u8`), `${rung} was never judged`);
    }
  });

  it('refuses when one rung of four is publishing the wrong length, and names that rung', async () => {
    const { code, output } = await containerGate(fakeDocker(['r360', 'r720', 'r1080', 'r480'], { r1080: '2.0' }), [
      '--rungs',
      '4',
    ]);

    assert.equal(code, 1);
    assert.match(output, /REFUSING TO START\. r1080\.m3u8/);
    assert.doesNotMatch(output, /REFUSING TO START\. r360/, 'the healthy rungs must not be blamed');
  });

  it('would have passed that same stage while judging one playlist, which is the hole this closes', async () => {
    // The bad rung is not the newest, so a gate reading only the newest never sees it.
    const { code } = await containerGate(fakeDocker(['r360', 'r720', 'r1080', 'r480'], { r1080: '2.0' }));

    assert.equal(code, 0, 'if this refuses, the test above no longer demonstrates anything');
  });

  it('rejects a rung count that is not a positive whole number', async () => {
    for (const bad of ['0', '-1', 'four', '']) {
      const { code } = await containerGate(fakeDocker(['live']), ['--rungs', bad]);
      assert.equal(code, 2, `--rungs ${JSON.stringify(bad)} was accepted`);
    }
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
