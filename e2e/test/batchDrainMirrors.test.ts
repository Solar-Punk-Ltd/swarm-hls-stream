import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT_DIR } from '../src/config.js';
import {
  DROPPED_SEGMENTS_FAMILY,
  DROPPED_SEGMENTS_METRIC,
  HEALTH_REASON_SEGMENT_UPLOAD_FAILURE,
  HEALTH_STATUS_DEGRADED,
  METRICS_PREFIX,
} from '../src/harness/batchDrain.js';

/**
 * The three strings the drain suites assert on that the uploader, not this harness, decides.
 *
 * A `/health` reason, the degraded status beside it and the name of a Prometheus counter are all
 * chosen in the uploader and copied here, because e2e must not reach past a package boundary into
 * another package's internals. A copy is only safe while something refuses the two drifting apart,
 * which is the arrangement `rungDeathAgreement.test.ts` uses for the two rung-death limits and
 * `logLevel.test.ts` uses for the uploader's own log call sites.
 *
 * ⛔ Drift here is not a crash. A reason renamed in the uploader leaves
 * `segmentUploadFailureRefusal` asking for a word nothing writes, so the drain scenario goes red
 * saying the service never noticed the rung it had just watched go quiet. A counter renamed leaves
 * `droppedSegmentsRefusal` reading an empty family, which its own refusal correctly reports as a
 * scrape that did not answer. Both are red for the wrong reason, after a paid broadcast.
 */

function sourceOf(...segments: string[]): string {
  return readFileSync(join(ROOT_DIR, 'packages', 'stream-uploader', 'src', ...segments), 'utf8');
}

describe('the batch-drain suites and the uploader agree about what they read', () => {
  it("uses the /health reason the uploader's own types declare", () => {
    assert.match(
      sourceOf('types.ts'),
      new RegExp(`HEALTH_REASON_SEGMENT_UPLOAD_FAILURE\\s*=\\s*'${HEALTH_REASON_SEGMENT_UPLOAD_FAILURE}'`),
      `the uploader no longer declares the reason '${HEALTH_REASON_SEGMENT_UPLOAD_FAILURE}', so the drain ` +
        'scenario would assert on a word nothing writes and report a service that never noticed the drain',
    );
  });

  it('uses the degraded status the uploader answers with', () => {
    assert.match(
      sourceOf('types.ts'),
      new RegExp(`HEALTH_DEGRADED\\s*=\\s*'${HEALTH_STATUS_DEGRADED}'`),
      `the uploader no longer answers '${HEALTH_STATUS_DEGRADED}' for a degraded service`,
    );
  });

  /**
   * ⚠️ The exposed name is a prefix and a family name joined at render time, so the whole string
   * exists in no source file on either side. Each half is held against its own declaration.
   */
  it('names the per-rung drop counter the metrics renderer builds', () => {
    const rendered = sourceOf('utils', 'metricsFormat.ts');

    assert.match(rendered, new RegExp(`PREFIX\\s*=\\s*'${METRICS_PREFIX}'`), 'the metric prefix moved');
    assert.match(
      rendered,
      new RegExp(`name:\\s*'${DROPPED_SEGMENTS_FAMILY}'`),
      `the uploader no longer renders ${DROPPED_SEGMENTS_METRIC}, so the drain scenario would read an ` +
        'empty family and report a scrape that did not answer',
    );
  });
});
