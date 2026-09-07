import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScriptOk, sourceLib } from './helpers/sandbox.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Running an engine on a config file of the operator's own.
 *
 * Three pieces have to agree for `SRS_CONF_FILE=/some/file` to do anything: `build_compose_files`
 * has to add the override, the override has to mount the file where the entrypoint looks, and the
 * entrypoint has to copy from there rather than from the template. Each is trivially right on its
 * own and the failure lives in the seams: a mount target that drifts one path segment from what the
 * entrypoint checks leaves every deployment silently on the template, which is exactly what a
 * deployment without the variable looks like.
 */

const ENGINES = [
  {
    name: 'srs',
    variable: 'SRS_CONF_FILE',
    override: 'docker-compose.srs-conf.yml',
    entrypoint: 'engines/srs/entrypoint.sh',
  },
  {
    name: 'ome',
    variable: 'OME_CONF_FILE',
    override: 'docker-compose.ome-conf.yml',
    entrypoint: 'engines/ome/entrypoint.sh',
  },
];

const dirs = [];

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  removeSandboxes();
});

/** The `CUSTOM=` path the entrypoint checks for a mounted file. */
function customPathOf(entrypoint) {
  const match = /^CUSTOM=(\S+)$/m.exec(readFileSync(join(ROOT, entrypoint), 'utf8'));
  assert.ok(match, `${entrypoint} no longer names the CUSTOM path`);
  return match[1];
}

/** The container side of the one volume the override mounts. */
function mountTargetOf(override) {
  const text = readFileSync(join(ROOT, 'deploy', override), 'utf8');
  const match = /^\s*-\s*\$\{(\w+)\}:(\S+?):ro\s*$/m.exec(text);
  assert.ok(match, `${override} no longer mounts a file from a variable`);
  return { variable: match[1], target: match[2] };
}

/**
 * The lines between the config source markers, run on their own with the three paths pointed at a
 * scratch directory. The rest of the script substitutes and then execs the engine, which is what the
 * other entrypoint tests replay line by line, and neither half proves the copy at the top.
 */
function chooseConfigSource(entrypoint, { custom }) {
  const script = readFileSync(join(ROOT, entrypoint), 'utf8');
  const block = /# --- config source ---\n([\s\S]*?)# --- end config source ---/.exec(script);
  assert.ok(block, `${entrypoint} lost its config source markers`);

  const dir = mkdtempSync(join(tmpdir(), 'engine-conf-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'template'), 'from the template\n');
  if (custom) {
    writeFileSync(join(dir, 'custom'), custom);
  }

  const out = execFileSync(
    'bash',
    [
      '-c',
      [
        'set -e',
        `CONF=${JSON.stringify(join(dir, 'conf'))}`,
        `TEMPLATE=${JSON.stringify(join(dir, 'template'))}`,
        `CUSTOM=${JSON.stringify(join(dir, 'custom'))}`,
        block[1],
        'printf "%s" "$CONF_SOURCE"',
      ].join('\n'),
    ],
    { encoding: 'utf8' },
  );
  return { conf: readFileSync(join(dir, 'conf'), 'utf8'), source: out };
}

describe('build_compose_files and the engine config overrides', () => {
  for (const engine of ENGINES) {
    it(`adds the ${engine.name} override only when ${engine.variable} is set`, async () => {
      const sandbox = makeSandbox();

      const without = await sourceLib(sandbox, 'build_compose_files /d');
      const withFile = await sourceLib(sandbox, `${engine.variable}=/srv/my.conf build_compose_files /d`);

      assert.equal(without.exitCode, 0, without.stderr);
      assert.equal(withFile.exitCode, 0, withFile.stderr);
      assert.ok(!without.stdout.includes(engine.override), `the override was added with no file set: ${without.stdout}`);
      assert.ok(withFile.stdout.includes(`-f /d/${engine.override}`), `the override was not added: ${withFile.stdout}`);
      assert.ok(withFile.stdout.startsWith('-f /d/docker-compose.yml'), 'the base file has to come first');
    });
  }

  it('leaves an empty value meaning the template', async () => {
    const sandbox = makeSandbox();

    const run = await sourceLib(sandbox, 'SRS_CONF_FILE= build_compose_files /d');

    assert.equal(run.exitCode, 0, run.stderr);
    assert.ok(!run.stdout.includes('srs-conf'), run.stdout);
  });
});

describe('the mount lands where the entrypoint looks', () => {
  for (const engine of ENGINES) {
    it(`for ${engine.name}`, () => {
      const mount = mountTargetOf(engine.override);

      assert.equal(mount.variable, engine.variable);
      assert.equal(mount.target, customPathOf(engine.entrypoint));
    });
  }
});

describe('the entrypoint copies the custom file when it is there', () => {
  for (const engine of ENGINES) {
    it(`${engine.name} runs on the custom file`, () => {
      const { conf, source } = chooseConfigSource(engine.entrypoint, { custom: 'mine\n' });

      assert.equal(conf, 'mine\n');
      assert.match(source, /custom/);
    });

    it(`${engine.name} runs on the template without one`, () => {
      const { conf, source } = chooseConfigSource(engine.entrypoint, { custom: null });

      assert.equal(conf, 'from the template\n');
      assert.match(source, /template/);
    });
  }
});

describe('a remote deploy ships the override it names', () => {
  /**
   * The sandbox copies `docker-compose.yml` alone and the stubbed `rsync` skips a source that is not
   * there, so without this seed an override the sync forgot would look exactly like one that was
   * never named.
   */
  function seedComposeFiles(sandbox) {
    const deployDir = join(ROOT, 'deploy');
    for (const file of readdirSync(deployDir).filter((name) => /^docker-compose.*\.yml$/.test(name))) {
      cpSync(join(deployDir, file), join(sandbox.root, 'deploy', file));
    }
  }

  /** The `-f` values of the compose call the far side ran, a `~` it kept resolved as the stub's HOME. */
  function remoteComposeFiles(sandbox) {
    const compose = sandbox.remoteCalls().find((call) => call.startsWith('compose ') && call.includes(' up '));
    assert.ok(compose, `no compose call reached the remote host:\n${sandbox.remoteCalls().join('\n')}`);
    const argv = compose.split(' ');
    return argv
      .flatMap((word, index) => (word === '-f' ? [argv[index + 1]] : []))
      .map((path) => (path.startsWith('~/') ? join(sandbox.remoteHome, path.slice(2)) : path));
  }

  for (const engine of ENGINES) {
    it(`for ${engine.name}`, async () => {
      const sandbox = makeSandbox({
        config: ALL_REMOTE,
        envFiles: { '.env': `STAMP=stamp\nSTREAM_KEY=key\n${engine.variable}=/srv/my.conf\n` },
      });
      seedComposeFiles(sandbox);

      await runScriptOk(sandbox, 'deploy.sh', [engine.name]);

      const files = remoteComposeFiles(sandbox);
      assert.ok(
        files.some((path) => basename(path) === engine.override),
        `the far side's compose call does not name ${engine.override}: ${files.join(' ')}`,
      );
      for (const path of files) {
        assert.ok(
          existsSync(path),
          `${basename(path)} is named by the far side's compose call and no rsync carries it to the deployment host`,
        );
      }
    });
  }
});
