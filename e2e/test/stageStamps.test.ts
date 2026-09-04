import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type NodeStampReading, stageStampsRefusal } from '../src/harness/stageStamps.js';

/**
 * ⛔⛔⛔ **The gate for a single-node instrument speaking for a four-node stage.** Every suite used to
 * open by reading `/stamps` on the coordinator and asserting the TTL it found, in a message written
 * as a statement about the whole stage. Since the per-rung split there are four publisher nodes with
 * four postage batches, so an expired batch on the 1080p node passed that check every time and turned
 * up tens of minutes later as a rung that stopped being produced, which reaches a viewer as an ABR
 * fault and gets scored as one.
 *
 * ⛔⛔ **And the second version of the same mistake, closed 2026-09-04.** The gate read each node's
 * BEST stamp rather than the batch `BEE_PUBLISHERS` routes that rung to, so a node holding one drained
 * batch (the configured one) and one fresh unused batch passed cleanly and then refused every upload
 * it made. Which batch a node is spending is decided in `BEE_PUBLISHERS`, so that is the only batch a
 * verdict about a rung can be about.
 *
 * These cover the rule rather than the reading, because the rule is the part that decides. Picking the
 * configured batch out of what a node lists is `readConfiguredBatch` in `harness/host.ts` and is
 * covered in `host.test.ts`. What is left of the reading side is wiring over `/health` and `/stamps`
 * and cannot run without a deployment.
 */

const MIN_TTL_S = 600;

function reading(over: Partial<NodeStampReading> = {}): NodeStampReading {
  return {
    rungs: ['360p'],
    port: 10075,
    batch: 'aabbccdd',
    state: 'held',
    ttlS: 86_400,
    utilizationPct: 12,
    problem: null,
    ...over,
  };
}

const HEALTHY_STAGE: NodeStampReading[] = [
  reading({ rungs: ['360p'], port: 10075, batch: '11111111' }),
  reading({ rungs: ['480p'], port: 11071, batch: '22222222' }),
  reading({ rungs: ['720p'], port: 11073, batch: '33333333' }),
  reading({ rungs: ['1080p'], port: 11075, batch: '44444444' }),
];

describe('stageStampsRefusal', () => {
  it('clears a four-node stage whose every batch has TTL to spare', () => {
    assert.equal(stageStampsRefusal(HEALTHY_STAGE, MIN_TTL_S), null);
  });

  it('clears an unsplit stage, where one node carries every rung', () => {
    const unsplit = [reading({ rungs: ['all'], port: 10075 })];

    assert.equal(stageStampsRefusal(unsplit, MIN_TTL_S), null);
  });

  /**
   * ⛔ Nothing to check is not the same as nothing wrong. A stage whose publishers were never
   * enumerated is the one case where every rung's postage is unknown at once, so passing it would be
   * the widest possible false green this gate can produce.
   */
  it('refuses a stage it read no nodes on at all', () => {
    const refusal = stageStampsRefusal([], MIN_TTL_S);

    assert.match(refusal ?? '', /publisher routing named none/);
    assert.match(refusal ?? '', /empty stage is not a passing one/);
    assert.match(refusal ?? '', /bee-publishers\.sh/);
  });

  /**
   * ⛔ The failure this file exists for. Three nodes fine, the top rung's batch nearly gone, and every
   * other reading of the stage identical to a healthy one.
   */
  it('refuses one expiring node out of four, naming its rungs, port, batch and TTL', () => {
    const refusal = stageStampsRefusal(
      [...HEALTHY_STAGE.slice(0, 3), reading({ rungs: ['1080p'], port: 11075, batch: '44444444', ttlS: 412 })],
      MIN_TTL_S,
    );

    assert.match(refusal ?? '', /^1 of 4 Bee node\(s\)/);
    assert.match(refusal ?? '', /1080p on :11075/);
    assert.match(refusal ?? '', /batch 44444444/);
    assert.match(refusal ?? '', /412s of TTL left/);
    assert.match(refusal ?? '', /more than 600s/);
    assert.match(refusal ?? '', /bee-publishers\.sh/);
  });

  it('names every failing node rather than stopping at the first', () => {
    const refusal =
      stageStampsRefusal(
        [
          HEALTHY_STAGE[0],
          reading({ rungs: ['480p'], port: 11071, batch: '22222222', ttlS: 30 }),
          HEALTHY_STAGE[2],
          reading({
            rungs: ['1080p'],
            port: 11075,
            batch: '44444444',
            state: 'unread',
            ttlS: null,
            utilizationPct: null,
            problem: 'nothing usable after 60s',
          }),
        ],
        MIN_TTL_S,
      ) ?? '';

    assert.match(refusal, /^2 of 4 Bee node\(s\)/);
    assert.match(refusal, /480p on :11071/);
    assert.match(refusal, /1080p on :11075/);
    assert.doesNotMatch(refusal, /360p/, 'a healthy node must not be named as failing');
    assert.doesNotMatch(refusal, /720p/, 'a healthy node must not be named as failing');
  });

  /** A node that answered with no usable stamp, or did not answer at all, is refused with what it said. */
  it('refuses a node that offered no usable stamp, and quotes what it said instead', () => {
    const refusal = stageStampsRefusal(
      [
        ...HEALTHY_STAGE.slice(0, 3),
        reading({
          rungs: ['1080p'],
          port: 11075,
          batch: '44444444',
          state: 'unread',
          ttlS: null,
          utilizationPct: null,
          problem: 'non-JSON from GET :11075/stamps, after 60s of polling',
        }),
      ],
      MIN_TTL_S,
    );

    assert.match(refusal ?? '', /1080p on :11075 has no usable batch at all/);
    assert.match(refusal ?? '', /non-JSON from GET :11075\/stamps/);
  });

  /**
   * ⛔⛔⛔ **The failure that reopened this file on 2026-09-04.** The 1080p node holds its configured
   * batch and bee will not stamp with it, while a fresh unused batch sits beside it on the same node.
   * The old gate read the fresh one, called the stage healthy, and the rung then refused every upload
   * it made. The reading here is of the configured batch, so the verdict has to refuse.
   */
  it('refuses a node whose configured batch is there and unusable', () => {
    const refusal =
      stageStampsRefusal(
        [
          ...HEALTHY_STAGE.slice(0, 3),
          reading({
            rungs: ['1080p'],
            port: 11075,
            batch: '44444444',
            state: 'unusable',
            problem: 'usable=false exists=true, after 60s of polling',
          }),
        ],
        MIN_TTL_S,
      ) ?? '';

    assert.match(refusal, /^1 of 4 Bee node\(s\)/);
    assert.match(refusal, /1080p on :11075 holds configured batch 44444444/);
    assert.match(refusal, /usable=false exists=true/);
    assert.match(refusal, /bee-publishers\.sh/);
  });

  /**
   * ⛔ A rung routed to a batch its node does not have. The TTL on the reading is healthy, because it
   * is the TTL of nothing, so a rule that judged TTL alone would pass this.
   */
  it('refuses a node that does not hold its configured batch at all', () => {
    const refusal =
      stageStampsRefusal(
        [
          ...HEALTHY_STAGE.slice(0, 3),
          reading({
            rungs: ['1080p'],
            port: 11075,
            batch: '44444444',
            state: 'absent',
            ttlS: null,
            utilizationPct: null,
            problem: 'the node lists 99999999, after 60s of polling',
          }),
        ],
        MIN_TTL_S,
      ) ?? '';

    assert.match(refusal, /^1 of 4 Bee node\(s\)/);
    assert.match(refusal, /1080p on :11075 does not hold configured batch 44444444/);
    assert.match(refusal, /BEE_PUBLISHERS/);
    assert.match(refusal, /the node lists 99999999/);
  });

  /**
   * ⭐ The verdict is about the batch the routing names and about nothing else on the node. Pinned so
   * that "but there was a healthier batch right there" can never come back as a reason to pass.
   */
  it('names the configured batch rather than any other the node holds', () => {
    const refusal =
      stageStampsRefusal(
        [
          reading({
            batch: '44444444',
            state: 'absent',
            ttlS: null,
            utilizationPct: null,
            problem: 'the node lists 11111111, 22222222',
          }),
        ],
        MIN_TTL_S,
      ) ?? '';

    assert.match(refusal, /configured batch 44444444/);
    assert.doesNotMatch(refusal, /batch 11111111 has/, 'a batch the rung is not routed to is not the subject');
  });

  /** Two rungs on one node is a real topology, and the refusal has to name both of them. */
  it('names both rungs when one node carries two of them', () => {
    const refusal = stageStampsRefusal([reading({ rungs: ['720p', '1080p'], port: 11073, ttlS: 100 })], MIN_TTL_S);

    assert.match(refusal ?? '', /720p, 1080p on :11073/);
  });

  /**
   * ⛔ The boundary is strict, exactly as the assertion this replaced drew it. A batch holding precisely
   * the floor has no headroom for the run about to start, so it expires during the very broadcast the
   * gate was asked about.
   */
  it('refuses a TTL equal to the minimum and clears one second above it', () => {
    assert.notEqual(stageStampsRefusal([reading({ ttlS: MIN_TTL_S })], MIN_TTL_S), null);
    assert.equal(stageStampsRefusal([reading({ ttlS: MIN_TTL_S + 1 })], MIN_TTL_S), null);
  });

  /** A zero TTL is an expired batch, not an absent reading, and must not fall through as one. */
  it('refuses a batch whose TTL has run out', () => {
    assert.match(stageStampsRefusal([reading({ ttlS: 0 })], MIN_TTL_S) ?? '', /0s of TTL left/);
  });

  /**
   * ⛔⛔ The fill is carried for the smoke run to PRINT and this rule deliberately does not read it.
   * How full a batch is belongs to `deploy/scripts/stamp-guard.sh` and to the uploader's own
   * `PostageGate`, both of which refuse a batch too full to take the next chunk. A third opinion here
   * would mean an operator had to work out which of the three had stopped them.
   *
   * ⭐ Pinned rather than left implicit, because "it also refuses at 95%" is the change somebody makes
   * in good faith, and the refusal it adds fires on a stage the two real gates were about to explain
   * properly.
   *
   * ⚠️ The fill is now the CONFIGURED batch's fill, which is the number that matters and also the one
   * that reads alarmingly on a small batch. A depth 17 batch has two chunks per bucket, so its first
   * chunk prints as 50% full. Still not a refusal, and the 50 below is exactly that stage.
   */
  it('clears a batch that is nearly full, because the fill is not this rule to judge', () => {
    assert.equal(stageStampsRefusal([reading({ utilizationPct: 50 })], MIN_TTL_S), null);
    assert.equal(stageStampsRefusal([reading({ utilizationPct: 99.6 })], MIN_TTL_S), null);
    assert.equal(stageStampsRefusal([reading({ utilizationPct: 100 })], MIN_TTL_S), null);
  });

  /** And a node that is failing for a real reason is still named by that reason, not by its fill. */
  it('never mentions the fill in a refusal, which would read as the reason for it', () => {
    const refusal = stageStampsRefusal([reading({ ttlS: 30, utilizationPct: 97 })], MIN_TTL_S) ?? '';

    assert.match(refusal, /30s of TTL left/);
    assert.doesNotMatch(refusal, /97/);
  });
});
