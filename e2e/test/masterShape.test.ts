import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { feedTopicHexOf } from '../src/browser/rungManifest.js';
import { masterRungRefusal, masterRungsOf } from '../src/harness/masterShape.js';

/**
 * Which qualities a ladder's master playlist is offering a viewer who joins now.
 *
 * ## What a master playlist is, in one sentence
 *
 * One small text file per ladder, published to a feed of its own, naming every rendition a player
 * may choose and where each one's playlist lives.
 *
 * ## ⛔ Why this had no reader until the drain suites needed one
 *
 * `service/abr-ladder.test.ts` says outright that it does not assert the master is correct: it reads
 * the uploader's log, which can say four rungs published and nothing about what a viewer is offered.
 * The master's TEXT is owned by `packages/shared/test/masterPlaylist.test.ts` and reading it back is
 * owned by `packages/client/test/ladderSource.test.ts`, both on fixtures. Nothing had ever read the
 * one a paid broadcast actually published.
 *
 * That is the reading a drain needs. A rung going quiet is only half the feature. The other half is
 * that the master stops offering it, so a viewer joining during the drain is not handed a quality
 * with nothing behind it.
 *
 * ## ⛔ Rungs are joined by TOPIC, never by resolution
 *
 * A master carries `RESOLUTION=1920x1080` and a `swarm://` feed address per rendition, and no rung
 * name at all: rung names are the uploader's, and the master speaks a player's language. Matching on
 * the geometry would mean holding a second copy of the ladder's name-to-height mapping here and
 * would break on any two rungs sharing a height. The topic is exact, it is what the rung announce
 * already carries, and it is what the player itself resolves.
 */

const OWNER = 'a'.repeat(40);
const TOPICS = {
  '360p': '11111111-1111-4111-8111-111111111111',
  '480p': '22222222-2222-4222-8222-222222222222',
  '720p': '33333333-3333-4333-8333-333333333333',
  '1080p': '44444444-4444-4444-8444-444444444444',
} as const;

const RUNG_BY_TOPIC = new Map(Object.entries(TOPICS).map(([rung, topic]) => [topic, rung]));

/** The renditions in the order a master lists them, which is lowest first. */
function master(rungs: readonly (keyof typeof TOPICS)[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const rung of rungs) {
    lines.push('#EXT-X-STREAM-INF:BANDWIDTH=700000,AVERAGE-BANDWIDTH=650000,RESOLUTION=640x360');
    lines.push(`swarm://${OWNER}/${TOPICS[rung]}`);
  }
  return `${lines.join('\n')}\n`;
}

const FULL_LADDER = ['360p', '480p', '720p', '1080p'] as const;
const SURVIVORS = ['360p', '480p', '720p'] as const;

describe('masterRungsOf', () => {
  it('names every rung a full master offers, in the order it lists them', () => {
    const read = masterRungsOf(master(FULL_LADDER), RUNG_BY_TOPIC);

    assert.equal(read.isMaster, true);
    assert.deepEqual(read.offered, [...FULL_LADDER]);
    assert.deepEqual(read.unclaimedTopics, []);
  });

  it('names three rungs once the master has dropped one', () => {
    assert.deepEqual(masterRungsOf(master(SURVIVORS), RUNG_BY_TOPIC).offered, [...SURVIVORS]);
  });

  /**
   * ⛔ A media playlist is not a master with no rungs. A rung feed answers with its own segment list,
   * and reading that as an empty ladder would report a broadcast offering nothing.
   */
  it('says a media playlist is not a master rather than reading it as an empty ladder', () => {
    const media = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXTINF:1.0,', 'abc123', ''].join('\n');
    const read = masterRungsOf(media, RUNG_BY_TOPIC);

    assert.equal(read.isMaster, false);
    assert.deepEqual(read.offered, []);
  });

  it('says an empty body is not a master', () => {
    assert.equal(masterRungsOf('', RUNG_BY_TOPIC).isMaster, false);
  });

  /**
   * ⭐ The topics in a master are the rung topics as `MasterFeedWriter` wrote them, and a rung
   * announce carries the same raw form, so the two normally match verbatim. Both sides are hashed
   * before comparison anyway, because a gateway route wants the hashed form and either producer is
   * free to use it.
   */
  it('matches a topic the master carries already hashed', () => {
    const hashed = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=700000,AVERAGE-BANDWIDTH=650000,RESOLUTION=640x360',
      `swarm://${OWNER}/${feedTopicHexOf(TOPICS['360p'])}`,
      '',
    ].join('\n');

    assert.deepEqual(masterRungsOf(hashed, RUNG_BY_TOPIC).offered, ['360p']);
  });

  /**
   * ⛔ A feed this ladder never announced is reported apart from the rungs, rather than dropped. It
   * means the master being read belongs to another broadcast, and a suite that silently ignored it
   * would compare a stranger's ladder against its own expectation.
   */
  it('reports a topic no rung of this ladder announced', () => {
    const stranger = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=700000,AVERAGE-BANDWIDTH=650000,RESOLUTION=640x360',
      `swarm://${OWNER}/99999999-9999-4999-8999-999999999999`,
      '',
    ].join('\n');
    const read = masterRungsOf(stranger, RUNG_BY_TOPIC);

    assert.deepEqual(read.offered, []);
    assert.equal(read.unclaimedTopics.length, 1);
  });

  /** A tag with no URI under it names no feed, and a master that ends on one must not invent a rung. */
  it('skips a rendition tag with nothing under it', () => {
    const truncated = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=700000,AVERAGE-BANDWIDTH=650000,RESOLUTION=640x360',
      `swarm://${OWNER}/${TOPICS['360p']}`,
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4800000,RESOLUTION=1920x1080',
      '',
    ].join('\n');

    assert.deepEqual(masterRungsOf(truncated, RUNG_BY_TOPIC).offered, ['360p']);
  });
});

describe('masterRungRefusal', () => {
  it('clears a master offering exactly the rungs that survived', () => {
    assert.equal(masterRungRefusal(masterRungsOf(master(SURVIVORS), RUNG_BY_TOPIC), SURVIVORS), null);
  });

  it('clears a master whose order differs from the expectation', () => {
    assert.equal(masterRungRefusal(masterRungsOf(master(SURVIVORS), RUNG_BY_TOPIC), ['720p', '360p', '480p']), null);
  });

  /**
   * ⛔⛔ The assertion the drain scenario exists for. A master still naming the drained rung offers a
   * viewer who joins now a quality with nothing behind it.
   */
  it('refuses a master still offering the rung that went quiet', () => {
    const refusal = masterRungRefusal(masterRungsOf(master(FULL_LADDER), RUNG_BY_TOPIC), SURVIVORS);

    assert.ok(refusal, 'a master that dropped nothing has to fail this run');
    assert.match(refusal, /1080p/);
  });

  /**
   * ⛔ The other direction, and it is the more expensive mistake. The dead-rung rule drops at most one
   * rung at a time, so a master down to two has taken a healthy rung out from under viewers who were
   * watching it.
   */
  it('refuses a master that dropped a rung nothing drained', () => {
    const refusal = masterRungRefusal(masterRungsOf(master(['360p', '480p']), RUNG_BY_TOPIC), SURVIVORS);

    assert.ok(refusal, 'a master missing a surviving rung has to fail this run');
    assert.match(refusal, /720p/);
  });

  it('refuses a body that is not a master playlist at all', () => {
    const refusal = masterRungRefusal(masterRungsOf('', RUNG_BY_TOPIC), SURVIVORS);

    assert.ok(refusal, 'nothing read is not a passing read');
    assert.match(refusal, /#EXT-X-STREAM-INF/);
  });

  it('refuses a master naming a feed this ladder never announced', () => {
    const mixed = [
      master(SURVIVORS).trimEnd(),
      '#EXT-X-STREAM-INF:BANDWIDTH=700000,AVERAGE-BANDWIDTH=650000,RESOLUTION=640x360',
      `swarm://${OWNER}/99999999-9999-4999-8999-999999999999`,
      '',
    ].join('\n');

    const refusal = masterRungRefusal(masterRungsOf(mixed, RUNG_BY_TOPIC), SURVIVORS);

    assert.ok(refusal, 'a stranger feed in the master has to be surfaced');
    assert.match(refusal, /99999999/);
  });
});
