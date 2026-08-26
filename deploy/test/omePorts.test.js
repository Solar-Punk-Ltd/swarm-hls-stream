import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPLATE = join(ROOT, 'engines/ome/Server.xml.template');
const COMPOSE = join(ROOT, 'deploy/docker-compose.yml');
const STANDALONE = join(ROOT, 'engines/ome/docker-compose.yml');
const ENTRYPOINT = join(ROOT, 'engines/ome/entrypoint.sh');

/**
 * That OME binds the ports the operator configured. See OPS-30.
 *
 * `OME_SRT_PORT` and `OME_HLS_PORT` used to exist **only** as compose publish mappings, against a
 * `Server.xml.template` that hardcoded 10080 and 8081. On the bridge that difference is invisible,
 * because the mapping translates the fixed container port to whatever was asked for. Under
 * `network_mode: host`, which `docker-compose.host.yml` gives OME, compose discards the mapping and
 * the two variables became inert.
 *
 * Measured on the live stack on 2026-08-03: OME sat on 10080 while the publisher dialled 10091 and
 * the uploader polled 10092. Not one admission arrived, every scenario failed on its warmup, and
 * both container logs were empty, which reads as a dead engine rather than as a port that was never
 * applied. It also meant two OME stacks on one host always collided.
 *
 * These run the real entrypoint against the real template, because the defect lived precisely in the
 * gap between the two and reading either alone shows nothing wrong.
 */

const dirs = [];

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs the real entrypoint's substitution step and returns the Server.xml it produced. */
function renderServerXml(env) {
  const dir = mkdtempSync(join(tmpdir(), 'ome-conf-'));
  dirs.push(dir);
  const conf = join(dir, 'Server.xml');

  // The entrypoint execs OME at the end, so the substitutions are replayed here rather than the
  // script being run whole. Read out of the script itself so a substitution added there without a
  // case here is visible as an untested line rather than as silence.
  const script = readFileSync(ENTRYPOINT, 'utf8');
  const seds = script.split('\n').filter((line) => line.startsWith('sed -i '));
  assert.ok(seds.length >= 5, `expected the entrypoint to substitute at least 5 values, found ${seds.length}`);

  execFileSync('cp', [TEMPLATE, conf]);

  // BSD `sed -i` takes the backup suffix as its own argument and GNU `sed -i` does not, so the
  // entrypoint's own spelling edits nothing on macOS and would pass every assertion below against an
  // untouched template. Only the in-place flag is adapted. The substitution expressions, which are
  // the thing under test, run verbatim.
  const localSeds = process.platform === 'darwin' ? seds.map((line) => line.replace(/^sed -i /, "sed -i '' ")) : seds;

  execFileSync('bash', ['-c', `set -e\nCONF=${JSON.stringify(conf)}\n${localSeds.join('\n')}`], {
    env: { ...process.env, ...env },
  });

  const rendered = readFileSync(conf, 'utf8');
  assert.notEqual(rendered, readFileSync(TEMPLATE, 'utf8'), 'the harness substituted nothing, so it proves nothing');
  return rendered;
}

describe('the ports OME binds (OPS-30)', () => {
  it('binds what the operator configured', () => {
    const xml = renderServerXml({ OME_SRT_PORT: '10071', OME_HLS_PORT: '10092', OME_ADMISSION_SECRET: 'x'.repeat(64) });

    assert.match(xml, /<SRT>\s*<Port>10071<\/Port>/, 'the SRT port has to reach Server.xml');
    assert.match(xml, /<HLS>\s*<Port>10092<\/Port>/, 'the HLS port has to reach Server.xml');
  });

  /**
   * The degenerate case. Every assertion above would also pass if the template still hardcoded the
   * numbers this test happens to use, so the defaults have to differ from them and be reachable.
   */
  it('falls back to the documented defaults when neither is set', () => {
    const xml = renderServerXml({ OME_SRT_PORT: '', OME_HLS_PORT: '', OME_ADMISSION_SECRET: 'x'.repeat(64) });

    assert.match(xml, /<SRT>\s*<Port>10080<\/Port>/);
    assert.match(xml, /<HLS>\s*<Port>8081<\/Port>/);
  });

  it('leaves no port placeholder unsubstituted', () => {
    const xml = renderServerXml({ OME_SRT_PORT: '10071', OME_HLS_PORT: '10092', OME_ADMISSION_SECRET: 'x'.repeat(64) });

    assert.doesNotMatch(xml, /_PLACEHOLDER/, 'an unsubstituted placeholder makes OME refuse the config');
  });

  /**
   * The container half, over both compose files. The entrypoint cannot bind what compose never hands
   * it, and that was the actual defect: the variables were in `ports:` and nowhere else. This checked
   * only deploy/docker-compose.yml, so the standalone engines/ome file kept the fixed container ports
   * and the missing pass-through that OPS-30 was about, unseen on the `pnpm ome:host` path.
   */
  for (const composePath of [COMPOSE, STANDALONE]) {
    const where = composePath.slice(ROOT.length + 1);

    it(`passes both ports into the container environment from ${where}`, () => {
      const compose = readFileSync(composePath, 'utf8');
      const ome = compose.slice(compose.indexOf('\n  ome:'));

      assert.match(ome, /OME_SRT_PORT:\s*\$\{OME_SRT_PORT/, 'the container never sees the SRT port');
      assert.match(ome, /OME_HLS_PORT:\s*\$\{OME_HLS_PORT/, 'the container never sees the HLS port');
    });

    /**
     * Host and container port must be the same number now that OME binds the configured one. A
     * mapping onto a fixed container port is exactly what hid the defect, and it would now point at a
     * port nothing listens on.
     */
    it(`maps each published port onto itself in ${where}, not onto a fixed one`, () => {
      const compose = readFileSync(composePath, 'utf8');
      const ome = compose.slice(compose.indexOf('\n  ome:'));

      assert.match(ome, /\$\{OME_SRT_PORT:-10080\}:\$\{OME_SRT_PORT:-10080\}\/udp/);
      assert.match(ome, /\$\{OME_HLS_PORT:-8081\}:\$\{OME_HLS_PORT:-8081\}/);
    });
  }
});
