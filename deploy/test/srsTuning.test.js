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

/**
 * A piece of the shipped entrypoint, lifted out by shape so that a test runs the real code rather
 * than a copy of it. See `shippedGuard` below for what a second copy costs.
 */
function shippedBlock(pattern, what) {
  const found = pattern.exec(readFileSync(ENTRYPOINT, 'utf8'));
  assert.ok(found, `${ENTRYPOINT} no longer carries ${what}`);
  return found[1] ?? found[0];
}

const REQUIRE_NUMBER = /^require_number\(\) \{\n[\s\S]*?\n\}$/m;

/**
 * Where the ceiling is turned into the ratio SRS takes.
 *
 * ⛔ Replaying only the `sed -i ` lines was not enough, and the gap was invisible: the ratio's sed
 * line carried a `:-5.0` of its own, so this harness substituted that literal, the assertion that
 * the shipped ceiling is 2.5s passed against it, and deleting `aof_ratio_for` and its call left the
 * whole file green. The fallback is gone from the script and the derivation runs here instead, so
 * the number asserted below is the one a container gets.
 */
const HLS_TUNING = /^# --- hls tuning ---\n([\s\S]*?)^# --- end hls tuning ---$/m;

const REQUIRE_SECRET = /^require_secret\(\) \{\n[\s\S]*?\n\}$/m;

/**
 * The credential guard and every call the script makes to it.
 *
 * The calls are lifted as well as the definition, because a guard that is defined and never reached
 * is the shape this repository has just paid for: `require_compose_reads` sat in `_lib.sh` while two
 * probes called it from scripts that never sourced it, and nothing was red. If a call disappears
 * from the entrypoint the count below drops and this fails, rather than the refusal cases quietly
 * proving a function nothing runs.
 */
function shippedSecretChecks(expected) {
  const calls = readFileSync(ENTRYPOINT, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('require_secret '));
  assert.equal(calls.length, expected, `the entrypoint checks ${calls.length} credentials, not ${expected}`);
  return [shippedBlock(REQUIRE_SECRET, 'require_secret'), ...calls].join('\n');
}

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

  const program = [
    'set -e',
    `CONF=${JSON.stringify(conf)}`,
    shippedBlock(REQUIRE_NUMBER, 'require_number'),
    shippedSecretChecks(2),
    shippedBlock(HLS_TUNING, 'the hls tuning block'),
    ...localSeds,
  ].join('\n');

  // PATH and the case's own values, and nothing else of this machine's. Every value replayed here
  // is read from the environment with a `:-` default, so an ambient HLS_SEGMENT_MAX or HLS_AOF_RATIO
  // would decide what these cases assert.
  execFileSync('bash', ['-c', program], { env: { PATH: process.env.PATH, ...env }, stdio: 'pipe' });

  const rendered = readFileSync(conf, 'utf8');
  assert.notEqual(rendered, readFileSync(TEMPLATE, 'utf8'), 'the harness substituted nothing, so it proves nothing');
  return rendered;
}

const VALID = { SRS_WEBHOOK_TOKEN: 'x'.repeat(64) };

/**
 * The keyframe interval a broadcaster is told to publish, from two funded sittings on 2026-08-12
 * that bounded it on both sides. See `docs/bench/gop-sustain-2026-08-12.md` for why not larger and
 * `docs/bench/gop-floor-2026-08-12.md` for why not smaller.
 *
 * The engine cannot set this, since nothing here transcodes. It is a number the config has to be
 * able to *accept*, which is what the range test below checks.
 */
const RECOMMENDED_GOP_SECONDS = 0.5;

/**
 * How far a segment runs past its settled length before ramping back down to it.
 *
 * Measured 2026-08-12 across GOPs of 0.5, 1.0 and 2.0, which overshot by 0.136, 0.136 and 0.133
 * seconds. **It is a constant rather than a proportion of the GOP**, and it is invisible to any
 * summary that reports a median, because the median sits at the settled value.
 * See `docs/bench/shipped-fragment-validation-2026-08-12.md`.
 */
const SEGMENT_OVERSHOOT_S = 0.135;

/**
 * The longest keyframe interval a broadcaster is likely to send without being asked, which is OBS's
 * default. Not what we recommend, but what has to keep working when nobody read the docs.
 */
const LARGEST_UNINVITED_GOP_SECONDS = 2;

describe('the SRS latency knobs', () => {
  // ⛔ None of these values may equal a default asserted below, or the assertion passes against a
  // template that still hard-codes it. 0.75 is deliberately not 0.5.
  it('binds what the operator configured', () => {
    const conf = renderSrsConf({
      ...VALID,
      HLS_FRAGMENT: '0.75',
      HLS_AOF_RATIO: '3.3',
      HLS_WINDOW: '7.5',
      SRT_LATENCY: '120',
    });

    assert.match(conf, /hls_fragment\s+0\.75;/, 'the fragment has to reach srs.conf');
    assert.match(conf, /hls_aof_ratio\s+3\.3;/, 'the aof ratio has to reach srs.conf');
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

    // 0.5 from the 2026-08-12 funded sittings, which bounded the segment on both sides: a 0.5s GOP
    // beats a 2.0s one by 2.34s of latency and takes confirmed feed stalls from 3-of-3 to 0-of-3,
    // and a 0.25s GOP loses 18-21% of live-edge reads to 404. The fragment is a FLOOR on the segment
    // rather than the segment, so it has to sit at or below the GOP broadcasters are told to
    // publish, or their request is silently rounded up.
    assert.match(conf, /hls_fragment\s+0\.5;/);
    // The ceiling is 2.5s, and it is set in seconds now rather than as the ratio SRS takes, so what
    // is asserted is the product. It was 2.1s for weeks, which turned out to be 35ms short of what a
    // 2.0s GOP needs. See the overshoot test below. The ratio read here is derived from
    // HLS_SEGMENT_MAX's own default by the block the harness replays, so moving that default moves
    // this number, which is what the dead `:-5.0` in the sed line used to hide.
    const shippedRatio = Number(conf.match(/hls_aof_ratio\s+([\d.]+);/)[1]);
    assert.equal(Number((0.5 * shippedRatio).toFixed(3)), 2.5);
    assert.match(conf, /hls_window\s+15;/);
    assert.match(conf, /latency\s+200;/);
  });

  /**
   * The ceiling has to clear `GOP + overshoot`, not the GOP.
   *
   * A segment overruns its settled length by a constant before settling back, so a ceiling set to the
   * GOP itself force-closes the overshooting ones: SRS cuts without a keyframe, and the segment after
   * the cut cannot begin on one. Both the pre-#155 pair (1.0 x 2.1) and #155's own (0.5 x 4.2) gave
   * exactly 2.1s, which is 35ms under what a 2.0s GOP needs, and a 2.0s GOP measured mode 2.117 with
   * a 1.861-2.219 spread against a clean 2.000 when the ceiling was out of the way.
   */
  it('ships a ceiling that clears the largest uninvited GOP plus its overshoot', () => {
    const conf = renderSrsConf({ ...VALID, HLS_FRAGMENT: '', HLS_WINDOW: '', SRT_LATENCY: '' });
    const fragment = Number(conf.match(/hls_fragment\s+([\d.]+);/)[1]);
    const ratio = Number(conf.match(/hls_aof_ratio\s+([\d.]+);/)[1]);
    const needed = LARGEST_UNINVITED_GOP_SECONDS + SEGMENT_OVERSHOOT_S;

    assert.ok(
      fragment * ratio >= needed,
      `the ceiling is ${(fragment * ratio).toFixed(3)}s and a ${LARGEST_UNINVITED_GOP_SECONDS}s GOP ` +
        `needs ${needed.toFixed(3)}s, so its overshooting segments are force-closed without a keyframe`,
    );
  });

  /**
   * The pair is a range, not two numbers. SRS cuts on the first keyframe at or after the fragment and
   * force-closes at `fragment * aof_ratio` whether one arrived or not, so a GOP outside
   * `[fragment, fragment * aof_ratio]` is either rounded up or yields keyframeless segments. Measured
   * over 20 arms in `docs/bench/gop-vs-fragment-2026-08-12.md`, and the ceiling half of that rule
   * once invalidated twelve runs.
   *
   * This is the check the config did not have: the shipped fragment was 1.0 while the profile two
   * funded sittings selected is a 0.5s GOP, so the recommendation could not be produced by the
   * defaults and nothing said so.
   */
  it('ships a range that contains the GOP broadcasters are told to publish', () => {
    const conf = renderSrsConf({ ...VALID, HLS_FRAGMENT: '', HLS_WINDOW: '', SRT_LATENCY: '' });
    const fragment = Number(conf.match(/hls_fragment\s+([\d.]+);/)[1]);
    const ratio = Number(conf.match(/hls_aof_ratio\s+([\d.]+);/)[1]);

    assert.ok(
      RECOMMENDED_GOP_SECONDS >= fragment && RECOMMENDED_GOP_SECONDS <= fragment * ratio,
      `a ${RECOMMENDED_GOP_SECONDS}s GOP is outside the shipped [${fragment}, ${fragment * ratio}] range, ` +
        'so the profile we recommend cannot be produced by the config we ship',
    );
    assert.equal(
      Math.ceil(fragment / RECOMMENDED_GOP_SECONDS) * RECOMMENDED_GOP_SECONDS,
      RECOMMENDED_GOP_SECONDS,
      'the shipped fragment rounds the recommended GOP up into a longer segment',
    );
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
    return shippedBlock(REQUIRE_NUMBER, 'require_number, so there is no guard to test');
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
 * The two credentials this entrypoint writes into srs.conf.
 *
 * ⛔ `&` is the dangerous one and it is silent. sed expands a bare `&` in a replacement to the whole
 * match, so a token of `ab&cd` reaches the config as `abSRS_WEBHOOK_TOKEN_PLACEHOLDERcd`. SRS starts,
 * every webhook is rejected by the uploader as unauthorised, nothing in any log says the token was
 * mangled, and the symptom reads as the uploader refusing SRS. `/` is this file's delimiter and
 * crash-loops the container instead, which is at least loud. An operator reaching for
 * `openssl rand -base64 32` rather than the `-hex 32` the file recommends gets one or both in most
 * outputs.
 */
describe('the credentials the entrypoint splices into its config', () => {
  /**
   * What the render printed on standard error when it refused.
   *
   * ⛔ Not `assert.throws(..., /must not contain/)`. The error a failed `execFileSync` raises carries
   * the whole command in its message, and the command here is the shipped script, so that regex
   * matches the guard's own source text and passes however the run actually died. Measured with the
   * guard deliberately neutered: the slash case stayed green on a sed crash.
   */
  function renderRefusal(env) {
    try {
      renderSrsConf(env);
    } catch (error) {
      return String(error.stderr ?? '');
    }
    return assert.fail('the entrypoint wrote a config instead of refusing');
  }

  for (const [name, bad, why] of [
    ['SRS_WEBHOOK_TOKEN', `ab&cd${'0'.repeat(58)}`, 'an ampersand, which sed expands to the whole match'],
    ['SRS_WEBHOOK_TOKEN', `ab/cd${'0'.repeat(58)}`, 'a slash, which ends the substitution'],
    ['SRT_PASSPHRASE', 'pass&phrase', 'an ampersand'],
  ]) {
    it(`refuses a ${name} carrying ${why}`, () => {
      const refusal = renderRefusal({ ...VALID, [name]: bad });

      assert.match(refusal, new RegExp(`^${name} must not contain`, 'm'));
      assert.doesNotMatch(refusal, new RegExp(bad.slice(0, 5)), 'the refusal printed the credential');
    });
  }

  /**
   * The other half, without which a guard that refused everything would pass all three cases above
   * and no deployment could start. A hex secret is what the file tells the operator to generate, and
   * it has to reach all three hook URLs unchanged.
   */
  it('writes a hex token into every hook URL, unchanged', () => {
    const token = 'a3f9'.repeat(16);

    const conf = renderSrsConf({ SRS_WEBHOOK_TOKEN: token });

    assert.doesNotMatch(conf, /SRS_WEBHOOK_TOKEN_PLACEHOLDER/);
    assert.equal(conf.split(`token=${token};`).length - 1, 3, 'the token did not reach all three hooks verbatim');
  });
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

  /**
   * Names the entrypoint reads from its environment, which is the list that has to arrive. The ABR
   * knobs are included because ABR_VBV_SECONDS reached neither compose file and nothing caught it.
   * Only the `${NAME:-default}` form counts: a bare `${ABR_GOP}` is computed here, not read from the
   * environment, so requiring the default is what keeps that one out of the list.
   */
  function knobsTheEntrypointReads() {
    const entrypoint = readFileSync(ENTRYPOINT, 'utf8');
    return [...entrypoint.matchAll(/\$\{(HLS_[A-Z_]+|SRT_[A-Z_]+|ABR_[A-Z_]+):-/g)].map((m) => m[1]);
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
