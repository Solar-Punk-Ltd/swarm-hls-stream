import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { type RungTimeline } from '../src/browser/qualitySwitch.js';
import { parseBrowserArmState } from '../src/harness/browser.js';
import {
  keptWatchingRefusal,
  ladderInPlayRefusal,
  movedOffDeadRungRefusal,
  RUNG_QUIET_SECONDS,
  RUNG_RECOVER_SECONDS,
  RUNG_SETTLE_SECONDS,
  rungArmMinutes,
  rungArmRefusal,
  rungArmSummary,
} from '../src/harness/rungArm.js';

import { armState, MOVED_OFF_A_DEAD_RUNG, rungArmState } from './helpers/browserArmFixtures.js';

/**
 * The questions a viewer whose rung went quiet is asked.
 *
 * `suites/viewer/rung-outage.test.ts` costs a broadcast and nothing under `suites/` runs in CI, so
 * every rule it judges on is covered here.
 */

const E2E_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLEAN_ARM = { maxSegmentRequests: 9 };
const WATCHED = parseBrowserArmState(rungArmState()).rungs as RungTimeline;
const wentThrough = (overrides: Partial<RungTimeline>): RungTimeline => ({ ...WATCHED, ...overrides });

describe('how much wall clock one rung-outage arm gets', () => {
  it("outlasts the driver's own windows", () => {
    const windows = RUNG_SETTLE_SECONDS + RUNG_QUIET_SECONDS + RUNG_RECOVER_SECONDS;

    assert.ok(rungArmMinutes() * 60 > windows, `${windows}s of driver timeline has to fit inside`);
  });

  /** ⛔ Mirrored constants, so this is a grep rather than a promise, like every other driver mirror. */
  it('mirrors the window defaults the rung-outage driver actually declares', () => {
    const driver = readFileSync(join(E2E_DIR, 'browser', 'rung-outage.ts'), 'utf8');
    const declared = (name: string): number => {
      const match = new RegExp(`const ${name} = (\\d+);`).exec(driver);
      assert.ok(match, `browser/rung-outage.ts no longer declares ${name}`);
      return Number(match[1]);
    };

    assert.equal(RUNG_SETTLE_SECONDS, declared('DEFAULT_SETTLE_SECONDS'));
    assert.equal(RUNG_QUIET_SECONDS, declared('DEFAULT_QUIET_SECONDS'));
    assert.equal(RUNG_RECOVER_SECONDS, declared('DEFAULT_RECOVER_SECONDS'));
  });
});

describe('whether a run is a viewer whose rung went quiet', () => {
  it('passes an arm that watched, lost its rung and reported both halves', () => {
    assert.equal(rungArmRefusal(parseBrowserArmState(rungArmState()), CLEAN_ARM), null);
  });

  /** ⛔ A plain watch produces a full report in which nothing ever went wrong. */
  it('refuses an arm that silenced no rung', () => {
    assert.match(String(rungArmRefusal(parseBrowserArmState(armState()), CLEAN_ARM)), /no rung was silenced/);
  });

  /**
   * ⛔ The pairing. A rung timeline alone cannot say whether the switch cost the viewer anything, and
   * a player that moved rung and stalled doing it would pass every other check in the file.
   */
  it('refuses an arm carrying a rung timeline and no freeze verdict', () => {
    const halfArmed = parseBrowserArmState(rungArmState({ recovery: null, scenario: null }));

    assert.match(String(rungArmRefusal(halfArmed, CLEAN_ARM)), /whether the viewer paid/);
  });

  it('refuses a run whose browser was not a usable instrument', () => {
    const degraded = parseBrowserArmState(
      rungArmState({ instrument: { sound: false, failures: ['timer drift 61x the interval'] } }),
    );

    assert.match(String(rungArmRefusal(degraded, CLEAN_ARM)), /timer drift 61x the interval/);
  });

  /**
   * ⛔ A silenced section naming no rung means the driver reached its outage window without choosing
   * anything to stop. Its rung timeline is then a healthy ladder being read as one that survived.
   */
  it('refuses an artifact whose silenced section names no rung', () => {
    assert.throws(
      () => parseBrowserArmState(rungArmState({ silenced: { rung: null, height: null, processes: [] } })),
      /without choosing anything to silence/,
    );
  });
});

describe('whether the ladder was in play at all', () => {
  it('accepts a player choosing its own rung', () => {
    assert.equal(ladderInPlayRefusal(WATCHED), null);
  });

  it('refuses a pinned player, which stays on a dead rung by instruction', () => {
    assert.match(String(ladderInPlayRefusal(wentThrough({ abrEnabledThroughout: false }))), /pinned/);
  });

  it('refuses a player that had selected no rung when the outage landed', () => {
    const unstarted = wentThrough({ before: { ...WATCHED.before, endedOnRungHeight: null } });

    assert.match(String(ladderInPlayRefusal(unstarted)), /nothing it can have moved off/);
  });
});

describe('whether the viewer moved off the rung that died', () => {
  it('accepts a player that ended the outage on a different rung', () => {
    assert.equal(movedOffDeadRungRefusal(WATCHED, '720p'), null);
  });

  /**
   * ⭐ The plan's own done-when, and the outcome this suite most expects to see. The message names the
   * mechanism, because the likely cause is how hls.js decides to switch rather than anything in this
   * repo, and a session reading the red should not have to rediscover it.
   */
  it('refuses a player still on the dead rung, and says why that probably happened', () => {
    const stuck = wentThrough({ during: { ...WATCHED.during, endedOnRungHeight: 720 } });

    const refusal = String(movedOffDeadRungRefusal(stuck, '720p'));
    assert.match(refusal, /still on 720p/);
    assert.match(refusal, /does not error/);
    assert.match(refusal, /Three healthy rungs/);
  });
});

describe('whether moving rung bought the viewer anything', () => {
  it('accepts a picture that kept moving while a rung was quiet', () => {
    assert.equal(keptWatchingRefusal(WATCHED), null);
  });

  it('refuses a frozen picture, however well the player chose', () => {
    const frozen = wentThrough({ during: { ...WATCHED.during, advance: { ratio: 0, wallMs: 90_000, samples: 90 } } });

    assert.match(String(keptWatchingRefusal(frozen)), /three healthy rungs published beside them/);
  });
});

describe('the line an operator reads while a rung-outage arm runs', () => {
  it('names the rung it silenced and where the viewer went', () => {
    const line = rungArmSummary(parseBrowserArmState(rungArmState()));

    assert.match(line, /silenced 720p/);
    assert.match(line, /480p during/);
  });

  it('has something to say about an arm that silenced nothing', () => {
    assert.match(rungArmSummary(parseBrowserArmState(armState())), /silenced no rung/);
  });
});

describe('the timeline as the artifact carries it', () => {
  it('refuses a rung section missing a phase', () => {
    const halfStated = { ...MOVED_OFF_A_DEAD_RUNG };
    delete (halfStated as Record<string, unknown>).during;

    assert.throws(() => parseBrowserArmState(rungArmState({ rungs: halfStated })), /run\.rungs\.during/);
  });
});
