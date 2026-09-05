import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'scripts', 'bee-publishers.sh');
const SCRIPT_NAME = 'bee-publishers.sh';
const PROFILE = 'latbench';

/** Slot 7 is the latbench stage's, so the ports below are the ones an operator would recognise. */
const PORT_SLOT = '7';
const PORTS = { '360p': 10075, '480p': 11071, '720p': 11073, '1080p': 11075 };

/** Synthetic. A live batch id in a committed fixture is a stamp anyone can spend against. */
const BATCHES = {
  '360p': 'a'.repeat(64),
  '480p': 'b'.repeat(64),
  '720p': 'c'.repeat(64),
  '1080p': 'd'.repeat(64),
};

/** A batch that clears both of the thresholds this script shares with the uploader's postage gate. */
function healthy(batchID) {
  return { batchID, exists: true, usable: true, batchTTL: 5 * 24 * 3600, utilizationRatio: 0.1, depth: 22 };
}

function run(args) {
  try {
    return { code: 0, out: execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/**
 * A `curl` answering `/stamps` for all four rungs' nodes, one fixture per port, honouring
 * `--write-out` the way curl does: the format string is appended to the body, which is how the
 * script reads an HTTP status at all. A stub that ignored it would leave every answer looking like a
 * 200 and the error-envelope tests below could not fail.
 *
 * @param {object} sandbox
 * @param {object} [options]
 * @param {Record<number, string>} [options.bodies] A literal body per port, replacing the fixture.
 * @param {Record<number, number>} [options.statuses] The HTTP status per port, 200 by default.
 */
function stubCurl(sandbox, { bodies = {}, statuses = {} } = {}) {
  const answers = Object.fromEntries(
    Object.entries(PORTS).map(([rung, port]) => [
      port,
      bodies[port] ?? JSON.stringify({ stamps: [healthy(BATCHES[rung])] }),
    ]),
  );
  const codes = Object.fromEntries(Object.entries(PORTS).map(([, port]) => [port, statuses[port] ?? 200]));
  const path = join(sandbox.binDir, 'curl');
  writeFileSync(
    `${path}.cjs`,
    `const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('http')) || '';
const answers = ${JSON.stringify(answers)};
const codes = ${JSON.stringify(codes)};
const port = (url.match(/:(\\d+)\\//) || [])[1] || '';
if (!(port in answers) || !url.endsWith('/stamps')) {
  process.stderr.write('curl stub was asked for ' + url + '\\n');
  process.exit(7);
}
process.stdout.write(answers[port]);
const at = argv.indexOf('-w');
if (at !== -1 && at + 1 < argv.length) {
  process.stdout.write(argv[at + 1].replace(/\\\\n/g, '\\n').replace('%{http_code}', String(codes[port])));
}
`,
  );
  writeFileSync(path, '#!/bin/sh\nexec node -- "$0.cjs" "$@"\n');
  chmodSync(path, 0o755);
  return sandbox;
}

/** A sandbox on a remote topology, which is where the ssh-and-curl read route is the real one. */
function publisherSandbox(options) {
  const sandbox = makeSandbox({
    config: ALL_REMOTE,
    project: PROFILE,
    envFiles: {
      '.env': 'STAMP=stamp\nSTREAM_KEY=key\n',
      [`.env.${PROFILE}`]: 'STAMP=stamp\nSTREAM_KEY=key\nABR_ENABLED=true\n',
    },
  });
  return stubCurl(sandbox, options);
}

function generate(sandbox) {
  return runScript(sandbox, SCRIPT_NAME, [`--profile=${PROFILE}`, `--portSlot=${PORT_SLOT}`]);
}

/**
 * The generator that writes BEE_PUBLISHERS by asking each rung's Bee node which batch it holds.
 *
 * Only what can be checked without a deployment. Its selection and refusal rules are exercised
 * against captured `/stamps` responses through `--stamps-from`, which needs a profile env file and so
 * belongs to the host rather than to CI.
 */
describe('the BEE_PUBLISHERS generator', () => {
  /**
   * ⛔⛔ The regression that made the script's ORDINARY invocation the only broken one. macOS ships
   * bash 3.2, where an **empty** array expanded as `"${arr[@]}"` under `set -u` is an unbound
   * variable rather than an empty list. `parse_profile_args` consumes `--profile` and `--portSlot`
   * and leaves `REST_ARGS` empty, so the script died on its own argument handling the moment nobody
   * passed a third flag. Every path exercised while writing it passed `--stamps-from`, which is
   * exactly why it survived to be committed.
   *
   * Asserted as "not this failure" plus "still refuses", because what should happen next is a refusal
   * about the missing env file. A test that only checked the exit code would pass against the bug.
   */
  it('gets past argument parsing when the profile flags are the only arguments', () => {
    const { code, out } = run(['--profile=no-such-profile-for-tests', '--portSlot=1']);

    assert.doesNotMatch(out, /unbound variable/, 'the script died on its own argument handling');
    assert.notEqual(code, 0, 'a profile with no env file has to refuse');
    assert.match(out, /no-such-profile-for-tests/, 'the refusal should name the profile it could not load');
  });

  it('prints its usage without needing a deployment', () => {
    const { code, out } = run(['--help']);

    assert.equal(code, 0);
    assert.match(out, /BEE_PUBLISHERS/);
    assert.match(out, /--write/);
  });

  /**
   * The batch selection is an inline `python3 -c '...'` program inside a single-quoted shell string, so
   * one apostrophe or backtick in a comment closes the string and the whole file stops parsing. That
   * has happened once already, to a backtick in a docstring.
   */
  it('parses as bash, embedded python and all', () => {
    execFileSync('bash', ['-n', SCRIPT], { stdio: 'pipe' });
  });

  /** The floor and the ceiling have to be the ones PostageGate applies, or config it writes is config the service refuses. */
  it('shares its refusal thresholds with the uploader’s own postage gate', () => {
    const script = execFileSync('cat', [SCRIPT], { encoding: 'utf8' });
    const gate = execFileSync('cat', [join(HERE, '..', '..', 'packages/stream-uploader/src/utils/config.ts')], {
      encoding: 'utf8',
    });

    assert.match(script, /MIN_TTL_HOURS="\$\{STAMP_MIN_TTL_HOURS:-24\}"/);
    assert.match(script, /MAX_UTILIZATION="\$\{STAMP_MAX_UTILIZATION:-0\.9\}"/);
    assert.match(gate, /DEFAULT_STAMP_MIN_TTL_HOURS = 24/);
    assert.match(gate, /DEFAULT_STAMP_MAX_UTILIZATION = 0\.9/);
  });
});

/**
 * ⛔⛔⛔ A NODE THAT ANSWERS AN ERROR IS NOT A NODE HOLDING NO BATCH. Bee answers a failure with an
 * ordinary JSON body carrying `code` and `message` and no `stamps` list at all, the read asked for no
 * HTTP status, and the parser read a missing list as an empty one. So an erroring node was refused
 * for holding "no batches at all", and the printed fix was to go and buy one on a node that had said
 * nothing about batches. The refusal was right and its reason was wrong, which is the more expensive
 * of the two failures: an operator acts on the reason.
 */
describe('the generator tells a node that answered an error from a node holding no batch', () => {
  const NOT_READY = JSON.stringify({ code: 503, message: 'batchstore is not ready' });

  it('names the status and the node’s own words, rather than reporting no batches at all', async () => {
    const sandbox = publisherSandbox({
      bodies: { [PORTS['720p']]: NOT_READY },
      statuses: { [PORTS['720p']]: 503 },
    });

    const { exitCode, stdout, stderr } = await generate(sandbox);

    assert.notEqual(exitCode, 0, 'a node answering 503 was read as one holding no usable batch');
    const out = `${stdout}${stderr}`;
    assert.match(out, new RegExp(`720p node on :${PORTS['720p']}`));
    assert.match(out, /answered 503/);
    assert.match(out, /batchstore is not ready/, 'the node’s own words were dropped from the refusal');
    assert.doesNotMatch(out, /no batches at all/, 'an erroring node was reported as holding no batches');
  });

  /** ⛔ The 200 that carries an envelope anyway, which is the case an HTTP status cannot catch. */
  it('refuses a 200 whose body carries no list of stamps, rather than reading it as an empty node', async () => {
    const sandbox = publisherSandbox({ bodies: { [PORTS['480p']]: JSON.stringify({ code: 404, message: 'nope' }) } });

    const { exitCode, stdout, stderr } = await generate(sandbox);

    assert.notEqual(exitCode, 0, 'a body with no list of stamps was read as a node holding none');
    const out = `${stdout}${stderr}`;
    assert.match(out, /no list of stamps/);
    assert.doesNotMatch(out, /no batches at all/, 'an unreadable body was reported as an empty node');
  });

  /** ⛔ And the ordinary answer still reads, with the status line curl appends kept out of the body. */
  it('builds the line from four nodes that answered 200, one batch each', async () => {
    const sandbox = publisherSandbox();

    const { exitCode, stdout, stderr } = await generate(sandbox);

    assert.equal(exitCode, 0, `${stdout}${stderr}`);
    for (const [rung, port] of Object.entries(PORTS)) {
      assert.match(stdout, new RegExp(`${rung}@http://127\\.0\\.0\\.1:${port}<${BATCHES[rung].slice(0, 8)}…>`));
    }
    assert.doesNotMatch(stdout, /unreadable/, 'the status line curl appends was parsed as part of the body');
  });
});
