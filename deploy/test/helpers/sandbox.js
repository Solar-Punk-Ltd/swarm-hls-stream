import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEPLOY_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Containers the stubbed `docker` reports, one per compose service. The ids carry their service so
 * an assertion can say which stack members a sweep removed rather than only how many.
 */
const INVENTORY = [
  { id: 'c-stream-uploader', service: 'stream-uploader' },
  { id: 'c-srs', service: 'srs' },
  { id: 'c-client', service: 'client' },
  { id: 'c-bee-uploader', service: 'bee-uploader' },
  { id: 'c-bee-gateway', service: 'bee-gateway' },
];

const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';

/** Where `clean.sh` puts a deployment on a remote host, as `_lib.sh` hardcodes it. */
const REMOTE_DIR = 'swarm-hls-stream';

const ALL_LOCAL = {
  services: {
    srs: 'localhost',
    ome: 'localhost',
    'stream-uploader': 'localhost',
    'bee-uploader': 'localhost',
    'bee-gateway': 'localhost',
    client: 'localhost',
  },
};

export const ALL_REMOTE = {
  services: {
    srs: 'streamhost',
    ome: 'streamhost',
    'stream-uploader': 'streamhost',
    'bee-uploader': 'streamhost',
    'bee-gateway': 'streamhost',
    client: 'streamhost',
  },
};

/** Env files written into a sandbox root, keyed by filename. Enough for the scripts to load and run. */
const DEFAULT_ENV_FILES = { '.env': 'STAMP=stamp\nSTREAM_KEY=key\n' };

const sandboxes = [];

export function removeSandboxes() {
  for (const dir of sandboxes) {
    rmSync(dir, { recursive: true, force: true });
  }
  sandboxes.length = 0;
}

/**
 * A throwaway copy of `deploy/` with a stubbed `docker` and `ssh` ahead of the real ones on PATH.
 *
 * The scripts derive every path from their own location, so copying them is what lets a test point
 * at fixture config without touching the repo's own. It is also the only safe way to drive
 * `clean.sh` at all: the real script removes containers and volumes, and nothing here may reach a
 * live stack.
 */
export function makeSandbox({ project = 'default', config = ALL_LOCAL, envFiles = DEFAULT_ENV_FILES } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-clean-'));
  sandboxes.push(root);

  const deploy = join(root, 'deploy');
  cpSync(join(DEPLOY_DIR, 'scripts'), join(deploy, 'scripts'), { recursive: true });
  cpSync(join(DEPLOY_DIR, 'docker-compose.yml'), join(deploy, 'docker-compose.yml'));
  writeFileSync(join(deploy, 'config.json'), JSON.stringify(config, null, 2));
  for (const [name, contents] of Object.entries(envFiles)) {
    writeFileSync(join(root, name), contents);
  }

  // Stands in for the remote host's filesystem. `ssh` runs the script it is handed with HOME pointed
  // here, so the deployment-exists guard in that script passes and the sweep under it actually runs.
  const remoteHome = join(root, 'remote-home');
  mkdirSync(join(remoteHome, REMOTE_DIR, 'deploy'), { recursive: true });

  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  const localJournal = join(root, 'docker-argv');
  const remoteJournal = join(root, 'docker-argv-remote');
  writeFileSync(localJournal, '');
  writeFileSync(remoteJournal, '');

  writeNodeStub(join(binDir, 'docker'), dockerStub(localJournal, project));
  writeStub(join(binDir, 'ssh'), sshStub(remoteHome, remoteJournal, join(root, 'ssh-argv')));

  return {
    root,
    binDir,
    /** Path to one of the real deploy scripts, copied into this sandbox. */
    scriptPath: (name) => join(deploy, 'scripts', name),
    /** Every `docker` invocation made on this host, in order, one argv per entry. */
    calls: () => readLines(localJournal),
    /** Every `docker` invocation made by the script `ssh` carried to the remote host. */
    remoteCalls: () => readLines(remoteJournal),
  };
}

/**
 * Runs one of the real deploy scripts inside a sandbox whose `docker` and `ssh` are stubs, and
 * reports how it exited instead of throwing. Half of what these scripts are asked to prove is that
 * they refuse, so the exit code is an assertion rather than an error.
 */
export async function runScript(sandbox, name, args = []) {
  try {
    const ok = await execFileAsync('bash', [sandbox.scriptPath(name), ...args], {
      env: { ...process.env, PATH: `${sandbox.binDir}:${process.env.PATH ?? ''}` },
    });
    return { stdout: ok.stdout, stderr: ok.stderr, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code ?? -1 };
  }
}

/**
 * Sources the real `_lib.sh` from a sandbox and runs `snippet` against it, for the helpers whose
 * whole behaviour is what they leave in the shell rather than what they call out to.
 */
export async function sourceLib(sandbox, snippet) {
  return runShell(sandbox, `source ${JSON.stringify(sandbox.scriptPath('_lib.sh'))}\n${snippet}`);
}

async function runShell(sandbox, script) {
  try {
    const ok = await execFileAsync('bash', ['-c', script], {
      env: { ...process.env, PATH: `${sandbox.binDir}:${process.env.PATH ?? ''}` },
    });
    return { stdout: ok.stdout, stderr: ok.stderr, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code ?? -1 };
  }
}

/** For the paths where the script is supposed to succeed, so a crash cannot pass as a silent no-op. */
export async function runScriptOk(sandbox, name, args = []) {
  const run = await runScript(sandbox, name, args);
  assert.equal(run.exitCode, 0, `${name} failed: ${run.stdout}${run.stderr}`);
  return run;
}

function writeStub(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/**
 * A stub written in JavaScript, launched so that Node cannot mistake the stubbed command's arguments
 * for its own.
 *
 * `#!/usr/bin/env node` is not safe here: Node keeps parsing its own options past the script path, so
 * a `docker compose --env-file <path>` call makes Node try to load that path as an env file and exit
 * before the stub records anything. `node -- <script>` is what stops the parsing. Measured on Node
 * 22.22.3 with a missing path: the stub died with `node: <path>: not found` and journalled no call,
 * which reads exactly like a script that correctly issued no docker command at all.
 */
function writeNodeStub(path, body) {
  // `.cjs` rather than `.js`: the stub uses `require`, and a sandbox that ever landed under a
  // `"type": "module"` package would otherwise fail to load it.
  writeFileSync(`${path}.cjs`, body);
  writeStub(path, '#!/bin/sh\nexec node -- "$0.cjs" "$@"\n');
}

function readLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/**
 * Answers `ps -aq` from a fixed inventory, honouring both label filters, and records every call.
 * Honouring the service label is what lets the same stub tell a scoped sweep from a project-wide
 * one: a stub that ignored it would report success for either.
 */
function dockerStub(defaultJournal, project) {
  return `const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_STUB_JOURNAL || ${JSON.stringify(defaultJournal)}, argv.join(' ') + '\\n');

if (argv[0] !== 'ps' && argv[0] !== 'volume') {
  process.exit(0);
}

const inventory = ${JSON.stringify(INVENTORY)};
const wanted = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--filter' && argv[i + 1] && argv[i + 1].startsWith('label=')) {
    const [key, value] = argv[i + 1].slice('label='.length).split('=');
    wanted[key] = value;
  }
}

if (wanted[${JSON.stringify(PROJECT_LABEL)}] !== ${JSON.stringify(project)}) {
  process.exit(0);
}

if (argv[0] === 'volume') {
  if (argv[1] === 'ls') {
    console.log('v-uploader-state');
  }
  process.exit(0);
}

const service = wanted[${JSON.stringify(SERVICE_LABEL)}];
for (const container of inventory) {
  if (service === undefined || container.service === service) {
    console.log(container.id);
  }
}
`;
}

/**
 * Runs the script it is handed instead of only recording it, with HOME inside the sandbox so the
 * remote path executes for real. Recording the text alone would let the remote sweep drift from the
 * local one while a substring assertion still passed.
 */
function sshStub(remoteHome, remoteJournal, argvJournal) {
  return `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(argvJournal)}
SCRIPT=$(cat)
HOME=${JSON.stringify(remoteHome)} DOCKER_STUB_JOURNAL=${JSON.stringify(remoteJournal)} bash -s <<<"$SCRIPT"
`;
}

/** The ids passed to every `docker rm -f`, flattened, which is what a destructive sweep shows up as. */
export function forceRemovedIds(calls) {
  return calls
    .filter((call) => call.startsWith('rm -f '))
    .flatMap((call) => call.slice('rm -f '.length).split(/\s+/))
    .filter((id) => id.length > 0);
}

/** Volume names passed to `docker volume rm`, which is the data-loss path rather than the container one. */
export function removedVolumes(calls) {
  return calls
    .filter((call) => call.startsWith('volume rm '))
    .flatMap((call) => call.slice('volume rm '.length).split(/\s+/))
    .filter((name) => name.length > 0);
}
