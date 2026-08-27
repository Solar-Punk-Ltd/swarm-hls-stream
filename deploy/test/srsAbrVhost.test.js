import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPLATE = join(ROOT, 'engines/srs/srs.conf.template');
const ENTRYPOINT = join(ROOT, 'engines/srs/entrypoint.sh');

const INGEST_VHOST = '__defaultVhost__';
const LADDER_VHOST = 'abr';

/**
 * That the vhost the ABR rungs land on is configured at all.
 *
 * The entrypoint writes this vhost itself, as a heredoc inside `if abr_enabled`, and appends it to
 * the template through a placeholder. Nothing in the repo rendered it. `srsTuning.test.js` covers
 * the same knobs on the ingest vhost, but its harness replays only the script's `sed -i ` lines,
 * and the ladder vhost is built by the half of the script those lines are not in. `ABR_ENABLED`
 * appeared in no deploy test, so the generated block was unexercised end to end.
 *
 * Reading the first match would not have caught it either. With a ladder enabled the config holds
 * two of every HLS directive, the ingest vhost's first and the ladder's second, so a regex over the
 * whole file reports the ingest value twice and passes while the ladder runs on anything at all.
 * Every assertion here is scoped to one vhost block for that reason. That is the same defect that
 * made the stage-fingerprint gate read a four-rung ladder as compliant off one playlist.
 *
 * Two values carry real consequences:
 *
 *   - `hls_aof_ratio` force-closes a segment at `hls_fragment * hls_aof_ratio` whether a keyframe
 *     arrived or not. SRS's own default is 2.1. If the generated vhost lost this directive the rungs
 *     would silently run on that default while the ingest vhost ran on the configured value, cutting
 *     segments mid-GOP with no keyframe in them.
 *   - The webhook token is what the stream-uploader checks before it trusts a callback. If it went
 *     missing from these three hooks the uploader would reject every one of them, and no rung would
 *     ever be published, with a healthy-looking SRS and no error on this side.
 *
 * This runs the whole real entrypoint rather than a slice of it, relocated to a temp directory and
 * with the final `exec` landing on a stub, so the heredoc, the `if`, the `require_*` guards and
 * every substitution all run as they do in the container.
 */

const dirs = [];

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const VALID = { SRS_WEBHOOK_TOKEN: 'x'.repeat(64), ABR_ENABLED: 'true' };

/**
 * Runs the real entrypoint end to end and returns the srs.conf it produced.
 *
 * Only the install prefix is rewritten. The script hard-codes `/usr/local/srs`, which the test host
 * does not have and must not write to, so the copy points at a temp tree holding the real template.
 * Everything else runs verbatim, including the `exec` at the end: that is why `objs/srs` exists as a
 * stub, and why a non-zero exit from the script fails the test rather than being swallowed.
 */
function renderLadderConf(env) {
  const dir = mkdtempSync(join(tmpdir(), 'srs-abr-'));
  dirs.push(dir);

  mkdirSync(join(dir, 'conf'), { recursive: true });
  mkdirSync(join(dir, 'objs'), { recursive: true });
  cpSync(TEMPLATE, join(dir, 'conf/srs.conf.template'));

  writeFileSync(join(dir, 'objs/srs'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'objs/srs'), 0o755);

  const script = readFileSync(ENTRYPOINT, 'utf8');
  assert.ok(
    script.includes('/usr/local/srs/conf/srs.conf.template'),
    'the entrypoint no longer reads the prefix this harness rewrites',
  );
  // BSD `sed -i` takes the backup suffix as its own argument and GNU `sed -i` does not, so the
  // entrypoint's own spelling edits nothing on macOS. Only the in-place flag is adapted; every
  // expression runs verbatim. The placeholder assertion below is what catches this going wrong,
  // because an unedited config would otherwise satisfy a badly written test.
  const relocated = script.replaceAll('/usr/local/srs', dir);
  const portable = process.platform === 'darwin' ? relocated.replaceAll('sed -i ', "sed -i '' ") : relocated;
  writeFileSync(join(dir, 'entrypoint.sh'), portable);

  execFileSync('bash', [join(dir, 'entrypoint.sh')], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });

  const rendered = readFileSync(join(dir, 'conf/srs.conf'), 'utf8');
  assert.ok(!rendered.includes('PLACEHOLDER'), 'the entrypoint left a placeholder unsubstituted');
  return rendered;
}

/**
 * One `vhost <name> { ... }` block, by brace depth.
 *
 * Scoping every assertion to a single block is the point of this helper: a ladder config holds two
 * of every HLS directive, and a match over the whole file silently reads the ingest vhost's.
 */
function vhostBlock(conf, name) {
  const start = conf.indexOf(`vhost ${name} {`);
  assert.notEqual(start, -1, `no 'vhost ${name}' block in the generated config`);

  let depth = 0;
  for (let i = conf.indexOf('{', start); i < conf.length; i += 1) {
    if (conf[i] === '{') {
      depth += 1;
    }
    if (conf[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return conf.slice(start, i + 1);
      }
    }
  }
  assert.fail(`the 'vhost ${name}' block is never closed`);
}

/** One directive's value from within a single vhost block, refusing a repeat rather than taking the first. */
function directive(block, name) {
  const matches = [...block.matchAll(new RegExp(`^\\s*${name}\\s+([^;]+);`, 'gm'))].map((m) => m[1].trim());
  assert.equal(matches.length, 1, `expected exactly one '${name}' in the block, found ${matches.length}`);
  return matches[0];
}

describe('the generated ABR vhost', () => {
  it("carries the configured aof ratio rather than SRS's own default", () => {
    const conf = renderLadderConf({ ...VALID, HLS_FRAGMENT: '0.5', HLS_AOF_RATIO: '3.0', HLS_WINDOW: '15' });
    const ladder = vhostBlock(conf, LADDER_VHOST);

    assert.equal(directive(ladder, 'hls_aof_ratio'), '3.0');
    assert.notEqual(directive(ladder, 'hls_aof_ratio'), '2.1', "the rungs fell back to SRS's default ratio");
  });

  it('agrees with the ingest vhost on fragment, ratio and window', () => {
    const conf = renderLadderConf({ ...VALID, HLS_FRAGMENT: '0.5', HLS_AOF_RATIO: '4.0', HLS_WINDOW: '12' });
    const ingest = vhostBlock(conf, INGEST_VHOST);
    const ladder = vhostBlock(conf, LADDER_VHOST);

    // A rung that force-closes on a different product from the ingest vhost produces segments the
    // single-rendition path does not, which is the whole reason the directive is repeated here.
    for (const name of ['hls_fragment', 'hls_aof_ratio', 'hls_window']) {
      assert.equal(directive(ladder, name), directive(ingest, name), `${name} differs between the two vhosts`);
    }
  });

  it('puts the webhook token on every hook the rungs call', () => {
    const token = 'a'.repeat(64);
    const conf = renderLadderConf({ ...VALID, SRS_WEBHOOK_TOKEN: token, HLS_FRAGMENT: '0.5' });
    const ladder = vhostBlock(conf, LADDER_VHOST);

    for (const hook of ['on_publish', 'on_unpublish', 'on_hls']) {
      assert.match(
        directive(ladder, hook),
        new RegExp(`[?&]token=${token}$`),
        `${hook} on the ladder vhost carries no token`,
      );
    }
  });

  it('leaves no ladder vhost behind when no ladder is enabled', () => {
    const conf = renderLadderConf({ SRS_WEBHOOK_TOKEN: 'x'.repeat(64), ABR_ENABLED: 'false', HLS_FRAGMENT: '0.5' });

    assert.doesNotMatch(conf, /vhost\s+abr\s*\{/, 'a single-rendition deployment grew a ladder vhost');
    assert.doesNotMatch(conf, /transcode\s*\{/, 'a single-rendition deployment grew a transcode block');
  });
});

describe('the listen line the ladder input dials', () => {
  /**
   * SRS builds the transcode INPUT itself, and an SRT-bridged source carries no RTMP port, so the
   * input always dials 127.0.0.1:1935 whatever `listen` says: the input-side twin of the `[port]`
   * trap the republish already works around (ossrs/srs#4496). Found live 2026-08-27: a slot-7
   * deployment listened on 10072, every rung's ffmpeg died on `Connection refused` to 1935, and
   * not one segment reached the uploader while SRS and the uploader both reported healthy.
   */
  it('adds a loopback 1935 listener when the slot moves RTMP off 1935', () => {
    const conf = renderLadderConf({ ...VALID, SRS_RTMP_PORT: '10072' });
    assert.match(conf, /^listen\s+10072 127\.0\.0\.1:1935;$/m);
  });

  it('does not bind 1935 twice when the deployment is unslotted', () => {
    const conf = renderLadderConf({ ...VALID });
    assert.match(conf, /^listen\s+1935;$/m);
  });

  it('leaves a single-rendition deployment alone', () => {
    const conf = renderLadderConf({
      SRS_WEBHOOK_TOKEN: VALID.SRS_WEBHOOK_TOKEN,
      ABR_ENABLED: 'false',
      SRS_RTMP_PORT: '10072',
    });
    assert.match(conf, /^listen\s+10072;$/m);
  });
});
