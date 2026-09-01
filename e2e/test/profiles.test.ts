import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { readAbrExpectation } from '../src/abrCoverage.js';
import { announcementLoad, announcementRefusal } from '../src/announcementRate.js';
import { byteSourceFromEnv } from '../src/browser/fetchBackendSweep.js';
import {
  applyRunProfile,
  availableRunProfiles,
  DEFAULT_RUN_PROFILE,
  PROFILE_DIR,
  resolveRunProfile,
  RUN_PROFILE_VAR,
  runProfileRefusal,
} from '../src/profiles.js';

/**
 * A run profile is a saved, named set of the env values that decide what a sitting IS, so the same
 * run can be asked for twice and be the same run both times.
 *
 * ⛔ The rule every test here defends is that a profile never overrules the operator. A profile is a
 * default with a name on it. An operator who exported a value on the command line is steering one
 * run deliberately, and a file that silently won that argument would hand back a run that is not the
 * one they asked for, under a report that names the profile they thought they had overridden.
 */

/** The ladder both shipped profiles declare, and the unit an SRS announcement is per. */
const LADDER_RUNGS = ['1080p', '720p', '480p', '360p'];

const sandboxes: string[] = [];

after(() => {
  for (const dir of sandboxes) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A directory of profile files, standing in for `e2e/profiles`. */
function fixtureDir(profiles: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-profiles-'));
  sandboxes.push(dir);
  for (const [name, text] of Object.entries(profiles)) {
    writeFileSync(join(dir, `${name}.env`), text);
  }
  return dir;
}

const TWO_PROFILES = {
  'in-browser': 'BROWSER_FETCH_BACKEND=weeb3\nE2E_EXPECT_ABR=true\n',
  'light-client': 'BROWSER_FETCH_BACKEND=gateway\nE2E_EXPECT_ABR=true\n',
};

describe('choosing which run profile a sitting is', () => {
  it('falls back to the in-browser profile, which is the subject this project measures', () => {
    const dir = fixtureDir(TWO_PROFILES);

    assert.equal(resolveRunProfile({ env: {}, dir }).name, DEFAULT_RUN_PROFILE);
    assert.equal(DEFAULT_RUN_PROFILE, 'in-browser');
  });

  it('reads the name the operator asked for', () => {
    const dir = fixtureDir(TWO_PROFILES);

    assert.equal(resolveRunProfile({ env: { [RUN_PROFILE_VAR]: 'light-client' }, dir }).name, 'light-client');
  });

  it('treats an empty name as unset rather than as a profile called nothing', () => {
    const dir = fixtureDir(TWO_PROFILES);

    assert.equal(resolveRunProfile({ env: { [RUN_PROFILE_VAR]: '' }, dir }).name, DEFAULT_RUN_PROFILE);
  });

  /**
   * Naming them is the point. A run stopped by "no such profile" with nothing else to go on is a
   * run the operator has to go and read the directory for, which is the moment a typo becomes a
   * guess at a different name.
   */
  it('refuses a name it does not have, and says which names it does have', () => {
    const dir = fixtureDir(TWO_PROFILES);

    assert.throws(
      () => resolveRunProfile({ env: { [RUN_PROFILE_VAR]: 'in-brwoser' }, dir }),
      (error: Error) => {
        assert.match(error.message, /in-brwoser/);
        assert.match(error.message, /in-browser/);
        assert.match(error.message, /light-client/);
        return true;
      },
    );
  });

  /**
   * A name is checked against the listing before anything is opened, so a name shaped like a path
   * cannot reach a file outside the directory. It is refused as an unknown profile, which it is.
   */
  it('refuses a name that tries to climb out of the profile directory', () => {
    const dir = fixtureDir(TWO_PROFILES);

    assert.throws(() => resolveRunProfile({ env: { [RUN_PROFILE_VAR]: '../../.env' }, dir }), /profile/i);
  });

  it('lists the profiles on disk by name, without the extension', () => {
    const dir = fixtureDir(TWO_PROFILES);

    assert.deepEqual(availableRunProfiles(dir), ['in-browser', 'light-client']);
  });
});

describe('what a profile sets, and what it leaves alone', () => {
  it('reports the values it would apply', () => {
    const dir = fixtureDir(TWO_PROFILES);

    const resolution = resolveRunProfile({ env: {}, dir });

    assert.deepEqual(resolution.applied, { BROWSER_FETCH_BACKEND: 'weeb3', E2E_EXPECT_ABR: 'true' });
    assert.deepEqual(resolution.skipped, []);
  });

  it('applies them into the environment the caller passed', () => {
    const dir = fixtureDir(TWO_PROFILES);
    const env: NodeJS.ProcessEnv = {};

    applyRunProfile({ env, dir });

    assert.equal(env.BROWSER_FETCH_BACKEND, 'weeb3');
    assert.equal(env.E2E_EXPECT_ABR, 'true');
  });

  /**
   * The whole precedence rule in one case. `light-client` is the gateway profile, and an operator
   * who exported the in-tab byte source on top of it gets the in-tab byte source.
   */
  it('never overrides a value the operator set, and says which ones it stood down on', () => {
    const dir = fixtureDir(TWO_PROFILES);
    const env: NodeJS.ProcessEnv = { [RUN_PROFILE_VAR]: 'light-client', BROWSER_FETCH_BACKEND: 'weeb3' };

    const resolution = applyRunProfile({ env, dir });

    assert.equal(env.BROWSER_FETCH_BACKEND, 'weeb3');
    assert.deepEqual(resolution.skipped, ['BROWSER_FETCH_BACKEND']);
    assert.deepEqual(resolution.applied, { E2E_EXPECT_ABR: 'true' });
  });

  /**
   * An operator who exported an empty value blanked it on purpose. Reading that as unset would let
   * the profile fill it back in, which is the one case where "explicit wins" has to mean presence
   * rather than truthiness.
   */
  it('treats a deliberately blanked value as the operator having decided', () => {
    const dir = fixtureDir(TWO_PROFILES);
    const env: NodeJS.ProcessEnv = { E2E_EXPECT_ABR: '' };

    applyRunProfile({ env, dir });

    assert.equal(env.E2E_EXPECT_ABR, '');
  });

  it('reads the file by the same rules the deploy reads its env files', () => {
    const dir = fixtureDir({ quoted: 'BROWSER_FETCH_BACKEND="weeb3"  # the in-tab node\n# a comment\n' });

    assert.deepEqual(resolveRunProfile({ env: { [RUN_PROFILE_VAR]: 'quoted' }, dir }).applied, {
      BROWSER_FETCH_BACKEND: 'weeb3',
    });
  });

  it('names the file it read, so a report can say where a value came from', () => {
    const dir = fixtureDir(TWO_PROFILES);

    assert.equal(resolveRunProfile({ env: {}, dir }).path, join(dir, 'in-browser.env'));
  });
});

/**
 * ⛔ The same circularity `config.ts` refuses in a deployment's env file, for the same reason: a
 * file that gets to choose which file is trusted is a hole worth keeping shut. `E2E_PROFILE` and
 * `E2E_PORT_SLOT` name a deployment rather than a run, and a run profile that moved them would aim
 * a sitting at another operator's stack while the report named the profile they asked for.
 */
describe('keys a run profile is not allowed to hold', () => {
  it('refuses a profile that picks the profile', () => {
    const dir = fixtureDir({ circular: `${RUN_PROFILE_VAR}=light-client\n` });

    assert.throws(() => resolveRunProfile({ env: { [RUN_PROFILE_VAR]: 'circular' }, dir }), /E2E_RUN_PROFILE/);
  });

  it('refuses a profile that aims the run at a deployment', () => {
    const dir = fixtureDir({ infra: 'E2E_PROFILE=slot3\nE2E_PORT_SLOT=3\n' });

    assert.throws(
      () => resolveRunProfile({ env: { [RUN_PROFILE_VAR]: 'infra' }, dir }),
      (error: Error) => {
        assert.match(error.message, /E2E_PROFILE/);
        assert.match(error.message, /E2E_PORT_SLOT/);
        return true;
      },
    );
  });
});

/**
 * The shipped pair, read off disk rather than restated here. A profile whose value no parser accepts
 * is a run that dies at the first suite, and the two spellings this repo uses for the same idea make
 * that easy to write: the ABR expectation is declared with `true`, never with the word `ladder`,
 * which `readAbrExpectation` refuses.
 */
describe('the two profiles this repo ships', () => {
  it('ships exactly the in-browser and light-client profiles', () => {
    assert.deepEqual(availableRunProfiles(PROFILE_DIR), ['in-browser', 'light-client']);
  });

  it('puts the in-tab node in the default profile and the gateway in the other', () => {
    const inBrowser = resolveRunProfile({ env: {}, dir: PROFILE_DIR }).applied;
    const lightClient = resolveRunProfile({ env: { [RUN_PROFILE_VAR]: 'light-client' }, dir: PROFILE_DIR }).applied;

    assert.equal(byteSourceFromEnv(inBrowser.BROWSER_FETCH_BACKEND), 'weeb3');
    assert.equal(byteSourceFromEnv(lightClient.BROWSER_FETCH_BACKEND), 'gateway');
  });

  it('declares the ladder in both, in a spelling the ABR gate actually reads', () => {
    for (const name of availableRunProfiles(PROFILE_DIR)) {
      const applied = resolveRunProfile({ env: { [RUN_PROFILE_VAR]: name }, dir: PROFILE_DIR }).applied;

      assert.equal(readAbrExpectation(applied.E2E_EXPECT_ABR ?? ''), 'ladder', `${name} must declare the ladder`);
    }
  });

  /**
   * The byte source separates them, and the segment length separates them too. Nothing else may, or
   * a reader comparing the pair carries a difference nobody chose.
   *
   * ⛔⛔⛔ This assertion used to read `['BROWSER_FETCH_BACKEND']` alone, and widening it is the whole
   * point rather than a concession. Measured 2026-08-16 by the sibling repo swarm-stream-loadlab: an
   * in-tab weeb-3 node holds 1.000x of realtime on 2s segments and 0.426x on 0.5s, because it admits
   * about one segment per second whatever its peer count, while the gateway measures the opposite
   * optimum over 21 funded arms at 1.55s against 3.88s. One number therefore cannot serve both
   * profiles, and a session that "fixed the inconsistency" by equalising them would hand one of the
   * two viewer types a stage it cannot run on, silently. That is the failure this list guards
   * against, in both directions.
   *
   * ⚠️ **WHY light-client says 1.0 and not the 0.5 its byte source measured best at, since
   * 2026-09-01.** A second constraint outranks the byte source on a ladder. SRS fires `on_hls` once
   * per closed segment per rung, so a four-rung ladder at 0.5s asks for 8.00 announcements a second
   * against the ~6.7 it was measured sustaining, and past that it deletes each segment before
   * announcing it and unpublishes the tallest rung about two minutes in. So the docblock above still
   * holds, and the reason the numbers differ is now partly the ladder. `preflight/announcement-rate`
   * is the gate. **Do not "restore" 0.5 here.** It is not a drift and the 21-arm measurement behind
   * it is not withdrawn: it is unreachable while four rungs are announced.
   */
  it('differs in the byte source and in the segment length, and neither may be equalised', () => {
    const inBrowser = resolveRunProfile({ env: {}, dir: PROFILE_DIR }).applied;
    const lightClient = resolveRunProfile({ env: { [RUN_PROFILE_VAR]: 'light-client' }, dir: PROFILE_DIR }).applied;

    const differing = Object.keys({ ...inBrowser, ...lightClient }).filter(
      (key) => inBrowser[key] !== lightClient[key],
    );

    assert.deepEqual(differing.sort(), ['BROWSER_FETCH_BACKEND', 'E2E_EXPECT_SEGMENT_S']);
    assert.equal(inBrowser.E2E_EXPECT_SEGMENT_S, '2');
    assert.equal(lightClient.E2E_EXPECT_SEGMENT_S, '1.0');
  });

  /**
   * ⛔ Both shipped profiles must sit inside the announcement rate a sitting has sustained, on the
   * four-rung ladder they both declare. A profile that cannot clear `preflight/announcement-rate`
   * is one whose every run refuses at the gate, which nobody discovers until they book a sitting.
   */
  it('asks for an announcement rate the ladder has been shown sustaining', () => {
    for (const name of availableRunProfiles(PROFILE_DIR)) {
      const applied = resolveRunProfile({ env: { [RUN_PROFILE_VAR]: name }, dir: PROFILE_DIR }).applied;
      const segmentSeconds = Number(applied.E2E_EXPECT_SEGMENT_S);
      const load = announcementLoad(LADDER_RUNGS, segmentSeconds);

      assert.equal(announcementRefusal(load, false), null, `${name} asks ${load.perSecond.toFixed(2)} announcements/s`);
    }
  });

  /**
   * ⛔ Infrastructure is the deployment's to state, not the run's. A profile carrying a host or a
   * port would look reproducible and quietly aim every sitting that used it at one machine.
   */
  it('carries no infrastructure, so a profile names a run and never a machine', () => {
    for (const name of availableRunProfiles(PROFILE_DIR)) {
      const applied = resolveRunProfile({ env: { [RUN_PROFILE_VAR]: name }, dir: PROFILE_DIR }).applied;

      for (const key of Object.keys(applied)) {
        assert.doesNotMatch(key, /HOST|PORT|SSH|_URL$/, `${name} must not carry ${key}`);
      }
    }
  });
});

/**
 * What `suites/preflight/profile.test.ts` refuses on, decided here so `pnpm verify` covers it.
 *
 * Only what can be settled without reaching the network: a value no parser accepts, and a run that
 * declared nothing. Whether the deployment can actually deliver what the profile asks for is a
 * question for a live check, and none of that is here.
 */
describe('refusing a run that contradicts the profile it named', () => {
  /** A run with every declaration in place, so each case below changes exactly the one it is about. */
  const DECLARED = { byteSource: 'weeb3', abrExpectation: 'true', segmentSeconds: '2' };

  it('passes a run whose byte source is a real condition and whose ladder is declared', () => {
    assert.equal(runProfileRefusal(DECLARED), null);
  });

  /**
   * Most suites never open a browser, so a run with no byte source is an ordinary run rather than
   * an ambiguous one. Only a value nothing can read is a refusal.
   */
  it('passes a run that names no byte source at all', () => {
    assert.equal(runProfileRefusal({ ...DECLARED, byteSource: undefined }), null);
    assert.equal(runProfileRefusal({ ...DECLARED, byteSource: '' }), null);
  });

  it('passes a single-rendition run, which is a declaration and not a gap', () => {
    assert.equal(runProfileRefusal({ ...DECLARED, byteSource: 'gateway', abrExpectation: 'false' }), null);
  });

  it('refuses a byte source no parser reads, and names the spellings that work', () => {
    const refusal = String(runProfileRefusal({ ...DECLARED, byteSource: 'weeb-3' }));

    assert.match(refusal, /BROWSER_FETCH_BACKEND/);
    assert.match(refusal, /gateway/);
    assert.match(refusal, /weeb3/);
  });

  it('refuses a ladder declaration no parser reads', () => {
    assert.match(String(runProfileRefusal({ ...DECLARED, abrExpectation: 'yes' })), /E2E_EXPECT_ABR/);
  });

  /**
   * ⛔ The trap the profile files exist to keep shut. `ladder` is the word this repo uses for the
   * expectation everywhere except in the variable itself, which takes `ABR_ENABLED`'s spellings.
   * A profile written with the word rather than the spelling is refused here rather than at the
   * first suite of a paid sitting.
   */
  it('refuses the word ladder, which reads as a declaration and is not one', () => {
    assert.notEqual(runProfileRefusal({ ...DECLARED, abrExpectation: 'ladder' }), null);
  });

  it('refuses a run that declared nothing about the ladder', () => {
    for (const abrExpectation of [undefined, '']) {
      assert.match(String(runProfileRefusal({ ...DECLARED, abrExpectation })), /E2E_EXPECT_ABR/);
    }
  });

  it('refuses a segment length no arithmetic can use', () => {
    assert.match(String(runProfileRefusal({ ...DECLARED, segmentSeconds: '2s' })), /E2E_EXPECT_SEGMENT_S/);
  });

  /**
   * ⭐⭐⭐ The gap the 2026-08-16 loadlab measurement opened. An in-tab weeb-3 node sustains 1.000x of
   * realtime on 2s segments and 0.426x on 0.5s, and the gateway measures the opposite optimum, so a
   * run that did not say which it needs produces a number nobody can attribute to a viewer type.
   * Refused here, with no network touched, rather than by the live gate after the stack is dialed.
   */
  it('refuses a run that declared nothing about the segment length it needs', () => {
    for (const segmentSeconds of [undefined, '']) {
      assert.match(String(runProfileRefusal({ ...DECLARED, segmentSeconds })), /E2E_EXPECT_SEGMENT_S/);
    }
  });

  it('passes a run that declared it does not pin a segment length', () => {
    assert.equal(runProfileRefusal({ ...DECLARED, segmentSeconds: 'any' }), null);
  });

  /** Every profile on disk has to pass its own gate, or the default run cannot start. */
  it('passes both shipped profiles as they stand', () => {
    for (const name of availableRunProfiles(PROFILE_DIR)) {
      const applied = resolveRunProfile({ env: { [RUN_PROFILE_VAR]: name }, dir: PROFILE_DIR }).applied;

      assert.equal(
        runProfileRefusal({
          byteSource: applied.BROWSER_FETCH_BACKEND,
          abrExpectation: applied.E2E_EXPECT_ABR,
          segmentSeconds: applied.E2E_EXPECT_SEGMENT_S,
        }),
        null,
        `${name} must pass its own preflight`,
      );
    }
  });
});
