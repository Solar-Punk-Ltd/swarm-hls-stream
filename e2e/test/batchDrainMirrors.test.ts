import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { ROOT_DIR } from '../src/config.js';
import {
  DROPPED_SEGMENTS_METRIC,
  HEALTH_REASON_SEGMENT_UPLOAD_FAILURE,
  HEALTH_STATUS_DEGRADED,
  METRICS_PREFIX,
  RUNG_LABEL,
} from '../src/harness/batchDrain.js';
import { rungCountersOf } from '../src/harness/uploaderMetrics.js';

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

/** The one thing loaded out of the uploader package, which is a public export of it. */
type RenderMetrics = (snapshot: unknown) => string;

/**
 * The uploader's own Prometheus renderer, loaded at run time rather than imported.
 *
 * ⚠️ The specifier is built rather than written as a literal, so this stays out of the typecheck's
 * program: e2e is rooted at `e2e/` and declares no dependency on the uploader package. `tsx` runs
 * these tests, so its loader resolves the module the same way a static import would.
 */
async function loadRenderer(): Promise<RenderMetrics> {
  const path = join(ROOT_DIR, 'packages', 'stream-uploader', 'src', 'utils', 'metricsFormat.ts');
  const loaded = (await import(pathToFileURL(path).href)) as { renderPrometheusMetrics: RenderMetrics };
  return loaded.renderPrometheusMetrics;
}

/**
 * One rung that lost segments and one that lost none, which is the shape a drain produces.
 *
 * ⚠️ Every counter the snapshot type carries has to be present, because the renderer walks all of
 * them. Only the two per-rung breakdowns matter here and the rest are zero.
 */
function renderExposition(render: RenderMetrics): string {
  return render({
    segmentsUploadedTotal: 412,
    segmentsUploadedByRung: { '360p': 103, '1080p': 21 },
    segmentsDroppedTotal: 82,
    segmentsDroppedByRung: { '1080p': 82, '360p': 0 },
    segmentsLostTotal: 0,
    segmentsSkippedTotal: 0,
    openingSegmentsWithheldTotal: 0,
    segmentsNeverNamedTotal: 0,
    manifestPublishFailuresTotal: 0,
    streamsFinalizedTotal: 0,
    streamsFailedTotal: 0,
    streamsReapedTotal: 0,
    segmentDurationsUnreadTotal: 0,
    authRejectionsTotal: 0,
    takeoversRefusedTotal: 0,
    lastSegmentAt: null,
    activeStreams: 1,
    queueDepth: 0,
    queueBacklogSeconds: 0,
  });
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
   * ⛔⛔⛔ Asserted on what the renderer OUTPUTS, because a name in its source proved the wrong thing.
   *
   * The exposed string is a module-level prefix joined to a family's own name at render time, so it
   * exists in no source file on either side, and this used to hold each half against its own
   * declaration text. That says the family is declared somewhere in the file. It says nothing about
   * the shape `rungCountersOf` needs, which is one LABELLED sample per rung. Move the counter from
   * the by-rung renderer to the unlabelled list and every declaration the old case looked for is
   * still there, while the harness reads an empty family and refuses after a paid drain with "the
   * scrape did not answer".
   *
   * So the exposition is rendered and then read back through the harness's own parse, which is the
   * arrangement `packages/stream-uploader/test/metrics.test.ts` already uses for its own output.
   *
   * ⚠️ Loaded through a dynamic import of a path built at run time, deliberately. e2e declares no
   * dependency on the uploader package and its typecheck is rooted at `e2e/`, and a static import
   * would be both a dependency this workspace does not have and a licence for any file here to reach
   * into another package's internals. The renderer is a public export of that package and the only
   * thing loaded.
   */
  it('renders the per-rung drop counter as a labelled sample the harness can read', async () => {
    const rendered = renderExposition(await loadRenderer());

    assert.match(
      rendered,
      new RegExp(`^${DROPPED_SEGMENTS_METRIC}\\{`, 'm'),
      `the uploader no longer exposes ${DROPPED_SEGMENTS_METRIC} as a labelled family, so the drain ` +
        'scenario would read an empty family and report a scrape that did not answer',
    );
    assert.deepEqual(
      [...rungCountersOf(rendered, DROPPED_SEGMENTS_METRIC, RUNG_LABEL)],
      [
        ['1080p', 82],
        ['360p', 0],
      ],
      'the drop counter no longer reads back per rung through the parse the drain suite uses',
    );
  });

  /** The prefix is the other half of the same name, and it is a module constant rather than a sample. */
  it('renders every family under the prefix this harness composes with', async () => {
    for (const line of renderExposition(await loadRenderer())
      .split('\n')
      .filter(Boolean)) {
      assert.match(line, new RegExp(`^(?:# (?:HELP|TYPE) )?${METRICS_PREFIX}_`), `"${line}" is not under the prefix`);
    }
  });

  /**
   * ⛔ And the label name, which decides which dimension the counter map is keyed by. A second label
   * on this family read by position rather than by name keys the map by stream, and the suite then
   * refuses that the drained rung is not the rung that lost segments.
   */
  it('labels the per-rung samples with the dimension the parse anchors on', async () => {
    assert.match(
      renderExposition(await loadRenderer()),
      new RegExp(`^${DROPPED_SEGMENTS_METRIC}\\{${RUNG_LABEL}="`, 'm'),
      `the per-rung counter is no longer labelled ${RUNG_LABEL}, which is what rungCountersOf reads`,
    );
  });
});
