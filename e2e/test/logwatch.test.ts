import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  announcedLiveTopics,
  isContiguous,
  messageText,
  newIndices,
  parseUploaderLog,
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

/** The exact message `StreamUploader.notifyStart` logs, entry shape included. */
function announcement(topic: string, state: string): string {
  return `Adding stream to list: ${JSON.stringify({
    title: '2026-08-02 09:14',
    owner: '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3',
    topic,
    state,
    mediatype: 'video',
    timestamp: 1786000445123,
  })}`;
}

const UPLOADED = (index: number) => `Segment ${index} uploaded: bzz://a1b2c3`;
const MANIFEST = (index: number) => `Manifest uploaded at SOC index ${index}`;
const DISCONTINUITY = (index: number) =>
  `Failed to upload segment ${index} for stream stream-7 within the retry window; marking a discontinuity`;
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

  it('captures the segment a discontinuity was armed for', () => {
    assert.deepEqual(parseUploaderLog(log).discontinuitiesArmed, [2]);
  });

  it('counts stale warnings and retries', () => {
    const events = parseUploaderLog(log);
    assert.equal(events.staleWarnings, 1);
    assert.equal(events.retries, 1);
  });

  it('reports nothing rather than throwing on an empty log', () => {
    assert.deepEqual(parseUploaderLog(''), {
      uploadedSegments: [],
      discontinuitiesArmed: [],
      manifestSocIndices: [],
      staleWarnings: 0,
      retries: 0,
    });
  });

  // The distinction the bee-outage scenarios turn on. A failed upload must not be counted as one
  // that landed, or scenario B's gap would read as a clean run.
  it('does not count a failed segment as uploaded', () => {
    assert.deepEqual(parseUploaderLog(textLine('error', DISCONTINUITY(9))).uploadedSegments, []);
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
      discontinuitiesArmed: [1],
      staleWarnings: 1,
      retries: 1,
    });
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
