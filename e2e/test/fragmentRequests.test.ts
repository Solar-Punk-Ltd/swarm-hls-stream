import { fragmentRequested } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page } from 'playwright-core';

import {
  describeLevelRequests,
  fragmentLogVerdict,
  type FragmentRequest,
  judgeFragmentRequests,
  readFragmentRequest,
  recordFragmentRequests,
} from '../src/browser/fragmentRequests.js';

/**
 * Which level a viewer's player asked for, out of the lines the client writes.
 *
 * ⛔ Everything here is an observation. No case asserts a timing, a threshold or a refusal, per the
 * owner ruling of 2026-08-29, and the reader must not be able to grow one.
 */

const TOP = 'swarm://0xowner/top';
const BOTTOM = 'swarm://0xowner/bottom';

const START_MS = 1_756_377_600_000;
const CAPPED_AT = START_MS + 45_000;
const RELEASED_AT = START_MS + 105_000;
const WINDOW = { appliedAtMs: CAPPED_AT, liftedAtMs: RELEASED_AT };

/** One request, as the harness would have heard it. */
const asked = (atMs: number, level: string, rung = TOP, sn = '1'): FragmentRequest => ({ atMs, level, sn, rung });

describe('reading a fragment request off a page console line', () => {
  it('takes the level, the number and the rung out of the line the client wrote', () => {
    const heard = readFragmentRequest(fragmentRequested(3, 412, TOP), START_MS);

    assert.deepEqual(heard, { atMs: START_MS, level: '3', sn: '412', rung: TOP });
  });

  // The control. Without it, everything below passes on a reader that treats every line as a request.
  it('ignores a line that is not one', () => {
    assert.equal(readFragmentRequest('[SwarmHls] master playlist for swarm://0xowner/top', START_MS), null);
  });

  /**
   * ⭐ The listener is separate from `openViewer`'s on purpose, and this is the shape that matters: it
   * keeps the requests and lets everything else past without keeping it.
   */
  it('keeps every request the page announces and nothing else', () => {
    const into: FragmentRequest[] = [];
    let heard: ((message: { text: () => string }) => void) | null = null;
    const page = {
      on: (event: string, handler: (message: { text: () => string }) => void) => {
        if (event === 'console') {
          heard = handler;
        }
      },
    } as unknown as Page;

    recordFragmentRequests(page, into);
    assert.ok(heard, 'nothing subscribed to the page console');
    const listener = heard as unknown as (message: { text: () => string }) => void;
    listener({ text: () => fragmentRequested(3, 1, TOP) });
    listener({ text: () => 'Failed to load resource: the server responded with a status of 404' });
    listener({ text: () => fragmentRequested(0, 2, BOTTOM) });

    assert.deepEqual(
      into.map((request) => [request.level, request.rung]),
      [
        ['3', TOP],
        ['0', BOTTOM],
      ],
    );
  });
});

describe('what the player asked for, phase by phase', () => {
  const SQUEEZE_THAT_WORKED = [
    asked(START_MS + 1_000, '3'),
    asked(START_MS + 2_000, '3'),
    asked(CAPPED_AT + 1_000, '3'),
    asked(CAPPED_AT + 2_000, '0', BOTTOM),
    asked(CAPPED_AT + 3_000, '0', BOTTOM),
    asked(RELEASED_AT + 1_000, '3'),
  ];

  it('counts each phase against the treatment window', () => {
    const timeline = judgeFragmentRequests(SQUEEZE_THAT_WORKED, WINDOW, true);

    assert.deepEqual(
      [timeline.before.requests, timeline.during.requests, timeline.after.requests],
      [2, 3, 1],
      'the phases do not add up to what was heard',
    );
    assert.equal(timeline.captured, 6);
  });

  /**
   * ⛔ The boundaries, stated rather than assumed. A request at the instant the cap landed is under
   * the cap, and one at the instant it lifted is after it, which is the convention `phaseOf` in
   * `session.ts` already uses so two readings of one run cannot disagree about where a phase begins.
   */
  it('puts a request at the instant of the cap under it, and one at the lift after it', () => {
    const timeline = judgeFragmentRequests([asked(CAPPED_AT, '3'), asked(RELEASED_AT, '0', BOTTOM)], WINDOW, true);

    assert.equal(timeline.during.requests, 1);
    assert.equal(timeline.after.requests, 1);
    assert.equal(timeline.before.requests, 0);
  });

  it('reports each distinct level with its count, in the order it was first asked for', () => {
    const timeline = judgeFragmentRequests(SQUEEZE_THAT_WORKED, WINDOW, true);

    assert.deepEqual(
      timeline.during.levels.map((level) => [level.level, level.requests]),
      [
        ['3', 1],
        ['0', 2],
      ],
    );
  });

  /**
   * ⭐ The corroboration that catches the other half of V2's question. A level whose requests name the
   * WRONG rung playlist is something upstream serving the expensive rendition for a cheap request, and
   * the level index alone cannot say so.
   */
  it('names every rung playlist a level asked against', () => {
    const crossed = [asked(CAPPED_AT + 1_000, '0', BOTTOM), asked(CAPPED_AT + 2_000, '0', TOP)];

    const timeline = judgeFragmentRequests(crossed, WINDOW, true);

    assert.deepEqual(timeline.during.levels[0].rungs, [BOTTOM, TOP]);
  });

  it('reads a level the client could not resolve as itself, rather than as a rung', () => {
    const timeline = judgeFragmentRequests([asked(CAPPED_AT + 1_000, 'unknown', 'unknown')], WINDOW, true);

    assert.deepEqual(
      timeline.during.levels.map((level) => level.level),
      ['unknown'],
    );
  });

  it('says which levels a phase held, for a reader', () => {
    const timeline = judgeFragmentRequests(SQUEEZE_THAT_WORKED, WINDOW, true);

    assert.equal(describeLevelRequests(timeline.during), 'level 3 x1, level 0 x2');
    assert.equal(describeLevelRequests(judgeFragmentRequests([], WINDOW, true).during), 'none');
  });
});

/**
 * ⛔⛔⛔ Zero captured is not zero requested, and the two have opposite causes.
 *
 * A run whose picture moved cannot have requested no fragments. So an empty capture on a moving
 * picture is the DEPLOYED CLIENT lacking the instrument, which is a deployment to rebuild, and
 * printing it as "the player asked for nothing" would be a wrong answer wearing a measurement's
 * clothes. That is the failure this project has been bitten by most often.
 */
describe('telling a silent instrument from a silent player', () => {
  it('calls an empty capture over a moving picture an absent instrument', () => {
    const timeline = judgeFragmentRequests([], WINDOW, true);

    assert.equal(timeline.state, 'absent');
    assert.match(fragmentLogVerdict(timeline), /instrument absent from the deployed client/);
  });

  it('never reports an absent instrument as a player that asked for nothing', () => {
    assert.doesNotMatch(fragmentLogVerdict(judgeFragmentRequests([], WINDOW, true)), /asked for nothing/);
  });

  it('says an empty capture over a frozen picture settles nothing either way', () => {
    const timeline = judgeFragmentRequests([], WINDOW, false);

    assert.equal(timeline.state, 'unplayed');
    assert.match(fragmentLogVerdict(timeline), /says nothing/);
    assert.doesNotMatch(fragmentLogVerdict(timeline), /instrument absent/);
  });

  /**
   * The control, and the case that keeps the two above from passing on a judge that never says
   * anything else. One line heard is a working instrument, however few the run went on to hear.
   */
  it('calls a capture with anything in it a reading', () => {
    const timeline = judgeFragmentRequests([asked(START_MS + 1_000, '3')], WINDOW, true);

    assert.equal(timeline.state, 'recorded');
    assert.match(fragmentLogVerdict(timeline), /1 fragment request\(s\) recorded/);
  });

  /**
   * ⛔ A phase can legitimately be empty inside a run that recorded plenty, and that IS a reading
   * about the player. Only a run that heard nothing at all is about the instrument.
   */
  it('leaves a phase at zero inside a recorded run reading as the player', () => {
    const timeline = judgeFragmentRequests([asked(START_MS + 1_000, '3')], WINDOW, true);

    assert.equal(timeline.during.requests, 0);
    assert.equal(timeline.state, 'recorded');
  });
});
