import { publishingRendition } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ladderRungs, publishedRenditions } from '../src/harness/logwatch.js';

/**
 * The ladder half of the log parsers, which arrived with the ABR merge and had nothing reading it.
 *
 * ⛔ The fixtures are built with `publishingRendition`, the same composer the uploader logs through,
 * not with a hand-typed copy of the sentence. A hand-typed fixture tests the parser against itself:
 * both halves can drift away from the uploader together and stay green while the harness matches
 * nothing on a real log. That is the exact shape `logwatch.ts` was already bitten by over JSON
 * envelopes, where a scenario blamed the uploader for never announcing a stream it had announced.
 */

/** `Logger`'s text format: `[ts] [LEVEL] - message`. */
function textLine(message: string): string {
  return `[2026-08-25T09:14:05.123Z] [INFO] - ${message}`;
}

/** `Logger`'s `LOG_FORMAT=json` format, which the parsers have to see through. */
function jsonLine(message: string): string {
  return JSON.stringify({ ts: '2026-08-25T09:14:05.123Z', level: 'info', msg: message });
}

const LADDER = 'group-7';
const RUNGS = ['360p', '480p', '720p', '1080p'];

describe('publishedRenditions', () => {
  it('reads a rung and its ladder out of the text format', () => {
    const log = textLine(publishingRendition('720p', LADDER));

    assert.deepEqual(publishedRenditions(log), [{ rung: '720p', ladder: LADDER }]);
  });

  it('reads them out of the JSON format too, since a deployment chooses which one it writes', () => {
    const log = jsonLine(publishingRendition('720p', LADDER));

    assert.deepEqual(publishedRenditions(log), [{ rung: '720p', ladder: LADDER }]);
  });

  it('keeps every publish, in order, so a rung that stopped publishing is visible', () => {
    const log = [...RUNGS, '360p', '480p'].map((rung) => textLine(publishingRendition(rung, LADDER))).join('\n');

    assert.deepEqual(
      publishedRenditions(log).map((p) => p.rung),
      [...RUNGS, '360p', '480p'],
    );
  });

  it('finds nothing in a single-rendition broadcast, which logs no rung at all', () => {
    const log = [textLine('Segment 3 uploaded: bzz://a1b2c3'), textLine('Manifest uploaded at SOC index 4')].join('\n');

    assert.deepEqual(publishedRenditions(log), []);
  });

  it('is not fooled by a failure line mentioning the same words', () => {
    const log = textLine('Failed to publish rendition 720p of ladder group-7 after 3 attempts');

    assert.deepEqual(publishedRenditions(log), []);
  });
});

describe('ladderRungs', () => {
  it('deduplicates, so the answer is how wide the ladder is and not how long it ran', () => {
    const log = [...RUNGS, ...RUNGS, ...RUNGS].map((rung) => textLine(publishingRendition(rung, LADDER))).join('\n');

    assert.deepEqual(ladderRungs(log), RUNGS);
  });

  it('scopes to one ladder, so a second broadcast in the same log is not counted into the first', () => {
    const log = [
      ...RUNGS.map((rung) => publishingRendition(rung, LADDER)),
      ...['360p', '720p'].map((rung) => publishingRendition(rung, 'group-8')),
    ]
      .map(textLine)
      .join('\n');

    assert.deepEqual(ladderRungs(log, LADDER), RUNGS);
    assert.deepEqual(ladderRungs(log, 'group-8'), ['360p', '720p']);
  });

  it('reports every ladder when asked for none, which is what a preflight wants', () => {
    const log = [publishingRendition('360p', LADDER), publishingRendition('720p', 'group-8')].map(textLine).join('\n');

    assert.deepEqual(ladderRungs(log).sort(), ['360p', '720p']);
  });

  it('answers empty for a ladder that never published, rather than falling back to all of them', () => {
    const log = RUNGS.map((rung) => textLine(publishingRendition(rung, LADDER))).join('\n');

    assert.deepEqual(ladderRungs(log, 'group-never'), []);
  });
});
