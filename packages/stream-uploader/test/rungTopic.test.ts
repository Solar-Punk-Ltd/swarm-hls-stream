/**
 * The feed topic a rung publishes on, which is derived from its ladder rather than minted per
 * session.
 *
 * ⛔ The pinned vector below is the point of this file. `rungTopicFor` is a promise that the same
 * (group, rung) names the same feed for ever: a rung that restarts mid-broadcast resumes the feed it
 * was already on, and the recording published under the old value is reachable only there. A change
 * to the namespace constant or to the bit fiddling would move every rung of every ladder somewhere
 * else and nothing else in this suite would notice.
 *
 * The algorithm itself was checked against RFC 4122's own worked example, `uuid5(NAMESPACE_DNS,
 * 'python.org') = 886313e1-3b8a-5372-9b90-0c9aee199e5d`, which this function cannot be asked for
 * because its namespace is fixed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rungTopicFor } from '../src/utils/rungTopic.js';

const UUID_V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * What the admin validates every topic it is handed against, copied here rather than imported: the
 * two repositories ship separately, and this is the contract between them.
 *
 * @see web2-admin/backend/src/schemas/stream.ts
 */
const ADMIN_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

describe("a rung's derived feed topic", () => {
  it('is the same string every time, so a restarted rung resumes the feed it was already on', () => {
    assert.equal(rungTopicFor('ladder-1', '720p'), rungTopicFor('ladder-1', '720p'));
  });

  it('is this exact value for this exact ladder, which is what the derivation promises', () => {
    assert.equal(rungTopicFor('ladder-1', '720p'), 'cc69fd38-3013-5bb8-8a8d-65917ad03511');
  });

  it('differs per rung, so four rungs of one ladder do not write over each other', () => {
    const topics = ['360p', '720p', '1080p', 'audio'].map((rung) => rungTopicFor('ladder-1', rung));
    assert.equal(new Set(topics).size, topics.length);
  });

  it('differs per group, which is what keeps one broadcast off the last one’s feeds', () => {
    assert.notEqual(rungTopicFor('ladder-1', '720p'), rungTopicFor('ladder-2', '720p'));
  });

  /**
   * ⚠️ The name hashed is `group/rung`, so `a/b` + `c` and `a` + `b/c` are one name and one topic.
   * Neither argument can carry a `/`: a group is a uuid or a declared topic, both of which are
   * validated against `UUID_RE`, and a rung name comes from `AbrLadder`'s own fixed set. Pinned so
   * that a future caller passing something freer trips a failure here rather than merging two rungs
   * onto one feed.
   */
  it('takes a group and a rung that cannot themselves contain the separator', () => {
    assert.equal(rungTopicFor('a/b', 'c'), rungTopicFor('a', 'b/c'));
  });

  it('is a version-5 UUID, lowercase and hyphenated', () => {
    assert.match(rungTopicFor('ladder-1', '720p'), UUID_V5_RE);
  });

  it('is accepted by the shape the admin validates a topic against', () => {
    assert.match(rungTopicFor('declared-topic-0001', '1080p'), ADMIN_UUID_RE);
  });
});
