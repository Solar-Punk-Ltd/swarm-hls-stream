import { Duration } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type BatchLimits, batchWarning, bucketCapacity } from '../src/lib/stamp.js';

const DAY_SECONDS = 86_400;

/**
 * A batch as Bee reports one, with the fields this reads and nothing else.
 *
 * `usage` is derived here the way bee-js derives it, because a fixture that set it independently of
 * `utilization` could describe a batch no node would ever report. Every Bee batch has
 * `bucketDepth: 16`, so depth alone decides how many chunks a bucket holds: 22 gives 64, 24 gives 256.
 */
function batch(over: Partial<BatchLimits> = {}): BatchLimits {
  const depth = over.depth ?? 22;
  const bucketDepth = over.bucketDepth ?? 16;
  const utilization = over.utilization ?? 0;
  return {
    depth,
    bucketDepth,
    utilization,
    usage: utilization / 2 ** (depth - bucketDepth),
    duration: Duration.fromSeconds(30 * DAY_SECONDS),
    immutableFlag: true,
    ...over,
  };
}

/**
 * The denominator `utilization` is counted against.
 *
 * ⚠️ It is the count in the FULLEST bucket, so a batch is out of room long before its nominal
 * `2^depth` chunks are used, and the bare number Bee reports cannot be read without this beside it.
 */
describe('how many chunks a bucket of a batch holds', () => {
  it('is 64 at depth 22 and 256 at depth 24', () => {
    assert.equal(bucketCapacity({ depth: 22, bucketDepth: 16 }), 64);
    assert.equal(bucketCapacity({ depth: 24, bucketDepth: 16 }), 256);
  });

  // The same raw utilization is a different amount of trouble at a different depth, which is the
  // whole reason it cannot be read on its own.
  it('makes fifty chunks nearly full at depth 22 and nearly empty at depth 24', () => {
    assert.ok(50 / bucketCapacity({ depth: 22, bucketDepth: 16 }) > 0.75);
    assert.ok(50 / bucketCapacity({ depth: 24, bucketDepth: 16 }) < 0.2);
  });
});

/**
 * When a postage batch is worth saying something about.
 *
 * ⛔ The measurement this exists for, 2026-08-04: batch `01cc77f9` at depth 22 read 9.4% used on
 * 08-03 and 64/64 on 08-04. One day of sweep traffic took it from nearly empty to full while its TTL,
 * the only thing anything watched, still had days on it. It was also mutable, so it refused nothing.
 * It began overwriting its own oldest chunks in silence.
 */
describe('when a postage batch is worth saying something about', () => {
  it('says nothing about a batch with room and time', () => {
    assert.equal(batchWarning(batch({ utilization: 8 })), null);
  });

  it('calls out a mutable batch by what filling it actually does', () => {
    const attention = batchWarning(batch({ utilization: 60, immutableFlag: false }));

    assert.match(attention ?? '', /overwrites its oldest chunk/);
    assert.match(attention ?? '', /nothing logged/);
  });

  // Both fill up. Only one of them tells anyone, and that difference is the whole finding.
  it('calls out a full immutable batch as refusing uploads instead', () => {
    const attention = batchWarning(batch({ utilization: 60 }));

    assert.match(attention ?? '', /refusing uploads/);
    assert.doesNotMatch(attention ?? '', /overwrites/);
  });

  it('warns on a short life even while the batch is nearly empty', () => {
    const attention = batchWarning(batch({ utilization: 1, duration: Duration.fromSeconds(DAY_SECONDS) }));

    assert.match(attention ?? '', /1.00 days left/);
  });

  it('says both when a batch is crowded and nearly expired', () => {
    const attention = batchWarning(
      batch({ utilization: 64, immutableFlag: false, duration: Duration.fromSeconds(DAY_SECONDS) }),
    );

    assert.match(attention ?? '', /100% full/);
    assert.match(attention ?? '', /1.00 days left/);
  });

  /**
   * The thresholds are the owner's, from the funding protocol: stop and ask at 75% of a bucket or
   * under 2 days. Pinned at the boundary because a sweep's rows are only comparable inside one
   * sitting, so a threshold that fires late wastes the runs already in the sweep rather than the
   * ones after it.
   */
  it('fires at three quarters full and not a chunk before', () => {
    assert.equal(batchWarning(batch({ utilization: 47 })), null, '47/64 is 73%');
    assert.ok(batchWarning(batch({ utilization: 48 })), '48/64 is exactly 75%');
  });

  it('fires under two days and not a moment before', () => {
    assert.equal(batchWarning(batch({ duration: Duration.fromSeconds(2 * DAY_SECONDS) })), null);
    assert.ok(batchWarning(batch({ duration: Duration.fromSeconds(2 * DAY_SECONDS - 1) })));
  });
});
