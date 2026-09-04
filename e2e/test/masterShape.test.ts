import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { feedTopicHexOf } from '../src/browser/rungManifest.js';
import { describeMaster, masterRungRefusal, masterRungsOf } from '../src/harness/masterShape.js';

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

/**
 * ⛔⛔⛔ The only thing filed about the master in either drain suite's artifact.
 *
 * It is what a suite prints beside its verdict and, since 2026-09-05, what a four minute wait says
 * when it ends in a timeout. So this sentence is the whole of what a reader has afterwards about what
 * a viewer was being offered, and it had no test at all.
 *
 * ⛔ Its "this is not a master" branch matters most and looks least important. It is what prints when
 * the gateway answered its own error envelope, and without the excerpt the line would read as a
 * broadcast offering no qualities at all, on a stage that was publishing perfectly.
 */
describe('describeMaster', () => {
  it('names how many rungs the master offers and which ones', () => {
    const body = master(FULL_LADDER);

    assert.equal(
      describeMaster(masterRungsOf(body, RUNG_BY_TOPIC), body),
      'the master offers 4 rung(s): 360p, 480p, 720p, 1080p',
    );
  });

  it('names the survivors after a rung has been dropped', () => {
    const body = master(SURVIVORS);

    assert.equal(
      describeMaster(masterRungsOf(body, RUNG_BY_TOPIC), body),
      'the master offers 3 rung(s): 360p, 480p, 720p',
    );
  });

  /**
   * ⛔ A master naming a feed no rung of this ladder announced is another broadcast's master, and
   * saying only which rungs were recognised would report a ladder short of a rung.
   */
  it('counts the feeds this ladder never announced, rather than passing over them', () => {
    const stranger = `${master(SURVIVORS)}#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1x1\nswarm://${OWNER}/${'9'.repeat(
      36,
    )}\n`;

    const said = describeMaster(masterRungsOf(stranger, RUNG_BY_TOPIC), stranger);

    assert.match(said, /the master offers 3 rung\(s\): 360p, 480p, 720p/);
    assert.match(said, /plus 1 unclaimed feed\(s\)/);
  });

  /**
   * ⛔ The branch that carries the whole reading when the read went wrong. A gateway error envelope
   * is not a master, and it must not be described as one offering nothing.
   */
  it('says the feed answered no playlist, and quotes what it did answer', () => {
    const envelope = '{"code":404,"message":"chunk not found"}';

    const said = describeMaster(masterRungsOf(envelope, RUNG_BY_TOPIC), envelope);

    assert.match(said, /answered no playlist/);
    assert.match(said, /chunk not found/);
    assert.doesNotMatch(said, /0 rung/, 'an unreadable body must not read as a ladder offering nothing');
  });

  it('says so plainly when the body was empty rather than quoting nothing', () => {
    assert.equal(
      describeMaster(masterRungsOf('', RUNG_BY_TOPIC), '   '),
      'the master feed answered no playlist, but nothing at all',
    );
  });

  /** ⚠️ Bounded and on one line, because this goes into a scrollback beside a verdict. */
  it('excerpts a long body onto one line rather than pasting a whole playlist into a verdict', () => {
    const long = `not a master\n${'x'.repeat(500)}`;

    const said = describeMaster(masterRungsOf(long, RUNG_BY_TOPIC), long);

    assert.ok(said.length < 200, `the excerpt ran to ${said.length} characters`);
    assert.doesNotMatch(said, /\n/, 'a verdict line has to stay on one line');
    assert.match(said, /not a master x/, 'the newline should read as a space rather than being dropped');
  });
});
