/**
 * `scheduledStartTime` comes off a catalog feed as unchecked JSON and is explicitly `null` on an
 * announced broadcast whose time is not fixed yet, so both the browse card and the watch page have to
 * answer "there is no time here" without rendering the words "Invalid Date" at a viewer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { scheduledStartLabel } from '../src/utils/scheduledStart';

describe('the start time an announced broadcast shows', () => {
  it('formats an ISO timestamp for the reader rather than printing it raw', () => {
    const label = scheduledStartLabel('2026-09-20T18:30:00.000Z');

    assert.notEqual(label, null);
    assert.notEqual(label, '2026-09-20T18:30:00.000Z', 'the point is to render it in the reader’s own clock');
    assert.match(label ?? '', /2026/);
  });

  /**
   * The entry's own `timestamp` field beside this one is epoch milliseconds, so a publisher sending
   * the same shape here is a mistake worth rendering rather than dropping.
   */
  it('accepts epoch milliseconds, which is the shape of the field next to it', () => {
    assert.match(scheduledStartLabel(Date.UTC(2026, 8, 20, 18, 30)) ?? '', /2026/);
  });

  it('has nothing to say for a time that was never fixed', () => {
    assert.equal(scheduledStartLabel(null), null);
    assert.equal(scheduledStartLabel(undefined), null);
    assert.equal(scheduledStartLabel(''), null);
  });

  it('has nothing to say for a value that is not a time, rather than rendering Invalid Date', () => {
    assert.equal(scheduledStartLabel('soon'), null);
    assert.equal(scheduledStartLabel(Number.NaN), null);
  });
});
