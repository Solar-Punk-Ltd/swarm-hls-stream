import { finalizeResumed, ladderFinalized, manifestUploaded, segmentUploaded } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  announcedLiveStreams,
  announcedLiveTopics,
  announcedVodFinalizeCount,
  catalogContinuedEmpty,
  isContiguous,
  manifestIndicesByStream,
  messageText,
  newIndices,
  parseUploaderLog,
  resumedFinalizeCount,
} from '../src/harness/logwatch.js';

/**
 * These parsers decide what every upload-side scenario concludes. A regex that quietly stops
 * matching does not fail loudly: the segment counter stays at zero, each scenario spends its whole
 * `waitFor` budget, and the label it fails with blames the publisher. So the fixtures below are the
 * uploader's real output, assembled from the formats `Logger` actually writes rather than from what
 * the patterns would like to see.
 */

/** `Logger`'s text format: `[ts] [LEVEL] - message`. */
function textLine(level: string, message: string): string {
  return `[2026-08-02T09:14:05.123Z] [${level.toUpperCase()}] - ${message}`;
}

/** `Logger`'s `LOG_FORMAT=json` format: one `JSON.stringify({ts, level, msg})` per line. */
function jsonLine(level: string, message: string): string {
  return JSON.stringify({ ts: '2026-08-02T09:14:05.123Z', level, msg: message });
}

const ANNOUNCED_OWNER = '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3';

/** The exact message `StreamUploader.notifyStart` logs, entry shape included. */
function announcement(topic: string, state: string): string {
  return `Adding stream to list: ${JSON.stringify({
    title: '2026-08-02 09:14',
    owner: ANNOUNCED_OWNER,
    topic,
    state,
    mediatype: 'video',
    timestamp: 1786000445123,
  })}`;
}

const UPLOADED = (index: number) => segmentUploaded('live/stream', index, 'bzz://a1b2c3');
const MANIFEST = (index: number, streamId = 'live/stream') => manifestUploaded(streamId, index);
const DISCONTINUITY = (index: number) =>
  `Failed to upload segment ${index} for stream stream-7 within the retry window; marking a discontinuity`;
/** `handleSegmentLoss`, count 1. Arms a discontinuity and names no index the harness can capture. */
const SEGMENT_LOST = (index: number) =>
  `Segment ${index} for stream stream-7 never reached the uploader, marking a discontinuity`;
/** `handleSegmentLoss`, count > 1. */
const SEGMENTS_LOST = (count: number, index: number) =>
  `${count} segments from index ${index} for stream stream-7 never reached the uploader, marking a discontinuity`;
/** `markDiscontinuity`. Ordinary rather than an error: the origin declared it and nothing was lost. */
const ORIGIN_DISCONTINUITY = 'Origin declared a discontinuity for stream stream-7, marking the next segment';
/**
 * `StreamOrchestrator.mediaDuration`'s fallback warning, with the reason `measureSegmentDuration`
 * produces for a segment holding no video. Copied from a real one on 2026-08-09.
 */
const VIDEOLESS = (index: number) =>
  `[StreamOrchestrator] Cannot read how much media segment ${index} of live/stream holds, so 2.082s is being ` +
  "published on the engine's word: cannot measure how much media this segment holds: it holds no video packets, " +
  'so the media never reached the far end. Reported once per stream; see the segment_durations_unread_total counter ' +
  'for the rate';
/** The same warning for the other reason it fires, which is a different fault with a different cost. */
const UNUSABLE_TIMESTAMPS = (index: number) =>
  `[StreamOrchestrator] Cannot read how much media segment ${index} of live/stream holds, so 2s is being published ` +
  "on the engine's word: its timestamps span 95443.7s, which is not a segment. Reported once per stream";
const STALE = (count: number) => `Live manifest for stream stream-7 is stale: ${count} consecutive publish failure(s)`;
const RETRY = 'Retrying in ~1840ms (attempt 2). Error: connect ECONNREFUSED';

describe('parseUploaderLog reads the text format', () => {
  const log = [
    textLine('log', UPLOADED(0)),
    textLine('log', MANIFEST(11)),
    textLine('log', UPLOADED(1)),
    textLine('info', RETRY),
    textLine('log', MANIFEST(12)),
    textLine('error', DISCONTINUITY(2)),
    textLine('warn', STALE(3)),
    textLine('log', UPLOADED(3)),
  ].join('\n');

  it('captures segment indices in order', () => {
    assert.deepEqual(parseUploaderLog(log).uploadedSegments, [0, 1, 3]);
  });

  it('captures manifest SOC indices', () => {
    assert.deepEqual(parseUploaderLog(log).manifestSocIndices, [11, 12]);
  });

  it('counts the discontinuity and captures the segment it names', () => {
    assert.equal(parseUploaderLog(log).discontinuitiesArmed, 1);
    assert.deepEqual(parseUploaderLog(log).discontinuitySegments, [2]);
  });

  it('counts stale warnings and retries', () => {
    const events = parseUploaderLog(log);
    assert.equal(events.staleWarnings, 1);
    assert.equal(events.retries, 1);
  });

  it('reports nothing rather than throwing on an empty log', () => {
    assert.deepEqual(parseUploaderLog(''), {
      uploadedSegments: [],
      discontinuitiesArmed: 0,
      discontinuitySegments: [],
      manifestSocIndices: [],
      staleWarnings: 0,
      retries: 0,
      videolessSegments: [],
    });
  });

  // The distinction the bee-outage scenarios turn on. A failed upload must not be counted as one
  // that landed, or scenario B's gap would read as a clean run.
  it('does not count a failed segment as uploaded', () => {
    assert.deepEqual(parseUploaderLog(textLine('error', DISCONTINUITY(9))).uploadedSegments, []);
  });

  // The inverse of the arming patterns: an ordinary upload must not read as a discontinuity.
  it('arms nothing on a clean run', () => {
    assert.equal(parseUploaderLog(textLine('log', UPLOADED(0))).discontinuitiesArmed, 0);
  });
});

describe('parseUploaderLog reads the json format', () => {
  // `LOG_FORMAT=json` is a supported deployment choice, and every pattern here has to survive it.
  const log = [
    jsonLine('log', UPLOADED(0)),
    jsonLine('log', MANIFEST(4)),
    jsonLine('error', DISCONTINUITY(1)),
    jsonLine('warn', STALE(2)),
    jsonLine('info', RETRY),
  ].join('\n');

  it('finds the same events it finds in text', () => {
    assert.deepEqual(parseUploaderLog(log), {
      uploadedSegments: [0],
      manifestSocIndices: [4],
      discontinuitiesArmed: 1,
      discontinuitySegments: [1],
      staleWarnings: 1,
      retries: 1,
      videolessSegments: [],
    });
  });
});

describe('every path that arms a discontinuity is counted', () => {
  /**
   * `StreamUploader` arms `pendingDiscontinuity` from three call sites and only one of them says
   * "Failed to upload segment". Anchoring on that one matched a third of them, and both misses are
   * reachable only through the OME puller — an engine this harness supports as a first-class
   * target. Six suites assert `discontinuitiesArmed === 0` in the general wording "must not arm a
   * discontinuity", so on OME each of them was asserting something it could not observe.
   */
  for (const [name, line] of [
    ['the upload retry window being spent', DISCONTINUITY(2)],
    ['a single segment never reaching the uploader', SEGMENT_LOST(2)],
    ['several segments never reaching the uploader', SEGMENTS_LOST(3, 2)],
    ['the origin declaring one', ORIGIN_DISCONTINUITY],
  ] as const) {
    it(`counts ${name}`, () => {
      assert.equal(parseUploaderLog(textLine('error', line)).discontinuitiesArmed, 1);
    });
  }

  /**
   * The dangerous one, stated as its own case. The segment carrying an origin-declared marker IS
   * accepted and uploaded, so it leaves no hole in the indices and `isContiguous` is not a backstop
   * either. If the count misses it, nothing else in the suite can see it.
   */
  it('sees an origin-declared discontinuity that leaves the segment run gapless', () => {
    const log = [
      textLine('log', UPLOADED(0)),
      textLine('info', ORIGIN_DISCONTINUITY),
      textLine('log', UPLOADED(1)),
    ].join('\n');
    const events = parseUploaderLog(log);

    assert.equal(events.discontinuitiesArmed, 1, 'an origin-declared discontinuity must be counted');
    assert.equal(isContiguous(events.uploadedSegments), true, 'and it leaves no gap, which is why the count is needed');
  });

  it('reports no index for the two paths that name none', () => {
    const log = [textLine('error', SEGMENT_LOST(2)), textLine('info', ORIGIN_DISCONTINUITY)].join('\n');
    assert.equal(parseUploaderLog(log).discontinuitiesArmed, 2);
    assert.deepEqual(parseUploaderLog(log).discontinuitySegments, []);
  });

  /**
   * ⛔ The fourth line, and the one that makes this count double on OME. `OmeHlsPuller` reports the
   * loss it just handed to `handleSegmentLoss`, beside the uploader's own line rather than instead
   * of it, so one loss puts two arming lines in the log and this counter reads two.
   *
   * Pinned rather than corrected. The count has always behaved this way, the assertions that read it
   * are `=== 0` and `>= 1` so neither notices, and changing a number in the same breath as moving a
   * message where the contract can see it would leave neither of the two provable.
   */
  const OME_LOSS_REPORT = (first: number, last: number) =>
    `[OME] Segments ${first} to ${last} lost for stream-7 after 3 consecutive download failures, marking a discontinuity`;

  it('counts the OME puller reporting a loss', () => {
    assert.equal(parseUploaderLog(textLine('error', OME_LOSS_REPORT(5, 7))).discontinuitiesArmed, 1);
  });

  it('counts one OME loss twice, because the puller and the uploader each announce it', () => {
    const log = [textLine('error', OME_LOSS_REPORT(5, 7)), textLine('error', SEGMENTS_LOST(3, 5))].join('\n');
    const events = parseUploaderLog(log);

    assert.equal(events.discontinuitiesArmed, 2, 'the count that six suites assert is zero must not have moved');
    assert.deepEqual(events.discontinuitySegments, [], 'and neither line names an index');
  });

  /** The puller's other two words for the same loss, both of which recorded nothing and armed nothing. */
  it('leaves out the puller lines that reported no loss at all', () => {
    const log = [
      textLine('warn', '[OME] Segment 5 lost for stream-7 after the puller stopped, not reporting'),
      textLine('warn', '[OME] Segment 5 lost for stream-7 but no stream is registered to record it'),
    ].join('\n');

    assert.equal(parseUploaderLog(log).discontinuitiesArmed, 0);
  });
});

/**
 * ⛔ Task #40. A recording whose opening segments hold no video plays as sound over a blank picture
 * for its whole length, because the player fixes its codec set from the first fragment it parses.
 * `make:recording` refuses on this, so the pattern going quiet would let it hand back an unplayable
 * recording and call it a success — which is exactly what happened before the check existed.
 */
describe('segments that hold no video are named', () => {
  it('captures the index of the segment the uploader could not read a frame out of', () => {
    assert.deepEqual(parseUploaderLog(textLine('warn', VIDEOLESS(3))).videolessSegments, [3]);
  });

  it('reads it out of the json format too', () => {
    assert.deepEqual(parseUploaderLog(jsonLine('warn', VIDEOLESS(0))).videolessSegments, [0]);
  });

  /**
   * The discriminating case. Both faults share one warning and only one of them costs the picture,
   * so a pattern anchored on the warning rather than the reason would refuse a usable recording and
   * send someone looking for a video problem that is not there.
   */
  it('does not name a segment whose timestamps were merely unusable', () => {
    assert.deepEqual(parseUploaderLog(textLine('warn', UNUSABLE_TIMESTAMPS(3))).videolessSegments, []);
  });

  it('names nothing on an ordinary broadcast', () => {
    const log = [textLine('log', UPLOADED(0)), textLine('log', UPLOADED(1))].join('\n');
    assert.deepEqual(parseUploaderLog(log).videolessSegments, []);
  });
});

describe('announcedLiveTopics', () => {
  it('returns live topics in order and ignores vod entries', () => {
    const log = [
      textLine('log', announcement('topic-a', 'live')),
      textLine('log', announcement('topic-a', 'vod')),
      textLine('log', announcement('topic-b', 'live')),
    ].join('\n');
    assert.deepEqual(announcedLiveTopics(log), ['topic-a', 'topic-b']);
  });

  /**
   * The defect this arm exists for. Under `LOG_FORMAT=json` the entry's quotes are escaped inside
   * `msg`, so the captured text is not JSON, `JSON.parse` throws, and the bare catch in this
   * function turns that into an empty list. Scenario F then fails asserting the uploader never
   * announced a stream, which is a true statement about the parser and a false one about the
   * uploader.
   */
  it('reads an announcement out of a json-format line', () => {
    assert.deepEqual(announcedLiveTopics(jsonLine('log', announcement('topic-json', 'live'))), ['topic-json']);
  });

  it('skips a line whose json tail was truncated', () => {
    const truncated = textLine('log', 'Adding stream to list: {"title":"x","topic":"tr').concat('unc"}');
    assert.deepEqual(announcedLiveTopics(truncated), []);
  });

  it('returns nothing when no stream was announced', () => {
    assert.deepEqual(announcedLiveTopics(textLine('log', UPLOADED(0))), []);
  });

  /**
   * Both of these were excluded by a truthiness guard until this branch extracted the shared parse
   * and replaced it with `!== undefined`. The entries come out of `JSON.parse` on a log line, so the
   * `Partial<AnnouncedStream>` the parse is cast to is a claim rather than a fact, and a predicate
   * reading `topic is string` was signing for a `null`. What a caller then builds is a feed location
   * naming the topic "null", which fetches nothing and reads as the publisher never having started.
   */
  it('drops an announcement whose topic is empty or null, rather than typing it as a string', () => {
    const rawTopicLine = (topicJson: string) =>
      textLine('log', `Adding stream to list: {"owner":"0xabc","topic":${topicJson},"state":"live"}`);
    const log = [rawTopicLine('null'), rawTopicLine('""'), rawTopicLine('"topic-real"')].join('\n');

    assert.deepEqual(announcedLiveTopics(log), ['topic-real']);
  });
});

describe('announcedLiveStreams', () => {
  const liveEntry = (fields: string) => textLine('log', `Adding stream to list: {${fields},"state":"live"}`);

  /**
   * The bench resolves a feed location from this before it publishes anything, and it reads that feed
   * through a gateway rather than asking the uploader, so it needs the owner as well as the topic.
   * That is the whole reason it exists beside `announcedLiveTopics`, and it had no test of its own
   * until the PR #64 gate said so.
   */
  it('returns the owner alongside the topic', () => {
    const [stream, ...rest] = announcedLiveStreams(textLine('log', announcement('topic-a', 'live')));

    assert.deepEqual(rest, []);
    assert.equal(stream.topic, 'topic-a');
    assert.equal(stream.owner, ANNOUNCED_OWNER);
  });

  it('ignores an announcement that is not live', () => {
    assert.deepEqual(announcedLiveStreams(textLine('log', announcement('topic-a', 'vod'))), []);
  });

  /**
   * An entry carrying one of the two names a feed nothing can fetch. Dropped here rather than
   * downstream, where it becomes a request to `/feeds/undefined/...` and a run that waits out its
   * timeout blaming the publisher for a stream the uploader did announce.
   */
  it('drops an entry naming only one half of a feed location', () => {
    const log = [
      liveEntry('"topic":"orphan-topic"'),
      liveEntry(`"owner":"${ANNOUNCED_OWNER}"`),
      liveEntry(`"owner":"${ANNOUNCED_OWNER}","topic":""`),
      liveEntry(`"owner":"","topic":"orphan-owner"`),
      liveEntry(`"owner":"${ANNOUNCED_OWNER}","topic":"whole"`),
    ].join('\n');

    assert.deepEqual(
      announcedLiveStreams(log).map((stream) => stream.topic),
      ['whole'],
    );
  });
});

describe('messageText', () => {
  it('unwraps a json envelope', () => {
    assert.equal(messageText(jsonLine('log', 'hello')), 'hello');
  });

  // The distinction that makes the unwrap safe. A text line carrying a JSON payload must survive
  // untouched, or the announcement's own entry would be mistaken for the envelope and thrown away.
  it('leaves a text line that merely contains json alone', () => {
    const line = textLine('log', announcement('topic-a', 'live'));
    assert.equal(messageText(line), line);
  });

  it('leaves a bare json object with no log fields alone', () => {
    assert.equal(messageText('{"other":1}'), '{"other":1}');
  });

  it('leaves a line that is not json alone', () => {
    assert.equal(messageText('{not json'), '{not json');
  });
});

describe('isContiguous', () => {
  it('accepts a gapless run', () => {
    assert.equal(isContiguous([3, 4, 5, 6]), true);
  });

  it('accepts an unordered gapless run', () => {
    assert.equal(isContiguous([6, 3, 5, 4]), true);
  });

  it('rejects a run with a hole', () => {
    assert.equal(isContiguous([3, 4, 6]), false);
  });

  it('accepts an empty run, since nothing uploaded cannot have a gap', () => {
    assert.equal(isContiguous([]), true);
  });

  it('accepts a single index', () => {
    assert.equal(isContiguous([7]), true);
  });

  /**
   * A duplicate is not a gap. `docker logs --since` can repeat a line at a boundary, and counting
   * duplicates toward the length would make a gapless run read as one with a hole — a scenario
   * failing on an artefact of how its own evidence was collected.
   */
  it('accepts a run containing duplicates', () => {
    assert.equal(isContiguous([3, 4, 4, 5]), true);
  });
});

describe('newIndices', () => {
  it('returns only what was not there before', () => {
    assert.deepEqual(newIndices([1, 2], [1, 2, 3, 4]), [3, 4]);
  });

  it('returns nothing when nothing advanced', () => {
    assert.deepEqual(newIndices([1, 2], [1, 2]), []);
  });

  it('treats an empty before as everything being new', () => {
    assert.deepEqual(newIndices([], [1, 2]), [1, 2]);
  });
});

describe('manifest publishes, per rung', () => {
  /**
   * ⛔ The hole this closes. `service/happy-path` was the only check on manifest publishing and it
   * judged the merged list, which `isContiguous` deduplicates. Four rungs publishing 0,1,2 each
   * collapse to the set {0,1,2}, and so does a ladder where 1080p froze at 0 while the rest reached
   * 2. The one failure mode this deployment actually has was the one the check could not see.
   */
  it('separates four rungs that share one log and one counter sequence', () => {
    const log = [
      textLine('log', MANIFEST(0, 'live/stream_1080p')),
      textLine('log', MANIFEST(0, 'live/stream_360p')),
      textLine('log', MANIFEST(1, 'live/stream_360p')),
      textLine('log', MANIFEST(2, 'live/stream_360p')),
    ].join('\n');

    const byStream = manifestIndicesByStream(log);

    assert.deepEqual(byStream.get('live/stream_1080p'), [0]);
    assert.deepEqual(byStream.get('live/stream_360p'), [0, 1, 2]);
  });

  it('reads a rung that stopped as a short list rather than as a gap in a long one', () => {
    const log = [
      textLine('log', MANIFEST(0, 'live/stream_1080p')),
      textLine('log', MANIFEST(0, 'live/stream_720p')),
      textLine('log', MANIFEST(1, 'live/stream_720p')),
      textLine('log', MANIFEST(2, 'live/stream_720p')),
    ].join('\n');

    const byStream = manifestIndicesByStream(log);

    assert.equal(isContiguous(byStream.get('live/stream_1080p') ?? []), true, 'one publish is still contiguous');
    assert.equal((byStream.get('live/stream_1080p') ?? []).length, 1);
    assert.equal((byStream.get('live/stream_720p') ?? []).length, 3);
  });

  it('reads the json format too, which is what the deployment writes', () => {
    const byStream = manifestIndicesByStream(jsonLine('log', MANIFEST(4, 'live/stream_480p')));

    assert.deepEqual(byStream.get('live/stream_480p'), [4]);
  });

  it('is empty rather than throwing when nothing has published', () => {
    assert.equal(manifestIndicesByStream('').size, 0);
  });
});

describe('a finalize that resumed rather than republishing', () => {
  /**
   * ⛔ The observation that says scenario H's kill landed inside the window it aims at. Without it a
   * run that caught the window and answered it correctly reads exactly like one that missed it: both
   * end on one flip. Counted rather than asserted, because it is a fact about the race the harness
   * cannot control, not about whether the uploader is right.
   */
  const RESUMED = (stream: string, index: number) => finalizeResumed(stream, index);

  it('sees the uploader say it resumed', () => {
    assert.equal(resumedFinalizeCount(textLine('log', RESUMED('live/stream_1080p', 9))), 1);
  });

  it('reads it out of the json format the deployment writes', () => {
    assert.equal(resumedFinalizeCount(jsonLine('log', RESUMED('live/stream_1080p', 9))), 1);
  });

  it('counts each rung, because a ladder resumes one rung at a time', () => {
    const log = [textLine('log', RESUMED('live/stream_720p', 8)), textLine('log', RESUMED('live/stream_1080p', 9))];

    assert.equal(resumedFinalizeCount(log.join('\n')), 2);
  });

  /**
   * ⛔⛔ The line means a recording was NOT published a second time, so counting it as a flip would
   * report the fix for the double publish as the double publish. Pinned here as well as in the
   * shared package, because this is the reader scenario H's assertion goes through.
   */
  it('is not counted as a broadcast finalizing', () => {
    const log = [
      textLine('log', announcement('topic-a', 'live')),
      textLine('log', RESUMED('live/stream_1080p', 9)),
    ].join('\n');

    assert.equal(announcedVodFinalizeCount(log), 0, 'a resume is not a flip');
    assert.equal(resumedFinalizeCount(log), 1);
  });

  it('is zero on a run where nothing crashed', () => {
    const log = [textLine('log', MANIFEST(3)), textLine('log', ladderFinalized('group-1'))].join('\n');

    assert.equal(resumedFinalizeCount(log), 0);
  });
});

describe('the catalog giving up on its own previous state', () => {
  /**
   * ⛔ The one line that separates the two things scenario H's count can mean. `readPreviousState`
   * continues from an empty list only after a boot that resumed to an unread index AND three failed
   * reads of it, and says so at error level. Without this the harness cannot tell a genuine second
   * finalize from a first one the guard could not see, and H has been ambiguous since 2026-08-31.
   */
  const LOST = (index: number) =>
    `[StreamCatalog] State at index ${index} failed to read 3 times; ` +
    'continuing with an empty catalog — earlier entries are lost';

  it('sees the uploader announce that it lost the catalog', () => {
    assert.equal(catalogContinuedEmpty(textLine('error', LOST(12))), 1);
  });

  it('reads it out of the json format the deployment writes', () => {
    assert.equal(catalogContinuedEmpty(jsonLine('error', LOST(12))), 1);
  });

  it('counts each occurrence, because one boot can lose the catalog more than once', () => {
    assert.equal(catalogContinuedEmpty([textLine('error', LOST(12)), textLine('error', LOST(13))].join('\n')), 2);
  });

  /** The two warnings before it are retries that kept the catalog, and must not be counted as loss. */
  it('does not count the attempts that still refused to continue', () => {
    const retry = textLine(
      'warn',
      '[StreamCatalog] State at index 12 did not read (chunk not found); attempt 2 of 3 before it counts as gone',
    );

    assert.equal(catalogContinuedEmpty(retry), 0);
  });

  it('is zero on a log where nothing went wrong', () => {
    assert.equal(catalogContinuedEmpty(textLine('log', MANIFEST(3))), 0);
  });
});
