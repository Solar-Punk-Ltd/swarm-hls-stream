import { manifestUploaded, segmentUploaded } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deployedLogShapeRefusal,
  deployedLogShapeSummary,
  deployedMessage,
  messageLiterals,
} from '../src/deployedLogShape.js';

/**
 * ⛔ Every case here is the 2026-09-01 sitting. The manifest log line gained a stream id, the
 * harness was synced to the host, the uploader was not, and two scenarios reported "manifest
 * publishes never resumed" against a deployment that was publishing manifests throughout. The gate
 * exists so that costs a refusal before the first frame rather than a paid sitting.
 */

const MANIFEST = deployedMessage(
  'manifest publishes',
  (stream, index) => manifestUploaded(stream, index),
  'service/happy-path and the freeze guard in bee-outage-long',
);
const SEGMENT = deployedMessage(
  'per-segment uploads',
  (stream, index) => segmentUploaded(stream, index, 'ref'),
  'every scenario that counts segments',
);

/** The uploader as it stood before the manifest line named its rung. */
const STALE_DIST = 'log(`Manifest uploaded at SOC index ${nextIndex}`)';

describe('splitting a composed message into the parts a deployment must contain', () => {
  it('keeps the fixed halves and drops the values', () => {
    const literals = messageLiterals(MANIFEST.composed);

    assert.ok(
      literals.some((l) => l.includes('uploaded at SOC index')),
      `the distinctive half was lost: ${literals.join(' | ')}`,
    );
    assert.equal(
      literals.some((l) => l.includes('SHAPEPROBE') || l.includes('909090909090')),
      false,
      'a placeholder leaked into what the deployment is checked for',
    );
  });

  /**
   * ⛔ Without this the gate passes against anything. `segmentUploaded` composes to
   * `Segment N of <stream> uploaded: <ref>`, whose middle fragment cuts down to "of" — two
   * characters that occur in every log ever written.
   */
  it('drops fragments too short to distinguish one deployment from another', () => {
    for (const literal of messageLiterals(SEGMENT.composed)) {
      assert.ok(literal.length >= 4, `"${literal}" would match any deployment at all`);
    }
  });
});

describe('refusing a stage whose uploader predates the harness', () => {
  it('refuses when the deployed code cannot write the line', () => {
    const refusal = deployedLogShapeRefusal([MANIFEST], STALE_DIST);

    assert.ok(refusal, 'a stale uploader must not be measured against');
    assert.match(refusal, /manifest publishes/);
    assert.match(refusal, /Redeploy the stream-uploader/);
  });

  /** ⛔ The refusal has to name the wrong fix as wrong, because it is the tempting one. */
  it('tells the reader not to reword the pattern back', () => {
    assert.match(String(deployedLogShapeRefusal([MANIFEST], STALE_DIST)), /Do NOT reword the patterns/);
  });

  it('says which scenarios stop, so a reader knows what the refusal bought them', () => {
    assert.match(String(deployedLogShapeRefusal([MANIFEST], STALE_DIST)), /bee-outage-long/);
  });

  it('passes a deployment built from this same checkout', () => {
    const current = `${MANIFEST.composed} ${SEGMENT.composed}`;

    assert.equal(deployedLogShapeRefusal([MANIFEST, SEGMENT], current), null);
  });

  it('counts every stale line rather than stopping at the first', () => {
    const refusal = String(deployedLogShapeRefusal([MANIFEST, SEGMENT], STALE_DIST));

    assert.match(refusal, /does not write 2 of the log lines/);
  });

  it('passes vacuously on an empty list rather than throwing', () => {
    assert.equal(deployedLogShapeRefusal([], ''), null);
  });

  it('says what a green check proved, so a pass is not silence', () => {
    assert.match(deployedLogShapeSummary([MANIFEST, SEGMENT]), /2 parsed log line/);
  });
});
