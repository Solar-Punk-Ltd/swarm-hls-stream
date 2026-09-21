import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, describe, it } from 'node:test';

import { makeSandbox, removeSandboxes } from './helpers/sandbox.js';

after(removeSandboxes);

/**
 * The script run the way the manager runs it, with nothing on standard input.
 *
 * `ScriptRunner` spawns a deploy with `stdio: ['ignore', 'pipe', 'pipe']`, so a `read` in there
 * reaches end of file at once. The shared `runScript` leaves an open pipe on standard input
 * instead, where the same `read` waits for a line that never comes, so a guard that asks a question
 * hangs the suite rather than failing it. Which of the two a caller gets decides whether an operator
 * sees a refusal or a deploy that never returns, so these cases use the manager's wiring.
 */
function runHeadless(sandbox, name, args = []) {
  return new Promise((resolve) => {
    const child = spawn('bash', [sandbox.scriptPath(name), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: sandbox.root, PATH: `${sandbox.binDir}:${process.env.PATH ?? ''}` },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (exitCode) => resolve({ output, exitCode }));
  });
}

/**
 * Four rungs, each with its own node and its own batch, which is what a deployment that splits its
 * bees per rung carries instead of a single STAMP. The batch ids are 64 hex characters because
 * `capacity-gate.sh` refuses anything shorter as a truncated paste.
 */
const PUBLISHERS = [
  '360p@http://localhost:1633',
  '480p@http://localhost:11001',
  '720p@http://localhost:11003',
  '1080p@http://localhost:11005',
]
  .map((node, index) => `${node}<${String(index + 1).repeat(64)}>`)
  .join(' ');

/**
 * The same script with an open pipe on standard input, which is what a caller that does not close
 * it gives, including the stack's own shared `runScript` helper. A guard that asks a question there
 * waits for a line nobody will send, so the deadline is the assertion: without one this case does
 * not fail, it never finishes.
 */
function runWithOpenStdin(sandbox, name, args = [], deadlineMs = 10_000) {
  return new Promise((resolve) => {
    const child = spawn('bash', [sandbox.scriptPath(name), ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: sandbox.root, PATH: `${sandbox.binDir}:${process.env.PATH ?? ''}` },
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ output, exitCode: null, timedOut: true });
    }, deadlineMs);
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ output, exitCode, timedOut: false });
    });
  });
}

const withEnv = (env) => makeSandbox({ envFiles: { '.env': `${env}\nSTREAM_KEY=key\n` } });

/**
 * Who holds the uploader's postage, and what the deploy is allowed to conclude from an empty STAMP.
 *
 * A deployment that splits its bees per rung names one batch per rung in BEE_PUBLISHERS and never
 * reads STAMP: `stream-uploader`'s own `buildPublishers` takes the per-rung pool the moment that
 * variable is set, `capacity-gate.sh` names BEE_PUBLISHERS as the batch source ahead of STAMP, and
 * `.env.sample` says the batch is the one in BEE_PUBLISHERS "or STAMP when unsplit". The guard in
 * `deploy.sh` was the one place that had not been told, so it read an empty STAMP as an unfunded
 * uploader and refused an ABR deployment that was fully funded.
 *
 * It refused rather than warned because the question it asks cannot be answered without a terminal.
 * Every deploy the manager makes is non-interactive, so `read` reaches end of file, the answer is
 * empty, and the guard aborts. That is right for an uploader that really has no batch and wrong for
 * one whose batches are per rung.
 */
describe('the stamp guard, on a deployment that splits its bees per rung', () => {
  it('deploys an uploader whose batches come from BEE_PUBLISHERS, with no STAMP at all', async () => {
    const run = await runHeadless(withEnv(`STAMP=\nBEE_PUBLISHERS=${PUBLISHERS}`), 'deploy.sh', ['stream-uploader']);

    assert.equal(run.exitCode, 0, run.output);
    assert.doesNotMatch(run.output, /STAMP is empty/);
  });

  it('still refuses an uploader that names neither a batch nor a publisher', async () => {
    const run = await runHeadless(withEnv('STAMP=\nBEE_PUBLISHERS='), 'deploy.sh', ['stream-uploader']);

    assert.notEqual(run.exitCode, 0);
    assert.match(run.output, /STAMP is empty/);
  });

  it('asks nothing of a deployment with no uploader in it', async () => {
    const run = await runHeadless(withEnv('STAMP=\nBEE_PUBLISHERS='), 'deploy.sh', ['client']);

    assert.equal(run.exitCode, 0, run.output);
  });
});

/**
 * A question asked where nobody can answer it, which is every deploy the manager makes.
 *
 * The guard printed "Continue anyway? [y/N]" and then "Aborted.", which reads as though somebody had
 * declined rather than as a refusal, and gave an operator a command to run interactively as the only
 * way out. Worse, whether that even ends is the caller's choice: with standard input closed `read`
 * reaches end of file at once, and with it left open the deploy waits for a line that never comes.
 */
describe('the stamp guard, where there is nobody to ask', () => {
  it('refuses in words rather than appearing to have been answered', async () => {
    const run = await runHeadless(withEnv('STAMP=\nBEE_PUBLISHERS='), 'deploy.sh', ['stream-uploader']);

    assert.notEqual(run.exitCode, 0);
    assert.match(run.output, /no terminal/);
    assert.doesNotMatch(run.output, /Continue anyway/);
  });

  it('ends rather than waiting when standard input is an open pipe', async () => {
    const run = await runWithOpenStdin(withEnv('STAMP=\nBEE_PUBLISHERS='), 'deploy.sh', ['stream-uploader']);

    assert.equal(run.timedOut, false, 'the deploy never returned, so it was waiting for an answer');
    assert.notEqual(run.exitCode, 0);
  });
});
