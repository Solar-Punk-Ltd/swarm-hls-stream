import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeRouting, publisherRoutingRefusal, type RoutingFacts } from '../src/publisherRouting.js';

const LADDER = ['360p', '480p', '720p', '1080p'];
const BATCH = 'abcdef12…';

const live = (rung: string, port: number) => ({ rung, url: `http://127.0.0.1:${port}`, batch: BATCH });

const SPLIT_DECLARATION =
  `360p@http://127.0.0.1:10075<${'1'.repeat(64)}> 480p@http://127.0.0.1:11071<${'2'.repeat(64)}> ` +
  `720p@http://127.0.0.1:11073<${'3'.repeat(64)}> 1080p@http://127.0.0.1:11075<${'4'.repeat(64)}>`;

const SPLIT_LIVE = [live('360p', 10075), live('480p', 11071), live('720p', 11073), live('1080p', 11075)];

function facts(over: Partial<RoutingFacts> = {}): RoutingFacts {
  return { declared: SPLIT_DECLARATION, abrEnabled: true, abrRungs: LADDER, live: SPLIT_LIVE, ...over };
}

/**
 * ⛔⛔⛔ **The gate for the failure that cost this project days.** Every rung of the ladder was being
 * published through one shared Bee node. Nothing anywhere refused that, nothing reported it, and a
 * note saying the per-rung split had never happened sat in memory being read as a caveat on the
 * numbers rather than as the reason the numbers were wrong. Eleven live arms were scored against
 * viewer behaviour while the publisher was the constraint.
 *
 * A threshold you wrote down is not a control. This is the control: the deployment declares a shape
 * in BEE_PUBLISHERS, the uploader reports the shape it is actually running on `/health`, and a sitting
 * does not start unless the two agree.
 *
 * ⚠️ It compares rung names and each node's `host:port`, never whole url strings. The live url has had
 * any userinfo removed and its query redacted before it reaches the wire, so it is not always
 * byte-identical to what was configured, while `host:port` is unaffected by either and is what
 * actually decides which node a rung is paying through.
 */
describe('publisherRoutingRefusal', () => {
  it('clears a split deployment whose live routing matches what is declared', () => {
    assert.equal(publisherRoutingRefusal(facts()), null);
  });

  it('clears an unsplit deployment that declares nothing and runs one node', () => {
    assert.equal(
      publisherRoutingRefusal(
        facts({ declared: '', live: [{ rung: 'all', url: 'http://bee-uploader:1633', batch: BATCH }] }),
      ),
      null,
    );
  });

  /**
   * ⛔ The one this file exists for. Four rungs declared on four nodes, one node carrying all four,
   * and every other reading of the stage identical to a correctly split one.
   */
  it('refuses the stage that declares one node per rung and is running one node for all of them', () => {
    const refusal = publisherRoutingRefusal(
      facts({ live: [{ rung: 'all', url: 'http://bee-uploader:1633', batch: BATCH }] }),
    );

    assert.match(refusal ?? '', /declares 4 node\(s\)/);
    assert.match(refusal ?? '', /one node for every rung/);
    assert.match(refusal ?? '', /restart/i);
  });

  /** The reverse staleness: the container has a routing the env file no longer describes. */
  it('refuses a live routing that is split while the declaration is empty', () => {
    const refusal = publisherRoutingRefusal(facts({ declared: '' }));

    assert.match(refusal ?? '', /BEE_PUBLISHERS is empty/);
  });

  it('refuses a declaration that names a rung the live routing does not', () => {
    const refusal = publisherRoutingRefusal(facts({ live: SPLIT_LIVE.slice(0, 3) }));

    assert.match(refusal ?? '', /1080p/);
    assert.match(refusal ?? '', /declared but not live/);
  });

  it('refuses a live routing that names a rung the declaration does not', () => {
    const refusal = publisherRoutingRefusal(facts({ live: [...SPLIT_LIVE, live('2160p', 11077)] }));

    assert.match(refusal ?? '', /2160p/);
    assert.match(refusal ?? '', /live but not declared/);
  });

  it('refuses a rung whose live node is not the one declared for it', () => {
    const swapped = [live('360p', 10075), live('480p', 11073), live('720p', 11071), live('1080p', 11075)];
    const refusal = publisherRoutingRefusal(facts({ live: swapped }));

    assert.match(refusal ?? '', /480p/);
    assert.match(refusal ?? '', /11071/);
    assert.match(refusal ?? '', /11073/);
  });

  /**
   * ⛔ Absence is a refusal. An uploader built before the routing existed answers `/health` without
   * the field, and reading that as "no publishers" would clear every deployment on earth.
   */
  it('refuses a routing the uploader did not report at all', () => {
    assert.match(publisherRoutingRefusal(facts({ live: undefined })) ?? '', /did not report/);
    assert.match(publisherRoutingRefusal(facts({ live: [] })) ?? '', /did not report/);
  });

  /** The uploader refuses to start in this state. Said plainly here so a stale env reads as itself. */
  it('refuses per-rung publishers with the ladder off', () => {
    const refusal = publisherRoutingRefusal(facts({ abrEnabled: false }));

    assert.match(refusal ?? '', /ABR_ENABLED/);
  });

  it('refuses a ladder rung that neither side routes', () => {
    const refusal = publisherRoutingRefusal(facts({ abrRungs: [...LADDER, '1440p'] }));

    assert.match(refusal ?? '', /1440p/);
    assert.match(refusal ?? '', /ABR_LADDER/);
  });

  it('ignores userinfo and a redacted query when comparing a node, since the live url has had both removed', () => {
    const declared =
      `360p@http://operator:hunter2@127.0.0.1:10075<${'1'.repeat(64)}> ` +
      `480p@http://127.0.0.1:11071/?token=hunter2<${'2'.repeat(64)}> ` +
      `720p@http://127.0.0.1:11073<${'3'.repeat(64)}> 1080p@http://127.0.0.1:11075<${'4'.repeat(64)}>`;

    assert.equal(publisherRoutingRefusal(facts({ declared })), null);
  });

  /** Legal, and deliberately not a refusal: which rung shares which node is the operator's call. */
  it('clears two rungs declared on one node', () => {
    const declared =
      `360p@http://127.0.0.1:10075<${'1'.repeat(64)}> 480p@http://127.0.0.1:10075<${'1'.repeat(64)}> ` +
      `720p@http://127.0.0.1:11073<${'3'.repeat(64)}> 1080p@http://127.0.0.1:11075<${'4'.repeat(64)}>`;
    const liveShared = [live('360p', 10075), live('480p', 10075), live('720p', 11073), live('1080p', 11075)];

    assert.equal(publisherRoutingRefusal(facts({ declared, live: liveShared })), null);
  });

  it('refuses a declaration it cannot read rather than clearing the run', () => {
    assert.match(publisherRoutingRefusal(facts({ declared: 'this is not a publisher list' })) ?? '', /cannot be read/);
  });
});

describe('describeRouting', () => {
  it('names every rung, its node and its batch, and how many nodes that is', () => {
    const described = describeRouting(SPLIT_LIVE);

    assert.match(described, /4 node\(s\)/);
    for (const rung of LADDER) {
      assert.match(described, new RegExp(rung));
    }
    assert.match(described, /10075/);
    assert.match(described, /abcdef12/);
  });

  it('says an unsplit deployment is one node carrying everything', () => {
    const described = describeRouting([{ rung: 'all', url: 'http://bee-uploader:1633', batch: BATCH }]);

    assert.match(described, /1 node\(s\)/);
    assert.match(described, /all/);
  });
});
