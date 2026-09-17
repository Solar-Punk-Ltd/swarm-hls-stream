import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/**
 * Every file the uploader keeps deployment-wide configuration in, read as one text.
 *
 * The directory rather than `config.ts` alone, and the difference is the whole point of deriving the
 * list instead of writing one down. `readAbrConfig` moved out of `config.ts` into `abrConfig.ts` so
 * that importing an engine stops demanding a full deployment's worth of variables, and a reader
 * pinned to the one file would have kept passing while quietly no longer checking ABR_ENABLED,
 * ABR_VHOST or ABR_LADDER. A test that covers less without saying so is the failure this file was
 * written against, one level up.
 *
 * ⛔ `src/utils` and not `src/`, because the engines under `src/engines` read knobs of their own that
 * a deployment supplies to one engine or the other rather than to every uploader.
 */
const CONFIG_DIR = resolve(ROOT, 'packages/stream-uploader/src/utils');
const CONFIG = readdirSync(CONFIG_DIR)
  .filter((name) => name.endsWith('.ts'))
  .sort()
  .map((name) => readFileSync(join(CONFIG_DIR, name), 'utf8'))
  .join('\n');
const COMPOSE = resolve(ROOT, 'deploy/docker-compose.yml');
const ENV_SAMPLE = resolve(ROOT, '.env.sample');
const UPLOADER_README = resolve(ROOT, 'packages/stream-uploader/README.md');

/** The compose service the uploader runs as, which is the only block its own knobs may be read from. */
const UPLOADER_SERVICE = 'stream-uploader';

/**
 * How a knob is read in the config source, as a pattern source rather than a regex object.
 *
 * Built fresh at every use on purpose: a `g` regex carries `lastIndex` between calls, so one shared
 * object used for both `matchAll` and `test` answers differently depending on what asked last.
 */
const KNOB_CALL = String.raw`\b(?:optional|required)(?:Int|Bool|Number)?\('([A-Z0-9_]+)'`;

/**
 * The `environment:` block of one compose service, as text, or an empty string if it has none.
 *
 * Walked by indentation rather than parsed, for the same reason `imageNames.test.js` walks it: adding
 * a YAML parser to a check that exists to catch a missing line means the check and the deployment no
 * longer read the file the same way. Two levels, both fixed by the file's own style: a service name
 * sits at two spaces and its keys at four.
 */
function serviceEnvironment(compose, service) {
  const lines = compose.split('\n');
  const start = lines.indexOf(`  ${service}:`);
  if (start === -1) {
    return '';
  }

  const block = [];
  let inEnvironment = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) {
      break;
    }
    if (/^ {4}\S/.test(line)) {
      inEnvironment = line === '    environment:';
      continue;
    }
    if (inEnvironment) {
      block.push(line);
    }
  }

  return block.join('\n');
}

/**
 * That every knob the uploader reads can actually be set on a deployment.
 *
 * `deploy/docker-compose.yml` enumerates the uploader's environment rather than inheriting it, which
 * is deliberate and is the same SEC-28 reasoning the engine files carry: `env_file` would hand every
 * root variable to every container. The cost is that a variable absent from that block is one the
 * container never sees, so it silently keeps its compiled default however carefully an operator sets
 * it, and nothing anywhere reports a problem.
 *
 * `ORPHAN_REAP_MS` shipped that way. Its own JSDoc argues at length that it must be tunable
 * separately from `RECOVERY_TIMEOUT` and `SEGMENT_STALL_MS`, and it reached neither compose nor
 * `.env.sample`, so the argument was unreachable: every deployment kept 60000 whatever it asked for.
 * Every sibling from the same config block was already wired, which is what made it invisible.
 *
 * Derived from `config.ts` rather than from a hand-kept list, because a list is the thing that goes
 * stale here.
 */
describe('the uploader environment reaches the container', () => {
  /** Names read via the `optional*`/`required*` helpers, which is every knob the service has. */
  const knobs = [...new Set([...CONFIG.matchAll(new RegExp(KNOB_CALL, 'g'))].map((m) => m[1]))];

  it('reads a plausible set of knobs from config.ts, so an empty match cannot pass silently', () => {
    assert.ok(
      knobs.length >= 10,
      `only found ${knobs.length} knobs, so the pattern has stopped matching the config files`,
    );
    assert.ok(knobs.includes('ORPHAN_REAP_MS'), 'the knob this test was written for is not being found');
  });

  /**
   * That the pattern above still matches every way this codebase has of reading a knob.
   *
   * ⛔⛔ `optionalNumber` was not in the pattern for as long as it existed, so four knobs were never
   * checked at all, among them both postage thresholds an operator most wants to move. The floor
   * above did not notice, and could not: it asks whether the pattern still matches SOMETHING, and a
   * pattern that has gone blind to one reader out of five still matches plenty.
   *
   * So the readers are derived from `utils/env.ts` and each is probed against the pattern directly.
   * Adding `optionalList` there and not here now fails this case by name instead of quietly dropping
   * every knob that uses it.
   */
  it('matches every knob reader utils/env.ts exports, so a new one cannot go unscraped', () => {
    const readers = [
      ...readFileSync(join(CONFIG_DIR, 'env.ts'), 'utf8').matchAll(/^export function ((?:optional|required)\w*)\(/gm),
    ].map((match) => match[1]);

    assert.ok(readers.length >= 4, `only found ${readers.length} readers in env.ts, so this case has stopped looking`);

    const unmatched = readers.filter((reader) => !new RegExp(KNOB_CALL).test(`${reader}('A_KNOB'`));

    assert.deepEqual(
      unmatched,
      [],
      `exported by env.ts and not matched by the knob pattern, so every knob read through them is ` +
        `unchecked: ${unmatched.join(', ')}`,
    );
  });

  /**
   * Pinned to a value the container must use rather than left to the environment. `STATE_DIR` is the
   * path a volume is mounted at, so an operator changing it would move the recovery store off the
   * mount and lose every stream across a restart. Listed rather than pattern-matched, so adding one
   * is a decision someone writes down.
   */
  const FIXED_IN_THE_IMAGE = new Set(['STATE_DIR']);

  /**
   * That the block being read is the uploader's own and not the whole file.
   *
   * ⛔ The check below used to ask whether a knob appeared anywhere in `docker-compose.yml`, and four
   * of them (ABR_ENABLED, ABR_VHOST, ABR_LADDER, HLS_FRAGMENT) are deliberately in two service blocks
   * at once, because the engine and the uploader have to agree on them. So deleting one from the
   * uploader while leaving it on the engine left this file green while the uploader silently went
   * back to its compiled default, which is the exact defect this file exists to catch, wearing the
   * one disguise it could not see through.
   *
   * A fixture rather than the real compose file, so both halves of the answer are asserted: that the
   * service's own keys are in and that a neighbour's are out. Reading the real file could only ever
   * show the first.
   */
  it("reads the uploader's own environment block and not a neighbouring service's", () => {
    const fixture = [
      'services:',
      '  srs:',
      '    environment:',
      '      SHARED_WITH_THE_ENGINE: ${SHARED_WITH_THE_ENGINE:-0.5}',
      '  stream-uploader:',
      '    environment:',
      '      OWN_KNOB: ${OWN_KNOB:-1}',
      '    healthcheck:',
      '      test: ANOTHER_KEY_ENTIRELY',
      '  client:',
      '    environment:',
      '      A_THIRD_SERVICES_KNOB: ${A_THIRD_SERVICES_KNOB:-2}',
    ].join('\n');

    const block = serviceEnvironment(fixture, 'stream-uploader');

    assert.match(block, /OWN_KNOB/);
    assert.doesNotMatch(block, /SHARED_WITH_THE_ENGINE/);
    assert.doesNotMatch(block, /A_THIRD_SERVICES_KNOB/);
    // The service's other keys are outside its environment block and are not configuration.
    assert.doesNotMatch(block, /ANOTHER_KEY_ENTIRELY/);
  });

  it('passes every knob through docker-compose', () => {
    // The uploader's own block, not the whole file. See the case above for what reading the whole
    // file could not see.
    const compose = serviceEnvironment(readFileSync(COMPOSE, 'utf8'), UPLOADER_SERVICE);
    assert.ok(
      compose.length > 0,
      `${UPLOADER_SERVICE} has no environment block in ${COMPOSE}, so every knob below would be ` +
        'reported missing for a reason that has nothing to do with the knobs',
    );
    // Collected and asserted once rather than asserted inside the loop. `assert` throws on the first
    // failure, so a loop reports one name and stops, and the reader fixes that one and believes they
    // are done. Widening the pattern above found two knobs missing from compose and the old shape
    // would have named only the earlier of them.
    const unseen = [];
    const hardCoded = [];

    for (const knob of knobs) {
      // Present at all, which is what decides whether the container can see it.
      if (!new RegExp(`^\\s*${knob}:`, 'm').test(compose)) {
        unseen.push(knob);
        continue;
      }
      if (FIXED_IN_THE_IMAGE.has(knob)) {
        continue;
      }
      // And interpolated from the same name, or it is passed as a constant nobody can change, which
      // is the same defect wearing a value.
      if (!new RegExp(`^\\s*${knob}:\\s*\\$\\{${knob}`, 'm').test(compose)) {
        hardCoded.push(knob);
      }
    }

    // One assertion over both lists, not one per list. `assert` throws on the first failure, so two
    // assertions report the earlier kind of defect and hide the later one, which is the same shape as
    // the loop this file already stopped asserting inside and it was still here one level up. A
    // change that drops a knob from compose and hard-codes another is exactly the case that reads as
    // one problem and is two.
    assert.deepEqual(
      { unseen, hardCoded },
      { unseen: [], hardCoded: [] },
      `unseen are read by the uploader and never passed to it, so setting them does nothing: ${
        unseen.join(', ') || 'none'
      }. hardCoded are passed as a fixed value, so an operator setting them in .env is ignored: ${
        hardCoded.join(', ') || 'none'
      }`,
    );
  });

  /**
   * Secrets are excluded because `.env.sample` is committed and a sample value for one of these
   * reads as a credential to paste rather than as a placeholder. They are in compose, which is what
   * decides whether the container can see them.
   *
   * A commented assignment counts as documented, because the question this asks is whether an
   * operator can learn the knob exists and not whether a fresh install sets it. `HLS_FRAGMENT` is
   * deliberately shipped commented out, under four lines saying why: it is the same variable the
   * engine reads, so a fresh install is meant to take the one compose default on both sides rather
   * than a value from here. Demanding an active assignment would have read that as missing
   * documentation and invited someone to uncomment it, which is the opposite of what the note asks
   * for.
   */
  it('documents every non-secret knob in .env.sample', () => {
    const SECRETS = new Set(['API_AUTH_TOKEN', 'STREAM_KEY', 'STAMP']);
    const sample = readFileSync(ENV_SAMPLE, 'utf8');

    const undocumented = knobs
      .filter((name) => !SECRETS.has(name))
      .filter((knob) => !new RegExp(`^#? *${knob}=`, 'm').test(sample));

    assert.deepEqual(
      undocumented,
      [],
      `can be set but are not in .env.sample, so an operator has no way to learn they exist: ${undocumented.join(
        ', ',
      )}`,
    );
  });

  /**
   * The third page a knob has to reach, and the only one that is nobody's deployment.
   *
   * Compose decides whether the container can see a knob and `.env.sample` decides whether the
   * operator editing that file can. Neither is what a reader of the package opens, and the uploader's
   * README is: nine knobs the service reads and `.env.sample` already documents had no row in either
   * of its two tables, among them the chequebook floor and both postage thresholds, which are the
   * three an operator most wants to move. The gap is invisible from inside the page, because the rows
   * that are there stay correct. `START_GATE_TIMEOUT_MS` said it was "separate from
   * `BEE_REQUEST_TIMEOUT_MS`" while pointing at a row the table did not carry.
   *
   * Either table counts. Required and Optional are one surface split by whether a value has to be
   * supplied, and which side a knob belongs on is a judgement rather than something a pattern can
   * settle. An upper-case first column is these two tables and nothing else in the page: every other
   * table there is keyed by a health reason or a metric name, which are lower case.
   */
  it('gives every knob a row in the uploader README', () => {
    const readme = readFileSync(UPLOADER_README, 'utf8');

    const unlisted = knobs.filter((knob) => !new RegExp(`^\\|\\s*\`${knob}\`\\s*\\|`, 'm').test(readme));

    assert.deepEqual(
      unlisted,
      [],
      `read by the uploader and in neither environment table of packages/stream-uploader/README.md, ` +
        `so a reader of the package has no way to learn they exist: ${unlisted.join(', ') || 'none'}`,
    );
  });
});
