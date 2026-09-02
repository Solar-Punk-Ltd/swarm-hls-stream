import {
  CLIENT_LOG_UNKNOWN,
  FRAGMENT_ABORTED,
  FRAGMENT_ANSWER_REJECTED,
  FRAGMENT_ANSWER_RESOLVED,
  FRAGMENT_ERRORED,
  FRAGMENT_LOADED,
  fragmentAbandonedAnswered,
  fragmentRequested,
  fragmentSettled,
} from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page } from 'playwright-core';

import {
  abandonedAnswerVerdict,
  describeAbandonedAnswers,
  describeElapsed,
  describeLevelRequests,
  describeSettleOutcomes,
  type FragmentAbandonedAnswer,
  type FragmentLog,
  fragmentLogVerdict,
  type FragmentRequest,
  type FragmentSettle,
  fragmentSettleVerdict,
  judgeFragmentRequests,
  readFragmentAbandonedAnswer,
  readFragmentRequest,
  readFragmentSettle,
  recordFragmentLog,
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

/** One ending, as the harness would have heard it. */
const ended = (
  atMs: number,
  level: string,
  outcome: string,
  elapsedMs: number | null = 120,
  sn = '1',
): FragmentSettle => ({
  atMs,
  level,
  sn,
  outcome,
  elapsedMs,
});

/** One late answer, as the harness would have heard it. */
const answered = (
  atMs: number,
  level: string,
  answer: string,
  byteLength: number | null = 224_848,
  elapsedMs: number | null = 28_930,
  sn = '1',
): FragmentAbandonedAnswer => ({ atMs, level, sn, answer, byteLength, elapsedMs });

/** What one console listener collected, which is what the judge is given. */
const fragmentLog = (
  requests: FragmentRequest[],
  settles: FragmentSettle[] = [],
  abandonedAnswers: FragmentAbandonedAnswer[] = [],
): FragmentLog => ({
  requests,
  settles,
  abandonedAnswers,
});

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
    const into = fragmentLog([]);
    const say = subscribed(into);

    say(fragmentRequested(3, 1, TOP));
    say('Failed to load resource: the server responded with a status of 404');
    say(fragmentRequested(0, 2, BOTTOM));

    assert.deepEqual(
      into.requests.map((request) => [request.level, request.rung]),
      [
        ['3', TOP],
        ['0', BOTTOM],
      ],
    );
  });

  /**
   * ⭐ One listener for both halves, and each line goes to exactly one list. A settle counted as a
   * request would double every level count in the run, since the client writes one of each per attempt.
   */
  it('sorts each line into the half it belongs to, and keeps neither out', () => {
    const into = fragmentLog([]);
    const say = subscribed(into);

    say(fragmentRequested(3, 1, TOP));
    say(fragmentSettled(3, 1, FRAGMENT_LOADED, 140));
    say('[SwarmHls] something else entirely');
    say(fragmentSettled(0, 2, FRAGMENT_ERRORED, 9_000));

    assert.equal(into.requests.length, 1, 'a settle line was kept as a request');
    assert.deepEqual(
      into.settles.map((settle) => [settle.level, settle.outcome, settle.elapsedMs]),
      [
        ['3', 'loaded', 140],
        ['0', 'errored', 9_000],
      ],
    );
  });
});

/** Hand the module a page whose console the caller drives, and hand back the way to speak into it. */
function subscribed(into: FragmentLog): (text: string) => void {
  let listener: ((message: { text: () => string }) => void) | null = null;
  const page = {
    on: (event: string, handler: (message: { text: () => string }) => void) => {
      if (event === 'console') {
        listener = handler;
      }
    },
  } as unknown as Page;

  recordFragmentLog(page, into);
  assert.ok(listener, 'nothing subscribed to the page console');
  const heard = listener as unknown as (message: { text: () => string }) => void;
  return (text: string) => heard({ text: () => text });
}

/**
 * The other half: what became of each of those requests.
 *
 * ⛔ A level count is a count of ASKING. Six requests at one level is six fragments if they arrived and
 * one fragment six times if they did not, and those are opposite findings about where a defect lives.
 */
describe('reading how an attempt ended off a page console line', () => {
  it('takes the level, the number, the outcome and the elapsed out of the line the client wrote', () => {
    const settle = readFragmentSettle(fragmentSettled(3, 412, FRAGMENT_LOADED, 217), START_MS);

    assert.deepEqual(settle, { atMs: START_MS, level: '3', sn: '412', outcome: 'loaded', elapsedMs: 217 });
  });

  // The control. Without it, everything below passes on a reader that treats every line as a settle.
  it('ignores a line that is not one', () => {
    assert.equal(readFragmentSettle('[SwarmHls] master playlist for swarm://0xowner/top', START_MS), null);
    assert.equal(readFragmentSettle(fragmentRequested(3, 412, TOP), START_MS), null, 'a request read as a settle');
  });

  /**
   * ⛔⛔ Null is not zero. An attempt whose duration could not be read is still an attempt that ended,
   * and folding it in as a zero would drag a median toward a number nothing measured.
   */
  it('keeps an attempt whose duration is unreadable, and says the duration is missing', () => {
    const settle = readFragmentSettle('Fragment settled: level 3 sn 412 loaded after later ms', START_MS);

    assert.ok(settle, 'an unreadable duration took the whole attempt with it');
    assert.equal(settle.outcome, 'loaded');
    assert.equal(settle.elapsedMs, null);
  });

  /**
   * ⛔ The client's set of outcomes is closed and this reader's is not. A word the client gains has to
   * reach the report as itself, because a settle nobody can classify is still a settle and dropping it
   * would understate the run.
   */
  it('reads an outcome word it has never seen as itself, rather than dropping the line', () => {
    const settle = readFragmentSettle('Fragment settled: level 2 sn 9 recycled after 40 ms', START_MS);

    assert.equal(settle?.outcome, 'recycled');
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
    const timeline = judgeFragmentRequests(fragmentLog(SQUEEZE_THAT_WORKED), WINDOW, true);

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
    const timeline = judgeFragmentRequests(
      fragmentLog([asked(CAPPED_AT, '3'), asked(RELEASED_AT, '0', BOTTOM)]),
      WINDOW,
      true,
    );

    assert.equal(timeline.during.requests, 1);
    assert.equal(timeline.after.requests, 1);
    assert.equal(timeline.before.requests, 0);
  });

  it('reports each distinct level with its count, in the order it was first asked for', () => {
    const timeline = judgeFragmentRequests(fragmentLog(SQUEEZE_THAT_WORKED), WINDOW, true);

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

    const timeline = judgeFragmentRequests(fragmentLog(crossed), WINDOW, true);

    assert.deepEqual(timeline.during.levels[0].rungs, [BOTTOM, TOP]);
  });

  it('reads a level the client could not resolve as itself, rather than as a rung', () => {
    const timeline = judgeFragmentRequests(fragmentLog([asked(CAPPED_AT + 1_000, 'unknown', 'unknown')]), WINDOW, true);

    assert.deepEqual(
      timeline.during.levels.map((level) => level.level),
      ['unknown'],
    );
  });

  it('says which levels a phase held, for a reader', () => {
    const timeline = judgeFragmentRequests(fragmentLog(SQUEEZE_THAT_WORKED), WINDOW, true);

    assert.equal(describeLevelRequests(timeline.during), 'level 3 x1, level 0 x2');
    assert.equal(describeLevelRequests(judgeFragmentRequests(fragmentLog([]), WINDOW, true).during), 'none');
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
    const timeline = judgeFragmentRequests(fragmentLog([]), WINDOW, true);

    assert.equal(timeline.state, 'absent');
    assert.match(fragmentLogVerdict(timeline), /instrument absent from the deployed client/);
  });

  it('never reports an absent instrument as a player that asked for nothing', () => {
    assert.doesNotMatch(fragmentLogVerdict(judgeFragmentRequests(fragmentLog([]), WINDOW, true)), /asked for nothing/);
  });

  it('says an empty capture over a frozen picture settles nothing either way', () => {
    const timeline = judgeFragmentRequests(fragmentLog([]), WINDOW, false);

    assert.equal(timeline.state, 'unplayed');
    assert.match(fragmentLogVerdict(timeline), /says nothing/);
    assert.doesNotMatch(fragmentLogVerdict(timeline), /instrument absent/);
  });

  /**
   * The control, and the case that keeps the two above from passing on a judge that never says
   * anything else. One line heard is a working instrument, however few the run went on to hear.
   */
  it('calls a capture with anything in it a reading', () => {
    const timeline = judgeFragmentRequests(fragmentLog([asked(START_MS + 1_000, '3')]), WINDOW, true);

    assert.equal(timeline.state, 'recorded');
    assert.match(fragmentLogVerdict(timeline), /1 fragment request\(s\) recorded/);
  });

  /**
   * ⛔ A phase can legitimately be empty inside a run that recorded plenty, and that IS a reading
   * about the player. Only a run that heard nothing at all is about the instrument.
   */
  it('leaves a phase at zero inside a recorded run reading as the player', () => {
    const timeline = judgeFragmentRequests(fragmentLog([asked(START_MS + 1_000, '3')]), WINDOW, true);

    assert.equal(timeline.during.requests, 0);
    assert.equal(timeline.state, 'recorded');
  });
});

/**
 * ⛔⛔ The raw list, which is the whole reason this timeline is not just its buckets.
 *
 * A phase reporting six level-0 requests has aggregated away the one thing that separates six fragments
 * from ONE fragment asked for six times, and those are opposite findings: a player stepping down and
 * being served, against a player stepping down and getting nothing. A squeeze arm on 2026-09-01 hit
 * exactly that and the artifact could not answer it.
 */
describe('the raw list the buckets are a bucketing of', () => {
  const RETRIED_THE_SAME_SEGMENT = [
    asked(CAPPED_AT + 1_000, '0', BOTTOM, '77'),
    asked(CAPPED_AT + 2_000, '0', BOTTOM, '77'),
    asked(CAPPED_AT + 3_000, '0', BOTTOM, '77'),
  ];

  it('carries every request in the order it was heard, with its own segment number', () => {
    const timeline = judgeFragmentRequests(fragmentLog(RETRIED_THE_SAME_SEGMENT), WINDOW, true);

    assert.deepEqual(
      timeline.requests?.map((request) => [request.atMs, request.level, request.sn, request.rung]),
      RETRIED_THE_SAME_SEGMENT.map((request) => [request.atMs, request.level, request.sn, request.rung]),
    );
  });

  /** ⭐ The reading the bucket cannot give, stated as the two shapes it has to separate. */
  it('shows one segment asked for three times where the bucket shows three requests', () => {
    const retried = judgeFragmentRequests(fragmentLog(RETRIED_THE_SAME_SEGMENT), WINDOW, true);
    const distinct = judgeFragmentRequests(
      fragmentLog([
        asked(CAPPED_AT + 1_000, '0', BOTTOM, '77'),
        asked(CAPPED_AT + 2_000, '0', BOTTOM, '78'),
        asked(CAPPED_AT + 3_000, '0', BOTTOM, '79'),
      ]),
      WINDOW,
      true,
    );

    assert.equal(retried.during.levels[0].requests, distinct.during.levels[0].requests, 'the buckets differ');
    assert.deepEqual(new Set(retried.requests?.map((request) => request.sn)), new Set(['77']));
    assert.deepEqual(new Set(distinct.requests?.map((request) => request.sn)), new Set(['77', '78', '79']));
  });

  /** ⛔ A copy, so a driver that keeps collecting after the judge ran cannot rewrite what it filed. */
  it('files a copy rather than the list the harness is still filling', () => {
    const collecting = fragmentLog([asked(START_MS + 1_000, '3')]);

    const timeline = judgeFragmentRequests(collecting, WINDOW, true);
    collecting.requests.push(asked(RELEASED_AT + 1_000, '0', BOTTOM));

    assert.equal(timeline.requests?.length, 1, 'the filed list moved after it was filed');
  });
});

/**
 * ⛔⛔ Zero settled is not zero finished, and the discipline is the request half's, one line down.
 *
 * A run that heard requests and no settle is a client writing the FIRST half of the pair and not the
 * second, which is a build to redeploy. Printing that as "no attempt ever finished" would be the same
 * wrong answer in a measurement's clothes that the request half already exists to prevent.
 */
describe('how those attempts ended, phase by phase', () => {
  const CAPPED_AND_STRUGGLED = [
    ended(START_MS + 1_500, '3', FRAGMENT_LOADED, 100),
    ended(START_MS + 2_500, '3', FRAGMENT_LOADED, 300),
    ended(CAPPED_AT + 1_500, '3', FRAGMENT_ERRORED, 8_000),
    ended(CAPPED_AT + 2_500, '0', FRAGMENT_LOADED, 400),
    ended(CAPPED_AT + 3_500, '0', FRAGMENT_ABORTED, 200),
    ended(RELEASED_AT + 1_500, '3', FRAGMENT_LOADED, 120),
  ];
  const SQUEEZED_REQUESTS = [
    asked(START_MS + 1_000, '3'),
    asked(CAPPED_AT + 1_000, '3'),
    asked(CAPPED_AT + 2_000, '0', BOTTOM),
  ];
  const settled = () =>
    judgeFragmentRequests(fragmentLog([...SQUEEZED_REQUESTS], CAPPED_AND_STRUGGLED), WINDOW, true).settled;

  it('counts each phase against the same window the requests are cut on', () => {
    const reading = settled();

    assert.deepEqual([reading?.before.settled, reading?.during.settled, reading?.after.settled], [2, 3, 1]);
    assert.equal(reading?.captured, 6);
  });

  it('reports each distinct outcome with its count, in the order it was first seen', () => {
    assert.deepEqual(
      settled()?.during.outcomes.map((outcome) => [outcome.outcome, outcome.settled]),
      [
        ['errored', 1],
        ['loaded', 1],
        ['aborted', 1],
      ],
    );
    assert.equal(describeSettleOutcomes(settled()!.during), 'errored x1, loaded x1, aborted x1');
  });

  it('reports the spread of what those attempts took, and how many it is over', () => {
    const during = settled()!.during;

    assert.deepEqual(
      [during.elapsed?.minMs, during.elapsed?.medianMs, during.elapsed?.maxMs, during.elapsed?.samples],
      [200, 400, 8_000, 3],
    );
    assert.equal(describeElapsed(during), '200 / 400 / 8000 ms over 3');
  });

  /**
   * ⛔ Null rather than three zeroes. A spread of zeroes reads as a run of instant retrievals, which is
   * the most flattering possible misreading of no data at all.
   */
  it('says no attempt carried a duration rather than reporting a spread of zeroes', () => {
    const unreadable = [ended(CAPPED_AT + 1_000, '0', FRAGMENT_LOADED, null)];

    const during = judgeFragmentRequests(fragmentLog([asked(CAPPED_AT, '0')], unreadable), WINDOW, true).settled
      ?.during;

    assert.equal(during?.settled, 1, 'the attempt was dropped along with its missing duration');
    assert.equal(during?.elapsed, null);
    assert.match(describeElapsed(during!), /no attempt carried a duration/);
  });

  /**
   * ⭐ A check on the JOIN rather than a finding. Paired against the whole run rather than the stretch,
   * because a fragment asked for just before a cap lands routinely finishes after it.
   */
  it('pairs an attempt to a request from any phase, on the level and the segment number', () => {
    const askedBefore = [asked(CAPPED_AT - 500, '3', TOP, '41')];
    const endedAfter = [ended(CAPPED_AT + 500, '3', FRAGMENT_LOADED, 1_000, '41')];

    const during = judgeFragmentRequests(fragmentLog(askedBefore, endedAfter), WINDOW, true).settled?.during;

    assert.equal(during?.pairedToRequests, 1, 'an attempt that crossed the cap paired with nothing');
  });

  // The control. Without it the case above passes on a join that matches everything it is handed.
  it('leaves an attempt unpaired when nothing in the run asked for that segment', () => {
    const during = judgeFragmentRequests(
      fragmentLog([asked(CAPPED_AT, '3', TOP, '41')], [ended(CAPPED_AT + 500, '3', FRAGMENT_LOADED, 100, '99')]),
      WINDOW,
      true,
    ).settled?.during;

    assert.equal(during?.pairedToRequests, 0);
  });

  it('carries every settle in the order it was heard', () => {
    assert.deepEqual(
      settled()?.settles.map((settle) => settle.outcome),
      CAPPED_AND_STRUGGLED.map((settle) => settle.outcome),
    );
  });
});

/**
 * ⛔⛔⛔ Three silences on this half too, and each has a different fix.
 *
 * Settles heard is a reading. Requests heard and no settle is the deployed CLIENT writing half the pair,
 * and the fix is a redeploy. Neither kind heard says nothing this half can add, and the request verdict
 * is where that silence is explained.
 */
describe('telling a client with half the instrument from a run with no attempts', () => {
  it('calls requests without settles an absent settle instrument, naming the client', () => {
    const timeline = judgeFragmentRequests(fragmentLog([asked(START_MS + 1_000, '3')]), WINDOW, true);

    assert.equal(timeline.settled?.state, 'absent');
    assert.match(fragmentSettleVerdict(timeline.settled), /settle instrument absent from the deployed client/);
  });

  it('never reports that silence as attempts which did not finish', () => {
    const timeline = judgeFragmentRequests(fragmentLog([asked(START_MS + 1_000, '3')]), WINDOW, true);

    assert.doesNotMatch(fragmentSettleVerdict(timeline.settled), /settled attempt\(s\) recorded/);
  });

  it('says nothing of its own when neither kind of line was heard', () => {
    const timeline = judgeFragmentRequests(fragmentLog([]), WINDOW, true);

    assert.equal(timeline.settled?.state, 'unheard');
    assert.match(fragmentSettleVerdict(timeline.settled), /Read the fragment request verdict/);
  });

  /** The control, and the case that keeps the two above from passing on a judge that never says else. */
  it('calls a capture with anything in it a reading', () => {
    const timeline = judgeFragmentRequests(
      fragmentLog([asked(START_MS, '3')], [ended(START_MS + 100, '3', FRAGMENT_LOADED, 100)]),
      WINDOW,
      true,
    );

    assert.equal(timeline.settled?.state, 'recorded');
    assert.match(fragmentSettleVerdict(timeline.settled), /1 settled attempt\(s\) recorded/);
  });

  /** ⛔ The fourth silence, about the FILE rather than the run: an artifact older than this reading. */
  it('says the artifact predates the reading when there is no settle section at all', () => {
    assert.match(fragmentSettleVerdict(null), /written before the settle line existed/);
  });
});

/**
 * ⭐⭐ Whether an abandoned in-tab retrieval ever answered, which `aborted` alone cannot say.
 *
 * On the in-tab path a retrieval takes no abort signal, so a fragment the player walked away from keeps
 * costing the node until it answers, and the settle line stamps that answer `aborted` either way. Bytes
 * that arrived far too late and bytes that never arrived are opposite findings about a squeezed viewer,
 * and V2's open question is exactly which of the two happened under the cap.
 */
describe('reading a late answer off a page console line', () => {
  it('takes the level, the number, the answer, the bytes and the elapsed out of the line', () => {
    const heard = readFragmentAbandonedAnswer(
      fragmentAbandonedAnswered(0, 642, FRAGMENT_ANSWER_RESOLVED, 224_848, 28_930),
      START_MS,
    );

    assert.deepEqual(heard, {
      atMs: START_MS,
      level: '0',
      sn: '642',
      answer: 'resolved',
      byteLength: 224_848,
      elapsedMs: 28_930,
    });
  });

  // The control, and it has to cover both of the other lines: all three are written in one run.
  it('ignores a line that is not one', () => {
    assert.equal(readFragmentAbandonedAnswer('[SwarmHls] master playlist for swarm://0xowner/top', START_MS), null);
    assert.equal(
      readFragmentAbandonedAnswer(fragmentSettled(0, 642, FRAGMENT_ABORTED, 28_930), START_MS),
      null,
      'a settle read as a late answer',
    );
    assert.equal(readFragmentAbandonedAnswer(fragmentRequested(0, 642, TOP), START_MS), null);
  });

  /**
   * ⛔⛔ Null is not zero, and here that matters more than anywhere else in this module. A rejection
   * produced no bytes, and totalling it in as zero is harmless while totalling a run of them as real
   * answers of nothing would say the node was answering when it was refusing.
   */
  it('reads a byte count the client had none of as missing, rather than as zero', () => {
    const heard = readFragmentAbandonedAnswer(
      fragmentAbandonedAnswered(2, 9, FRAGMENT_ANSWER_REJECTED, CLIENT_LOG_UNKNOWN, 8_400),
      START_MS,
    );

    assert.equal(heard?.answer, 'rejected');
    assert.equal(heard?.byteLength, null);
    assert.equal(heard?.elapsedMs, 8_400);
  });

  /**
   * ⛔ The client's set of answers is closed and this reader's is not, exactly as with an outcome. A word
   * the client gains has to reach the report as itself rather than being dropped by a reader built before
   * it.
   */
  it('reads an answer word it has never seen as itself, rather than dropping the line', () => {
    const heard = readFragmentAbandonedAnswer(
      'Fragment abandoned answer: level 2 sn 9 recycled 40 bytes after 900 ms',
      START_MS,
    );

    assert.equal(heard?.answer, 'recycled');
  });

  /** ⭐ One listener, three kinds, and each line goes to exactly one list. */
  it('sorts a late answer into its own list, keeping the other two whole', () => {
    const into = fragmentLog([]);
    const say = subscribed(into);

    say(fragmentRequested(0, 642, TOP));
    say(fragmentAbandonedAnswered(0, 642, FRAGMENT_ANSWER_RESOLVED, 224_848, 28_930));
    say(fragmentSettled(0, 642, FRAGMENT_ABORTED, 28_930));

    assert.equal(into.requests.length, 1, 'a late answer was kept as a request');
    assert.equal(into.settles.length, 1, 'a late answer was kept as a settle');
    assert.deepEqual(
      into.abandonedAnswers.map((entry) => [entry.answer, entry.byteLength]),
      [['resolved', 224_848]],
    );
  });
});

describe('what the node did with attempts the player had walked away from', () => {
  const CAP_ANSWERED_LATE = [
    answered(START_MS + 2_000, '3', FRAGMENT_ANSWER_RESOLVED, 810_000),
    answered(CAPPED_AT + 20_000, '3', FRAGMENT_ANSWER_RESOLVED, 224_848),
    answered(CAPPED_AT + 30_000, '3', FRAGMENT_ANSWER_RESOLVED, 200_000),
    answered(CAPPED_AT + 40_000, '3', FRAGMENT_ANSWER_REJECTED, null),
    answered(RELEASED_AT + 5_000, '0', FRAGMENT_ANSWER_RESOLVED, 90_000),
  ];
  const reading = () =>
    judgeFragmentRequests(fragmentLog([asked(START_MS, '3')], [], CAP_ANSWERED_LATE), WINDOW, true).abandonedAnswers;

  it('counts each phase against the same window the requests are cut on', () => {
    const answers = reading();

    assert.deepEqual([answers?.before.answered, answers?.during.answered, answers?.after.answered], [1, 3, 1]);
    assert.equal(answers?.captured, 5);
  });

  /** ⭐ The bit the settle line cannot give: which way each of those late answers went. */
  it('separates the ones that produced bytes from the ones that produced nothing', () => {
    const { during } = reading()!;

    assert.equal(during.resolved, 2);
    assert.equal(during.rejected, 1);
  });

  it('totals what the node produced for work nobody was waiting for', () => {
    assert.equal(reading()?.during.bytes, 424_848);
  });

  /**
   * ⛔ Null rather than zero, for the same reason the elapsed spread is null rather than three zeroes. A
   * stretch whose late answers were all refusals produced nothing, and a zero there reads as a stretch of
   * empty segments the node genuinely served.
   */
  it('says a stretch that produced no bytes at all carried no count, rather than a count of zero', () => {
    const refusedOnly = [answered(CAPPED_AT + 1_000, '3', FRAGMENT_ANSWER_REJECTED, null)];

    const { during } = judgeFragmentRequests(fragmentLog([], [], refusedOnly), WINDOW, true).abandonedAnswers!;

    assert.equal(during.answered, 1, 'the refusal was dropped along with its missing byte count');
    assert.equal(during.bytes, null);
  });

  /** ⛔ An answer word this reader does not know is still an answer, and must not vanish from the total. */
  it('keeps an answer it cannot classify in the count of what was answered', () => {
    const strange = [answered(CAPPED_AT + 1_000, '3', 'recycled', 40)];

    const { during } = judgeFragmentRequests(fragmentLog([], [], strange), WINDOW, true).abandonedAnswers!;

    assert.equal(during.answered, 1);
    assert.equal(during.resolved, 0);
    assert.equal(during.rejected, 0);
    assert.match(describeAbandonedAnswers(during), /could not classify/);
  });

  it('carries every late answer in the order it was heard', () => {
    assert.deepEqual(
      reading()?.answers.map((entry) => entry.atMs),
      CAP_ANSWERED_LATE.map((entry) => entry.atMs),
    );
  });

  /** ⛔ A copy, so a driver still collecting cannot rewrite what it filed. */
  it('files a copy rather than the list the harness is still filling', () => {
    const collecting = fragmentLog([], [], [answered(CAPPED_AT + 1_000, '3', FRAGMENT_ANSWER_RESOLVED)]);

    const answers = judgeFragmentRequests(collecting, WINDOW, true).abandonedAnswers;
    collecting.abandonedAnswers.push(answered(RELEASED_AT + 1_000, '0', FRAGMENT_ANSWER_REJECTED, null));

    assert.equal(answers?.answers.length, 1, 'the filed list moved after it was filed');
  });

  it('says which way a phase went, for a reader', () => {
    assert.equal(describeAbandonedAnswers(reading()!.during), '2 resolved (424848 bytes), 1 rejected');
    assert.equal(
      describeAbandonedAnswers(judgeFragmentRequests(fragmentLog([]), WINDOW, true).abandonedAnswers!.during),
      'none',
    );
  });
});

/**
 * ⛔⛔⛔ Silence here is NOT the silence the other two halves have, and the difference is the whole
 * reason this reading gets a state of its own.
 *
 * A run with no request line over a moving picture is a client without the instrument. A run with no
 * LATE ANSWER is the ordinary case: the gateway path writes none by construction, and an in-tab run
 * that abandoned nothing late writes none either. Printing that as an absent instrument would send
 * someone to rebuild a client that is exactly right.
 */
describe('telling a quiet node from a client that cannot say', () => {
  it('calls a run that heard one a reading', () => {
    const answers = judgeFragmentRequests(
      fragmentLog([], [], [answered(CAPPED_AT + 1_000, '3', FRAGMENT_ANSWER_RESOLVED, 224_848)]),
      WINDOW,
      true,
    ).abandonedAnswers;

    assert.equal(answers?.state, 'recorded');
    assert.match(abandonedAnswerVerdict(answers), /1 resolved \(224848 bytes\), 0 rejected/);
  });

  it('calls a run that heard none silent, and never an absent instrument', () => {
    const answers = judgeFragmentRequests(fragmentLog([asked(START_MS, '3')]), WINDOW, true).abandonedAnswers;

    assert.equal(answers?.state, 'silent');
    assert.doesNotMatch(abandonedAnswerVerdict(answers), /absent/);
  });

  /** ⛔ And it has to say WHY the silence proves nothing, or a reader will draw the conclusion anyway. */
  it('says a silence is not evidence about the client, naming the gateway path as one reason', () => {
    const answers = judgeFragmentRequests(fragmentLog([asked(START_MS, '3')]), WINDOW, true).abandonedAnswers;

    assert.match(abandonedAnswerVerdict(answers), /gateway path/);
  });

  /** ⛔ The silence about the FILE, which is the one this reading shares with the settle half. */
  it('says the artifact predates the reading when there is no such section at all', () => {
    assert.match(abandonedAnswerVerdict(null), /written before/);
  });
});
