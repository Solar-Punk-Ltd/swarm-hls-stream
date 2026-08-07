import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPLATE = join(ROOT, 'engines/srs/srs.conf.template');
const COMPOSE = join(ROOT, 'deploy/docker-compose.yml');
const ENTRYPOINT = join(ROOT, 'engines/srs/entrypoint.sh');

/**
 * That SRS's latency knobs reach its config.
 *
 * `HLS_FRAGMENT` and `HLS_WINDOW` were configurable on `main` and this branch hard-coded them back
 * into the template at 1.5 and 22.5. Nothing failed: the entrypoint kept substituting into
 * placeholders that were no longer there, compose kept not passing them, and the only symptom was
 * that setting either in an env file did nothing at all. That is the same shape as OPS-30, where two
 * port variables existed as publish mappings and never reached the container.
 *
 * `HLS_FRAGMENT` matters more than the rest put together. The segment is the single largest hop in
 * the measured split, at 2000ms of a 5000ms total on the deployment host, and a viewer waits a whole
 * one before anything can be fetched.
 *
 * These run the real entrypoint's substitutions against the real template, because the defect lived
 * exactly in the gap between the two and reading either alone shows nothing wrong.
 */

const dirs = [];

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs the real entrypoint's substitution step and returns the srs.conf it produced. */
function renderSrsConf(env) {
  const dir = mkdtempSync(join(tmpdir(), 'srs-conf-'));
  dirs.push(dir);
  const conf = join(dir, 'srs.conf');

  // Read out of the script itself, so a substitution added there without a case here shows up as an
  // untested line rather than as silence. The entrypoint execs SRS at the end, so the lines are
  // replayed rather than the script being run whole.
  const script = readFileSync(ENTRYPOINT, 'utf8');
  const seds = script.split('\n').filter((line) => line.startsWith('sed -i '));
  assert.ok(seds.length >= 8, `expected the entrypoint to substitute at least 8 values, found ${seds.length}`);

  execFileSync('cp', [TEMPLATE, conf]);

  // BSD `sed -i` takes the backup suffix as its own argument and GNU `sed -i` does not, so the
  // entrypoint's own spelling edits nothing on macOS and would pass every assertion below against an
  // untouched template. Only the in-place flag is adapted; the expressions run verbatim.
  const localSeds = process.platform === 'darwin' ? seds.map((line) => line.replace(/^sed -i /, "sed -i '' ")) : seds;

  execFileSync('bash', ['-c', `set -e\nCONF=${JSON.stringify(conf)}\n${localSeds.join('\n')}`], {
    env: { ...process.env, ...env },
  });

  const rendered = readFileSync(conf, 'utf8');
  assert.notEqual(rendered, readFileSync(TEMPLATE, 'utf8'), 'the harness substituted nothing, so it proves nothing');
  return rendered;
}

const VALID = { SRS_WEBHOOK_TOKEN: 'x'.repeat(64) };

describe('the SRS latency knobs', () => {
  it('binds what the operator configured', () => {
    const conf = renderSrsConf({ ...VALID, HLS_FRAGMENT: '0.5', HLS_WINDOW: '7.5', SRT_LATENCY: '120' });

    assert.match(conf, /hls_fragment\s+0\.5;/, 'the fragment has to reach srs.conf');
    assert.match(conf, /hls_window\s+7\.5;/, 'the window has to reach srs.conf');
    assert.match(conf, /latency\s+120;/, 'the SRT latency has to reach srs.conf');
  });

  /**
   * The degenerate case. Every assertion above would also pass against a template that still
   * hard-coded the numbers the test happens to use, so the defaults have to differ from them and be
   * reachable. This is the regression itself: the hard-coded values were exactly these.
   */
  it('falls back to the documented defaults when none is set', () => {
    const conf = renderSrsConf({ ...VALID, HLS_FRAGMENT: '', HLS_WINDOW: '', SRT_LATENCY: '' });

    // 1.0 rather than main's 1.5, from the 2026-08-03 sweep. `LIVE_SYNC_DURATION_S` is 6 for this
    // exact default, so the two move together or a viewer rebuffers.
    assert.match(conf, /hls_fragment\s+1\.0;/);
    assert.match(conf, /hls_window\s+15;/);
    assert.match(conf, /latency\s+200;/);
  });

  /**
   * Scoped to the three knobs. `PASSPHRASE_PLACEHOLDER` is substituted inside a conditional branch
   * that the harness above deliberately does not replay, since it is either filled or deleted
   * depending on whether encryption is configured, so it legitimately survives here.
   */
  it('leaves no tuning placeholder unsubstituted', () => {
    const conf = renderSrsConf({ ...VALID, HLS_FRAGMENT: '1', HLS_WINDOW: '15', SRT_LATENCY: '80' });

    assert.doesNotMatch(
      conf,
      /(HLS_FRAGMENT|HLS_WINDOW|SRT_LATENCY)_PLACEHOLDER/,
      'an unsubstituted placeholder makes SRS refuse the config',
    );
  });

  /**
   * The container half, and the half that was actually broken. The entrypoint cannot substitute what
   * compose never hands it, and on this branch compose handed it nothing.
   */
  it('compose passes every knob into the container environment', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const srs = compose.slice(compose.indexOf('\n  srs:'), compose.indexOf('\n  ome:'));

    assert.match(srs, /HLS_FRAGMENT:\s*\$\{HLS_FRAGMENT/, 'the container never sees the fragment');
    assert.match(srs, /HLS_WINDOW:\s*\$\{HLS_WINDOW/, 'the container never sees the window');
    assert.match(srs, /SRT_LATENCY:\s*\$\{SRT_LATENCY/, 'the container never sees the SRT latency');
  });

  /**
   * These land inside a `sed` s/// expression, where `/` ends the substitution early and `&` expands
   * to the whole match. Under `restart: unless-stopped` a corrupt config is a crash loop rather than
   * a message, so the guard refuses instead of splicing.
   */
  /**
   * The entrypoint's own `require_number`, lifted out of the shipped script.
   *
   * It used to be pasted in here as a second copy of the same bash, which meant these cases proved
   * the copy rejected bad input and never touched the guard that ships: breaking the real one left
   * every case green. That is the failure `logLevel.ts` records about asserting a constant against
   * the same constant the implementation returns. Task #104.
   */
  function shippedGuard() {
    const declared = /^require_number\(\) \{\n[\s\S]*?\n\}$/m.exec(readFileSync(ENTRYPOINT, 'utf8'));
    assert.ok(declared, `${ENTRYPOINT} no longer declares require_number, so there is no guard to test`);
    return declared[0];
  }

  const runGuard = (name, value) =>
    execFileSync('bash', ['-c', `${shippedGuard()}\nrequire_number ${name} "$${name}"`], {
      env: { ...process.env, [name]: value },
      stdio: 'pipe',
    });

  for (const [name, bad] of [
    ['HLS_FRAGMENT', '1/2'],
    ['HLS_WINDOW', '22.5&'],
    ['SRT_LATENCY', '200; rm -rf /'],
  ]) {
    it(`refuses a ${name} that is not a number`, () => {
      assert.throws(() => runGuard(name, bad), /must be a positive number/);
    });
  }

  /**
   * Without this, a guard that refused everything would pass every case above, and a deployment
   * setting a perfectly good fragment length would crash-loop instead of starting.
   */
  for (const good of ['0.5', '1', '22.5', '200']) {
    it(`lets a value of ${good} through`, () => {
      assert.doesNotThrow(() => runGuard('HLS_FRAGMENT', good));
    });
  }
});

/**
 * That both compose files pass every knob the entrypoint reads.
 *
 * There are two of them and they enumerate rather than inherit, which is deliberate: `env_file`
 * would hand `PUBLISH_KEY_SECRET` to the publisher-facing engine image, and that secret has no
 * per-stream revocation. See SEC-28. The cost of enumerating is that a variable added to one list is
 * silently missing from the other, and a variable the container never sees falls back to a default
 * with nothing reporting a problem.
 *
 * It has now happened twice over the same two files. OBS-20's healthcheck went into
 * `deploy/docker-compose.yml` and not `engines/srs/docker-compose.yml`, and the four latency knobs
 * did the same, so on the `pnpm srs:host` and `pnpm srs:local` path setting `HLS_FRAGMENT=0.5`
 * produced 1.0s segments. This compares the two lists instead of trusting whoever edits one of them.
 */
describe('both SRS compose files carry the same tuning knobs', () => {
  const STANDALONE = join(ROOT, 'engines/srs/docker-compose.yml');

  /** Names the entrypoint reads from its environment, which is the list that has to arrive. */
  function knobsTheEntrypointReads() {
    const entrypoint = readFileSync(ENTRYPOINT, 'utf8');
    return [...entrypoint.matchAll(/\$\{(HLS_[A-Z_]+|SRT_[A-Z_]+)(?::-|\})/g)].map((m) => m[1]);
  }

  for (const composePath of [COMPOSE, STANDALONE]) {
    it(`passes every knob into the container from ${composePath.slice(ROOT.length + 1)}`, () => {
      const compose = readFileSync(composePath, 'utf8');

      for (const knob of new Set(knobsTheEntrypointReads())) {
        assert.match(
          compose,
          new RegExp(`^\\s*${knob}:\\s*\\$\\{${knob}`, 'm'),
          `${knob} is read by the entrypoint and never passed here, so it silently keeps its default`,
        );
      }
    });
  }

  it('gives each knob the same default in both files, so which one started the engine cannot matter', () => {
    const [primary, standalone] = [COMPOSE, STANDALONE].map((p) => readFileSync(p, 'utf8'));

    for (const knob of new Set(knobsTheEntrypointReads())) {
      const pattern = new RegExp(`^\\s*${knob}:\\s*\\$\\{${knob}:-([^}]*)\\}`, 'm');
      assert.equal(
        standalone.match(pattern)?.[1],
        primary.match(pattern)?.[1],
        `${knob} defaults differently in the two compose files, so the same env produces two pictures`,
      );
    }
  });
});
