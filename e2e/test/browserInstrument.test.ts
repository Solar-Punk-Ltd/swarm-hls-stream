import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeProof,
  type InstrumentProof,
  type InstrumentReading,
  judgeInstrument,
  judgeRun,
  REQUIRED_CODECS,
  TIMER_DRIFT_LIMIT,
} from '../src/browser/instrument.js';

const SOUND: InstrumentReading = {
  visibilityState: 'visible',
  timerDriftRatio: 1.02,
  codecSupport: Object.fromEntries(REQUIRED_CODECS.map((codec) => [codec, true])),
};

const reading = (overrides: Partial<InstrumentReading>): InstrumentReading => ({ ...SOUND, ...overrides });

describe('judging whether a browser is fit to measure through', () => {
  it('accepts a visible page with running timers and the codecs a viewer needs', () => {
    assert.deepEqual(judgeInstrument(SOUND), { sound: true, failures: [] });
  });

  /**
   * The case this whole module exists for. These are the conditions of the 2026-08-03 attempt, which
   * produced a player 578 seconds behind live and no way to tell from the number that the reading was
   * about the harness.
   */
  it('rejects the hidden, throttled pane that produced the 578-second reading', () => {
    const verdict = judgeInstrument(reading({ visibilityState: 'hidden', timerDriftRatio: 600 }));

    assert.equal(verdict.sound, false);
    assert.equal(verdict.failures.length, 2, 'a hidden page and a throttled timer are two separate faults');
    assert.match(verdict.failures[0], /visibilityState 'hidden'/);
    assert.match(verdict.failures[1], /600.0x late/);
  });

  it('rejects a page that is visible but whose timers are not keeping their schedule', () => {
    const verdict = judgeInstrument(reading({ timerDriftRatio: TIMER_DRIFT_LIMIT + 0.1 }));

    assert.equal(verdict.sound, false);
    assert.match(verdict.failures[0], /the loader hls\.js drives from timers was not running/);
  });

  it('tolerates the scheduling jitter of a host that is also encoding', () => {
    assert.equal(judgeInstrument(reading({ timerDriftRatio: TIMER_DRIFT_LIMIT })).sound, true);
  });

  /**
   * Stock Chromium plays the page, runs hls.js, downloads every segment and decodes none of them. The
   * symptom is an empty picture, which is what a delivery failure looks like too, so this has to be a
   * named verdict rather than something to work out afterwards.
   */
  it('rejects a build that cannot decode H.264, which fails as an empty picture rather than an error', () => {
    const verdict = judgeInstrument(
      reading({ codecSupport: { ...SOUND.codecSupport, 'video/mp4; codecs="avc1.42E01E"': false } }),
    );

    assert.equal(verdict.sound, false);
    assert.match(verdict.failures[0], /cannot decode video\/mp4; codecs="avc1\.42E01E"/);
    assert.match(verdict.failures[0], /would be the build and not the stream/);
  });
});

describe('judging a whole run rather than one sample', () => {
  /**
   * Throttling is a consequence of the first stall, not a property of the page at load, so a preflight
   * would have passed on 2026-08-03 and every reading after it would still have been garbage.
   */
  it('rejects a run that started sound and was throttled later', () => {
    const verdict = judgeRun([SOUND, SOUND, reading({ timerDriftRatio: 600 })]);

    assert.equal(verdict.sound, false);
    assert.equal(verdict.soundSamples, 2, 'the samples taken before it degraded are still countable');
  });

  it('says the same fault once however many samples carried it', () => {
    const throttled = reading({ timerDriftRatio: 600 });

    assert.equal(judgeRun([throttled, throttled, throttled]).failures.length, 1);
  });

  it('refuses to call a run with no samples sound', () => {
    assert.equal(judgeRun([]).sound, false);
  });

  it('accepts a run whose every sample was sound', () => {
    assert.deepEqual(judgeRun([SOUND, SOUND]), { sound: true, failures: [], soundSamples: 2 });
  });
});

/**
 * The half of the guard that had never been checked. `judgeRun` can say a run was sound; only the
 * proof says whether it could have said anything else, and under Playwright's default flags two of
 * the three checks cannot fail at all.
 */
describe('reporting whether the guard could have failed', () => {
  const FIRED: InstrumentProof = {
    degradation: 'its main thread blocked for 3000ms',
    rejected: true,
    firedChecks: ['timerDriftRatio'],
  };

  it('says nothing when the proof fired, so a real verdict reads as one', () => {
    assert.deepEqual(describeProof(FIRED), []);
  });

  it('names the degradation the instrument failed to notice', () => {
    const caveats = describeProof({ ...FIRED, rejected: false, firedChecks: [] });

    assert.equal(caveats.length, 1);
    assert.match(caveats[0], /main thread blocked for 3000ms/);
    assert.match(caveats[0], /restatement of the launch flags rather than evidence/);
  });

  /**
   * Every run recorded before 2026-08-12 carries no proof, and the archive still has to render. A
   * missing proof is reported as an untested verdict rather than passed over, because silence here
   * would be indistinguishable from a proof that fired.
   */
  it('treats a missing proof as untested rather than as passing', () => {
    const caveats = describeProof(undefined);

    assert.equal(caveats.length, 1);
    assert.match(caveats[0], /untested/);
  });
});
