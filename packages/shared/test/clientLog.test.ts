import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLIENT_LOG_UNKNOWN, fragmentRequested, fragmentRequestedPattern } from '../src/clientLog.js';

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
   */
  it('carries none of the words the harness forwards to the arm log', () => {
    const composed = fragmentRequested(3, 412, 'a-rung-address');

    assert.equal(/master|ladder|rung|Restarting/i.test(composed.replace('a-rung-address', '')), false);
  });
});
