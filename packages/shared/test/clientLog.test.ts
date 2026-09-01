import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLIENT_LOG_UNKNOWN,
  FRAGMENT_ABORTED,
  FRAGMENT_ERRORED,
  FRAGMENT_LOADED,
  FRAGMENT_TIMED_OUT,
  fragmentRequested,
  fragmentRequestedPattern,
  fragmentSettled,
  fragmentSettledPattern,
} from '../src/clientLog.js';

/**
 * The composer and the matcher are one definition read two ways, so these are about the join between
 * them rather than about either half. A message the harness cannot match is the failure this module
 * exists to make impossible: the e2e report would say the player asked for nothing on a run where it
 * asked for hundreds of fragments.
 */

const RUNG = 'swarm://0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09/9c4e1f60b8a2d357e0f1a2b3c4d5e6f7';

describe('the fragment request message', () => {
  it('reads back the level, the segment number and the rung it was composed from', () => {
    const match = fragmentRequestedPattern().exec(fragmentRequested(3, 412, RUNG));

    assert.ok(match, 'the pattern did not match its own composer');
    assert.deepEqual(match.slice(1, 4), ['3', '412', RUNG]);
  });

  /**
   * hls.js numbers the initialisation segment with a word rather than an index, and it is a real
   * fragment request. A pattern that demanded digits would skip it and count the run as quieter.
   */
  it('carries an initialisation segment, whose number is a word', () => {
    const match = fragmentRequestedPattern().exec(fragmentRequested(0, 'initSegment', RUNG));

    assert.ok(match);
    assert.equal(match[2], 'initSegment');
  });

  /**
   * ⛔ The whole reason the stand-in is a word. A level index of -1 is hls.js's own word for
   * automatic, so a numeric stand-in for "unreadable" would come back as a level nobody asked for.
   */
  it('reads back the stand-in the client writes where it could not read a value', () => {
    const match = fragmentRequestedPattern().exec(
      fragmentRequested(CLIENT_LOG_UNKNOWN, CLIENT_LOG_UNKNOWN, CLIENT_LOG_UNKNOWN),
    );

    assert.ok(match);
    assert.deepEqual(match.slice(1, 4), [CLIENT_LOG_UNKNOWN, CLIENT_LOG_UNKNOWN, CLIENT_LOG_UNKNOWN]);
  });

  // The control. Without it every case above passes on a pattern that matches anything.
  it('matches nothing in an ordinary console line', () => {
    assert.equal(fragmentRequestedPattern().exec('[SwarmHls] master playlist for swarm://owner/topic'), null);
    assert.equal(fragmentRequestedPattern().exec('Fragment requested'), null);
  });

  /** A browser console line carries a prefix the page never wrote, so the match cannot be anchored. */
  it('finds the message inside a longer console line', () => {
    const match = fragmentRequestedPattern().exec(`[SwarmHls] ${fragmentRequested(2, 88, RUNG)} `);

    assert.ok(match);
    assert.equal(match[1], '2');
  });

  it('finds every request in a run of them, given the global flag', () => {
    const heard = [fragmentRequested(3, 1, RUNG), fragmentRequested(3, 2, RUNG), fragmentRequested(0, 3, RUNG)];

    const levels = [...heard.join('\n').matchAll(fragmentRequestedPattern('g'))].map((match) => match[1]);

    assert.deepEqual(levels, ['3', '3', '0']);
  });

  /**
   * ⛔⛔ The e2e harness's `openViewer` forwards any page line carrying one of these words to the arm's
   * stdout, and the arm log then shows sixty distinct kinds. This message is written several times a
   * second and every copy is distinct, so a rewording that reached that filter would push everything
   * else the client said out of the arm log.
   *
   * ⭐ The rung is stripped out before the check, because what is guarded here is this module's fixed
   * wording rather than a caller's value. Why that value is safe too is written where the message is
   * composed: a `swarm://` address is hex, and a preview playlist's blob url is a UUID.
   */
  it('carries none of the words the harness forwards to the arm log', () => {
    const composed = fragmentRequested(3, 412, 'a-rung-address');

    assert.equal(/master|ladder|rung|Restarting/i.test(composed.replace('a-rung-address', '')), false);
  });
});

/**
 * The other half of the pair, written when an attempt stops being in flight.
 *
 * A request line alone cannot separate six fragments from one fragment asked for six times, because it
 * carries no ending. Everything here is about the join between the composer and the matcher, and about
 * the join between the two MESSAGES: a reader that confused one for the other would double-count every
 * attempt in a run.
 */
describe('the fragment settle message', () => {
  it('reads back the level, the segment number, the outcome and the elapsed it was composed from', () => {
    const match = fragmentSettledPattern().exec(fragmentSettled(3, 412, FRAGMENT_LOADED, 217));

    assert.ok(match, 'the pattern did not match its own composer');
    assert.deepEqual(match.slice(1, 5), ['3', '412', 'loaded', '217']);
  });

  it('reads back every outcome the client can write', () => {
    const outcomes = [FRAGMENT_LOADED, FRAGMENT_ERRORED, FRAGMENT_ABORTED, FRAGMENT_TIMED_OUT] as const;

    const read = outcomes.map((outcome) => fragmentSettledPattern().exec(fragmentSettled(0, 1, outcome, 5))?.[3]);

    assert.deepEqual(read, ['loaded', 'errored', 'aborted', 'timeout']);
  });

  it('carries an initialisation segment, whose number is a word', () => {
    const match = fragmentSettledPattern().exec(fragmentSettled(0, 'initSegment', FRAGMENT_LOADED, 44));

    assert.ok(match);
    assert.equal(match[2], 'initSegment');
  });

  it('reads back the stand-in the client writes where it could not read a value', () => {
    const match = fragmentSettledPattern().exec(
      fragmentSettled(CLIENT_LOG_UNKNOWN, CLIENT_LOG_UNKNOWN, FRAGMENT_ABORTED, 0),
    );

    assert.ok(match);
    assert.deepEqual(match.slice(1, 5), [CLIENT_LOG_UNKNOWN, CLIENT_LOG_UNKNOWN, 'aborted', '0']);
  });

  /**
   * ⚠️ The elapsed group is `\S+` rather than `\d+` for this. The client writes a rounded difference on a
   * monotonic clock, so it should never produce anything but digits, and a pattern that insisted would
   * drop the whole line on any environment that surprised it, losing the OUTCOME along with the duration.
   * The reader is where an unreadable number is named.
   */
  it('keeps the outcome when the duration is not a number the pattern could have demanded', () => {
    const match = fragmentSettledPattern().exec(fragmentSettled(2, 9, FRAGMENT_ERRORED, -3));

    assert.ok(match, 'a negative duration took the whole line with it');
    assert.deepEqual(match.slice(3, 5), ['errored', '-3']);
  });

  // The control. Without it every case above passes on a pattern that matches anything.
  it('matches nothing in an ordinary console line', () => {
    assert.equal(fragmentSettledPattern().exec('[SwarmHls] master playlist for swarm://owner/topic'), null);
    assert.equal(fragmentSettledPattern().exec('Fragment settled'), null);
  });

  /**
   * ⛔⛔ The two messages must never match each other. A run writes both several times a second, so a
   * pattern that caught the other kind would double every count taken off either half, and the two are
   * read against each other rather than alone.
   */
  it('is told apart from a request line, in both directions', () => {
    const requestLine = fragmentRequested(3, 412, RUNG);
    const settleLine = fragmentSettled(3, 412, FRAGMENT_LOADED, 217);

    assert.equal(fragmentSettledPattern().exec(requestLine), null, 'a request line read as a settle');
    assert.equal(fragmentRequestedPattern().exec(settleLine), null, 'a settle line read as a request');
  });

  /** A browser console line carries a prefix the page never wrote, so the match cannot be anchored. */
  it('finds the message inside a longer console line', () => {
    const match = fragmentSettledPattern().exec(`[SwarmHls] ${fragmentSettled(2, 88, FRAGMENT_TIMED_OUT, 30_000)} `);

    assert.ok(match);
    assert.deepEqual(match.slice(1, 5), ['2', '88', 'timeout', '30000']);
  });

  it('finds every settle in a run of them, given the global flag', () => {
    const heard = [
      fragmentSettled(3, 1, FRAGMENT_LOADED, 120),
      fragmentSettled(3, 2, FRAGMENT_ERRORED, 8_000),
      fragmentSettled(0, 3, FRAGMENT_LOADED, 90),
    ];

    const outcomes = [...heard.join('\n').matchAll(fragmentSettledPattern('g'))].map((match) => match[3]);

    assert.deepEqual(outcomes, ['loaded', 'errored', 'loaded']);
  });

  /**
   * ⛔⛔ The same hazard as the request line's. `openViewer` forwards any page line carrying one of these
   * words to the arm's stdout, and this message is written just as often, so a rewording that reached
   * that filter would push everything else the client said out of the arm log.
   */
  it('carries none of the words the harness forwards to the arm log', () => {
    assert.equal(/master|ladder|rung|Restarting/i.test(fragmentSettled(3, 412, FRAGMENT_LOADED, 217)), false);
  });
});
