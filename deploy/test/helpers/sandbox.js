import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEPLOY_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ROOT_DIR = dirname(DEPLOY_DIR);

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

/** The one implementation of "create a bee data dir", which `deploy.sh` runs on either host. */
const INIT_NODE = 'init-node.sh';

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

/**
 * What the stubbed `git` answers, so a test can assert a deploy carried these exact values rather
 * than only that some key was written.
 *
 * ⛔ A sandbox is an `mkdtemp` outside any checkout, so a real `git` there answers "not a git
 * repository" for every question and every computed value comes out empty. Empty is ALSO what a
 * legitimately git-less deploy produces, which is a case the scripts have to survive. Without a stub
 * the two are indistinguishable and a test could not tell a working computation from a dead one.
 *
 * `GIT_STUB_DIRTY=1` makes `status --porcelain` report a modified file, and `GIT_STUB_FAIL=1` makes
 * every call exit non-zero, which is the git-less host.
 */
export const GIT_STUB = {
  head: '1111111111111111111111111111111111111111',
  clientTree: '2222222222222222222222222222222222222222',
  sharedTree: '3333333333333333333333333333333333333333',
};

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
  cpSync(join(ROOT_DIR, 'nodes', INIT_NODE), join(root, 'nodes', INIT_NODE));
  writeFileSync(join(deploy, 'config.json'), JSON.stringify(config, null, 2));
  for (const [name, contents] of Object.entries(envFiles)) {
    writeFileSync(join(root, name), contents);
  }

  // Stands in for the remote host's filesystem. `ssh` runs what it is handed with HOME pointed here,
  // so the deployment-exists guard in that script passes and the sweep under it actually runs.
  //
  // Seeded with what `sync_to_remote` would have left, because `rsync` is stubbed out: a remote
  // deploy expects `deploy/` and the node init script to be there before it runs anything.
  const remoteHome = join(root, 'remote-home');
  const remoteBase = join(remoteHome, REMOTE_DIR);
  mkdirSync(join(remoteBase, 'deploy'), { recursive: true });
  cpSync(join(DEPLOY_DIR, 'scripts'), join(remoteBase, 'deploy', 'scripts'), { recursive: true });

  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  const localJournal = join(root, 'docker-argv');
  const remoteJournal = join(root, 'docker-argv-remote');
  const sshJournal = join(root, 'ssh-argv');
  const gitJournal = join(root, 'git-argv');
  writeFileSync(localJournal, '');
  writeFileSync(remoteJournal, '');
  writeFileSync(sshJournal, '');
  writeFileSync(gitJournal, '');
  writeFileSync(envFileJournal(localJournal), '');
  writeFileSync(envFileJournal(remoteJournal), '');

  writeNodeStub(join(binDir, 'git'), gitStub(gitJournal));
  writeNodeStub(join(binDir, 'docker'), dockerStub(localJournal, project));
  writeStub(join(binDir, 'ssh'), sshStub(remoteHome, remoteJournal, sshJournal));
  writeNodeStub(join(binDir, 'rsync'), rsyncStub(remoteHome));
  // The ssh stub runs the command string it is handed, which `clean.sh --all` uses to reach
  // `sudo rm -rf`. Before that change the string was discarded and no privileged command could
  // escape; now one can, and this docstring's promise that nothing here may reach a live stack is
  // only true with a `sudo` on PATH that confers nothing. Without it the suite either prompts for a
  // password with no TTY or, on a machine with a cached timestamp, runs the removal as root.
  writeStub(join(binDir, 'sudo'), '#!/bin/sh\nexec "$@"\n');

  return {
    root,
    binDir,
    remoteHome,
    /** Path to one of the real deploy scripts, copied into this sandbox. */
    scriptPath: (name) => join(deploy, 'scripts', name),
    /** Every `docker` invocation made on this host, in order, one argv per entry. */
    calls: () => readLines(localJournal),
    /** Every `docker` invocation made by the script `ssh` carried to the remote host. */
    remoteCalls: () => readLines(remoteJournal),
    /** Every `ssh` invocation, as the single string the far side's login shell would receive. */
    sshCommands: () => readLines(sshJournal),
    /** Every `git` invocation, in order, one argv per entry. */
    gitCalls: () => readLines(gitJournal),
    /** The contents of every `--env-file` compose was pointed at on this host, concatenated. */
    envFiles: () => readFileSync(envFileJournal(localJournal), 'utf8'),
    /** The same, for the compose call the script ran through `ssh` on the far side. */
    remoteEnvFiles: () => readFileSync(envFileJournal(remoteJournal), 'utf8'),
    /** Whether a path exists on the stand-in remote host, relative to its home directory. */
    remoteHas: (relative) => existsSync(join(remoteHome, relative)),
  };
}

/**
 * Runs one of the real deploy scripts inside a sandbox whose `docker` and `ssh` are stubs, and
 * reports how it exited instead of throwing. Half of what these scripts are asked to prove is that
 * they refuse, so the exit code is an assertion rather than an error.
 */
export async function runScript(sandbox, name, args = [], env = {}) {
  try {
    const ok = await execFileAsync('bash', [sandbox.scriptPath(name), ...args], {
      env: { ...process.env, ...env, PATH: `${sandbox.binDir}:${process.env.PATH ?? ''}` },
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
export async function runScriptOk(sandbox, name, args = [], env = {}) {
  const run = await runScript(sandbox, name, args, env);
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

/**
 * Where the docker stub records the contents of an env file it was pointed at, derived from the argv
 * journal so the ssh stub's `DOCKER_STUB_JOURNAL` carries the remote one across without knowing it.
 */
function envFileJournal(journal) {
  return `${journal}-env-files`;
}

function readLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/**
 * Answers the handful of questions the deploy scripts ask git, from fixed values, and records every
 * call so a test can assert WHICH revision and WHICH paths were asked about.
 *
 * `-C <dir>` is how the scripts point git at the repo root. The sandbox is not one, so the directory
 * is journalled and otherwise ignored.
 */
function gitStub(journal) {
  return `const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(journal)}, argv.join(' ') + '\\n');

if (process.env.GIT_STUB_FAIL === '1') {
  process.stderr.write('fatal: not a git repository\\n');
  process.exit(128);
}

const rest = argv[0] === '-C' ? argv.slice(2) : argv;
const REVISIONS = {
  'HEAD': ${JSON.stringify(GIT_STUB.head)},
  'HEAD:packages/client': ${JSON.stringify(GIT_STUB.clientTree)},
  'HEAD:packages/shared': ${JSON.stringify(GIT_STUB.sharedTree)},
};

if (rest[0] === 'rev-parse') {
  const answer = REVISIONS[rest[1]];
  if (answer === undefined) {
    process.stderr.write('fatal: not a valid object name: ' + rest[1] + '\\n');
    process.exit(128);
  }
  console.log(answer);
  process.exit(0);
}

if (rest[0] === 'status') {
  if (process.env.GIT_STUB_DIRTY === '1') {
    console.log(' M packages/client/src/main.tsx');
  }
  process.exit(0);
}

process.exit(0);
`;
}

/**
 * Answers `ps -aq` from a fixed inventory, honouring both label filters, and records every call.
 * Honouring the service label is what lets the same stub tell a scoped sweep from a project-wide
 * one: a stub that ignored it would report success for either.
 */
function dockerStub(defaultJournal, project) {
  return `const fs = require('fs');
const argv = process.argv.slice(2);
const journal = process.env.DOCKER_STUB_JOURNAL || ${JSON.stringify(defaultJournal)};
fs.appendFileSync(journal, argv.join(' ') + '\\n');

// Compose interpolates build args and environment from its --env-file, so a value a deploy COMPUTED
// is only ever in that file and never in the argv above. Recorded here because both deploy paths
// delete the file the moment compose returns, leaving a test nothing to read afterwards.
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--env-file' && argv[i + 1] && fs.existsSync(argv[i + 1])) {
    fs.appendFileSync(journal + '-env-files', fs.readFileSync(argv[i + 1], 'utf8'));
  }
}

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
 * Runs what it is handed instead of only recording it, with HOME inside the sandbox so the remote
 * path executes for real. Recording the text alone would let the remote sweep drift from the local
 * one while a substring assertion still passed.
 *
 * `bash -c "$*"` is not a shortcut, it is the fidelity that makes SEC-21 visible. Real ssh joins its
 * remaining arguments into one string and hands it to the far side's LOGIN SHELL, which word-splits
 * and evaluates it — which is why an unquoted interpolation into an ssh command line is a command
 * injection rather than a quoting nit. A stub that exec'd an argv would model something ssh does not
 * do and would report the injection as safe. The `bash -s` callers keep working through the same
 * line: stdin is inherited, so their heredoc still reaches the shell they asked for.
 */
/**
 * Copies, rather than reporting success and doing nothing.
 *
 * A stub that only exits 0 makes every file the remote path depends on someone else's problem, and
 * the sandbox then has to pre-seed them. That hides the dependency: `deploy.sh` runs
 * `nodes/init-node.sh` on the far side and is the only thing that puts it there, and with both the
 * seed and a no-op rsync in place, deleting that line left the whole suite green while a first
 * deploy to a fresh host would abort at exit 127.
 *
 * Faithful enough for the four call sites in `sync_to_remote` and no further: trailing slashes carry
 * rsync's copy-the-contents meaning, `--exclude` consumes its value so it is not mistaken for a
 * source, and a source that does not exist is skipped rather than throwing, because the uploader's
 * `dist/` is not built in these tests.
 */
function rsyncStub(remoteHome) {
  return `const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--exclude') { i++; continue; }
  if (argv[i].startsWith('-')) continue;
  positional.push(argv[i]);
}

const destination = positional.pop() || '';
const colon = destination.indexOf(':');
if (colon === -1) process.exit(0);

let target = destination.slice(colon + 1);
if (target.startsWith('~/')) target = path.join(${JSON.stringify(remoteHome)}, target.slice(2));
const targetIsDirectory = target.endsWith('/');

for (const source of positional) {
  if (!fs.existsSync(source)) continue;
  const sourceIsContents = source.endsWith('/');
  const to = sourceIsContents || !targetIsDirectory ? target : path.join(target, path.basename(source));
  fs.mkdirSync(sourceIsContents || targetIsDirectory ? target : path.dirname(target), { recursive: true });
  fs.cpSync(source, to, { recursive: true });
}
`;
}

function sshStub(remoteHome, remoteJournal, argvJournal) {
  return `#!/bin/bash
# Drop ssh's own options and then the target, leaving exactly the string the far side would get.
# \`-t\` is not hypothetical: clean.sh uses it, and treating it as the target would hand the login
# shell a command starting with the hostname.
#
# The options that take a separate value have to consume it, or the value becomes the target and the
# real target becomes the first word of the command. Nothing in the tree passes one today. The list
# is here because the day someone adds \`-o ConnectTimeout=5\` to health.sh, the wrong behaviour is
# a silently different command rather than a failure.
while [ $# -gt 0 ]; do
  case "$1" in
    -[bcDEeFIiJLlmOopQRSWw]) shift 2 ;;
    -*) shift ;;
    *) shift; break ;;
  esac
done
printf '%s\\n' "$*" >> ${JSON.stringify(argvJournal)}
[ $# -eq 0 ] && exit 0
export HOME=${JSON.stringify(remoteHome)} DOCKER_STUB_JOURNAL=${JSON.stringify(remoteJournal)}
bash -c "$*"
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
