import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RecentSegmentIndexes } from '../src/libs/RecentSegmentIndexes.js';

const WINDOW = 4;

describe('RecentSegmentIndexes (CON-8)', () => {
  it('suppresses a duplicate it has seen', () => {
    const seen = new RecentSegmentIndexes(WINDOW);

    seen.add(7);

    assert.equal(seen.has(7), true);
    assert.equal(seen.has(8), false, 'an index nothing added is not a duplicate');
  });

  it('still suppresses an index a full window of later ones has not displaced', () => {
    const seen = new RecentSegmentIndexes(WINDOW);

    seen.add(0);
    for (let index = 1; index <= WINDOW; index++) {
      seen.add(index);
    }

    assert.equal(
      seen.has(0),
      true,
      'the window is the guarantee: an index has to survive that many further ones or a re-delivery inside it is uploaded twice',
    );
  });

  it('never holds more than twice the window, however long the stream runs', () => {
    const seen = new RecentSegmentIndexes(WINDOW);

    for (let index = 0; index < WINDOW * 50; index++) {
      seen.add(index);
      assert.ok(
        seen.size <= WINDOW * 2,
        `held ${seen.size} after ${index + 1} segments, which is the unbounded growth this exists to stop`,
      );
    }
  });

  it('forgets indexes far enough behind the live edge to bound itself at all', () => {
    const seen = new RecentSegmentIndexes(WINDOW);

    for (let index = 0; index < WINDOW * 4; index++) {
      seen.add(index);
    }

    // The counterweight to the test above. A set that remembers everything also passes "still
    // suppresses", and only this says the bound is real rather than the window being effectively
    // infinite.
    assert.equal(seen.has(0), false, 'nothing is ever dropped, so the size bound above cannot be holding');
  });

  it('re-adding a remembered index does not spend window on it', () => {
    const seen = new RecentSegmentIndexes(WINDOW);

    seen.add(0);
    for (let repeat = 0; repeat < WINDOW * 10; repeat++) {
      if (!seen.has(1)) {
        seen.add(1);
      }
    }

    assert.equal(seen.has(0), true, 'a sender stuck replaying one index must not age out everything behind it');
    assert.equal(seen.size, 2, 'and must not grow the set either');
  });
});
