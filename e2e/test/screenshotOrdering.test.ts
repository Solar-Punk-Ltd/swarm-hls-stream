import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SCREENSHOT_EVERY, screenshotIndexWidth } from '../src/browser/watchLoop.js';

/** The names `sampleFor` writes for a run of this many samples, in the order it writes them. */
function screenshotNames(totalSamples: number): string[] {
  const width = screenshotIndexWidth(totalSamples);
  const names: string[] = [];
  for (let index = 1; index <= totalSamples; index += 1) {
    if (index % SCREENSHOT_EVERY === 1) {
      names.push(`sample-${String(index).padStart(width, '0')}.png`);
    }
  }
  return names;
}

/**
 * That a run's screenshots sort in the order they were taken.
 *
 * The padding was a fixed four. At one sample a second a run passing 9,999 samples wrote
 * `sample-10020.png` beside `sample-9990.png`, and every image after 2h47m sorted before the ones
 * that came earlier. Nothing here had ever run that long, so the only run it would have appeared in
 * is the first four-hour broadcast, whose screenshots are the sole glass-to-glass evidence it leaves.
 */
describe('screenshots from a long watch sort in the order they were taken', () => {
  it('orders a four-hour run at one sample a second', () => {
    const names = screenshotNames(4 * 60 * 60);

    assert.deepEqual(names, [...names].sort());
  });

  it('orders a ten-hour run, since the projection this measures goes that far', () => {
    const names = screenshotNames(10 * 60 * 60);

    assert.deepEqual(names, [...names].sort());
  });

  it('orders a three-minute run, the default watch, without over-padding it', () => {
    const names = screenshotNames(180);

    assert.deepEqual(names, [...names].sort());
    assert.equal(names[0], 'sample-001.png');
  });

  /**
   * The case the fixed width got wrong, asserted directly rather than only through a sort, so a
   * regression names the boundary instead of failing on an array comparison nobody can read.
   */
  it('pads either side of ten thousand to the same width', () => {
    const width = screenshotIndexWidth(14_400);

    assert.equal(String(9_990).padStart(width, '0').length, String(10_020).padStart(width, '0').length);
    assert.ok(String(9_990).padStart(width, '0') < String(10_020).padStart(width, '0'));
  });

  it('never pads to nothing, however short the run', () => {
    assert.equal(screenshotIndexWidth(0), 1);
    assert.equal(screenshotIndexWidth(1), 1);
  });
});
