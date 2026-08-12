import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeProofs,
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
    assert.deepEqual(judgeInstrument(SOUND), { sound: true, failures: [], firedChecks: [] });
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
    assert.deepEqual(judgeRun([SOUND, SOUND]), { sound: true, failures: [], firedChecks: [], soundSamples: 2 });
  });
});

/**
 * The half of the guard that had never been checked. `judgeRun` can say a run was sound; only the
 * proof says whether it could have said anything else, and under Playwright's default flags two of
 * the three checks cannot fail at all.
 */
describe('reporting whether the guard could have failed', () => {
  const TIMER: InstrumentProof = {
    sensor: 'timerDriftRatio',
    degradation: 'its main thread blocked for 3000ms',
    rejected: true,
    firedChecks: ['timerDriftRatio'],
  };
  const VISIBILITY: InstrumentProof = {
    sensor: 'visibilityState',
    degradation: "document.visibilityState overridden to 'hidden'",
    rejected: true,
    firedChecks: ['visibilityState'],
  };

  it('says nothing when every sensor was proven, so a real verdict reads as one', () => {
    assert.deepEqual(describeProofs([TIMER, VISIBILITY]), []);
  });

  it('names the degradation the instrument failed to notice', () => {
    const caveats = describeProofs([{ ...TIMER, rejected: false, firedChecks: [] }, VISIBILITY]);

    assert.equal(caveats.length, 1);
    assert.match(caveats[0], /main thread blocked for 3000ms/);
    assert.match(caveats[0], /restatement of the launch flags rather than evidence/);
  });

  /**
   * The failure this exists to stop: proving one sensor and letting the report imply the other was
   * proven too. Before 2026-08-12 only the timer sensor had a proof and the report said "the check"
   * as though there were one.
   */
  it('names a sensor that has no proof at all, rather than passing on the strength of another', () => {
    const caveats = describeProofs([TIMER]);

    assert.equal(caveats.length, 1);
    assert.match(caveats[0], /visibilityState check was never shown able to fail/);
  });

  /**
   * A proof that fired for the wrong reason has demonstrated the wrong sensor. A stalled page reports
   * hidden nowhere, but a visibility proof taken on a page that happened to also stall would be
   * rejected, and without this it would read as the visibility check working.
   */
  it('rejects a proof that fired by a different check than the one it claims', () => {
    const caveats = describeProofs([TIMER, { ...VISIBILITY, firedChecks: ['timerDriftRatio'] }]);

    assert.equal(caveats.length, 1);
    assert.match(caveats[0], /by timerDriftRatio rather than by visibilityState/);
    assert.match(caveats[0], /still untested/);
  });

  /**
   * Every run recorded before 2026-08-12 carries no proof, and the archive still has to render. A
   * missing proof is reported as an untested verdict rather than passed over, because silence here
   * would be indistinguishable from a proof that fired.
   */
  it('treats a missing proof as untested rather than as passing', () => {
    for (const absent of [undefined, []]) {
      const caveats = describeProofs(absent);

      assert.equal(caveats.length, 1);
      assert.match(caveats[0], /untested/);
    }
  });
});
