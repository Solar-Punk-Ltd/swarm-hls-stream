import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRemoteEpochMs, skewFrom, tightestSkew } from '../src/bench/clockSkew.js';
import type { ClockSkew } from '../src/bench/split.js';

const LOCAL_BEFORE = 1_785_677_886_000;

describe('estimating the skew between two clocks', () => {
  it('reports no skew for a host that answered from the middle of the round trip', () => {
    const skew = skewFrom(LOCAL_BEFORE, LOCAL_BEFORE + 20, LOCAL_BEFORE + 40);

    assert.equal(skew.offsetMs, 0);
    assert.equal(skew.uncertaintyMs, 20);
  });

  it('reports a host running ahead as a positive offset', () => {
    assert.equal(skewFrom(LOCAL_BEFORE, LOCAL_BEFORE + 1_520, LOCAL_BEFORE + 40).offsetMs, 1_500);
  });

  it('reports a host running behind as a negative offset', () => {
    assert.equal(skewFrom(LOCAL_BEFORE, LOCAL_BEFORE - 480, LOCAL_BEFORE + 40).offsetMs, -500);
  });

  /**
   * The uncertainty is the whole reason several exchanges are taken. It bounds how wrong the offset
   * can be, so a reading taken behind an unrelated command on the multiplexed ssh connection has to
   * lose to a quicker one rather than being averaged into it.
   */
  it('keeps the exchange whose round trip left least room to be wrong', () => {
    const slow = skewFrom(LOCAL_BEFORE, LOCAL_BEFORE + 900, LOCAL_BEFORE + 1_800);
    const quick = skewFrom(LOCAL_BEFORE, LOCAL_BEFORE + 12, LOCAL_BEFORE + 24);

    assert.equal(tightestSkew([slow, quick]), quick);
    assert.equal(tightestSkew([quick, slow]), quick);
  });

  it('refuses to choose from nothing rather than returning a zero skew', () => {
    assert.throws(() => tightestSkew([]), /no clock skew samples/);
  });

  /**
   * `Date.now()` is not monotonic, so an NTP step between the two readings that bound an exchange
   * produces a round trip of negative length. Ranked by uncertainty ascending, that exchange sorts
   * first: the more corrupt the reading, the tighter it looks, and it is also the one whose offset is
   * the midpoint of two instants straddling the step.
   */
  it('drops an exchange whose clock stepped, rather than ranking it as the tightest', () => {
    const stepped: ClockSkew = { offsetMs: -40_000, uncertaintyMs: -1_500 };
    const usable: ClockSkew = { offsetMs: 184, uncertaintyMs: 200 };

    assert.equal(tightestSkew([stepped, usable]), usable);
    assert.equal(tightestSkew([usable, stepped]), usable);
  });

  it('keeps an exchange that came back inside the clock resolution', () => {
    const instant: ClockSkew = { offsetMs: 184, uncertaintyMs: 0 };

    assert.equal(tightestSkew([{ offsetMs: 184, uncertaintyMs: 12 }, instant]), instant);
  });

  it('refuses to estimate at all when every exchange stepped', () => {
    assert.throws(
      () =>
        tightestSkew([
          { offsetMs: 1, uncertaintyMs: -1 },
          { offsetMs: 2, uncertaintyMs: -9 },
        ]),
      /negative round trip/,
    );
  });
});

/**
 * The failure this guards is quiet and large. `date +%s%3N` on a BSD `date` prints the literal
 * `1785677886%3N` or similar, and reading that as a number places the host clock decades away, which
 * drives two hops of every split to absurd values while the total still looks perfectly normal.
 */
describe('reading the host clock', () => {
  it('reads epoch milliseconds', () => {
    assert.equal(parseRemoteEpochMs('1785677886123\n'), 1_785_677_886_123);
  });

  it('refuses a date that printed the format specifier instead of nanoseconds', () => {
    assert.throws(() => parseRemoteEpochMs('1785677886%3N'), /not epoch milliseconds/);
  });

  it('refuses epoch seconds, which are the same command minus its precision', () => {
    assert.throws(() => parseRemoteEpochMs('1785677886'), /not epoch milliseconds/);
  });

  it('refuses an empty answer rather than reading it as the epoch', () => {
    assert.throws(() => parseRemoteEpochMs(''), /not epoch milliseconds/);
  });
});
