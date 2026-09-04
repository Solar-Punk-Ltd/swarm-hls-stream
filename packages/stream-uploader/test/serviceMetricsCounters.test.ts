import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ServiceMetrics } from '../src/libs/ServiceMetrics.js';
import { renderPrometheusMetrics } from '../src/utils/metricsFormat.js';

/**
 * Two counters that nothing asserted, found by a mutation run over this package on 2026-09-05.
 *
 * ⛔ Emptying either recorder's body, or turning its `+=` into a `-=`, left every test in this
 * package green. They are not reachable from `metrics.test.ts`, which drives the service through its
 * API and would need a failing manifest publish and a segment nobody named to provoke them, so they
 * had no coverage at either level.
 *
 * ⭐ Read off the rendered exposition rather than off the snapshot, because the exposition is what an
 * operator's dashboard queries and the name is half of the contract. A counter that increments into a
 * field nothing renders is not a counter anybody has.
 */
describe('the counters an operator reads but no test watched', () => {
  function sampleOf(text: string, name: string): number | undefined {
    const line = text.split('\n').find((row) => row.startsWith(`${name} `));
    return line === undefined ? undefined : Number(line.slice(name.length + 1));
  }

  /**
   * The three readings the orchestrator adds to a counter set on its way to the endpoint. Zero for
   * all of them here, since this file is about the counters and not about a running broadcast.
   */
  function rendered(metrics: ServiceMetrics): string {
    return renderPrometheusMetrics({
      ...metrics.getCounters(),
      activeStreams: 0,
      queueDepth: 0,
      queueBacklogSeconds: 0,
    });
  }

  it('counts each failed manifest publish, and renders it under its own name', () => {
    const metrics = new ServiceMetrics();

    metrics.recordManifestPublishFailure();
    metrics.recordManifestPublishFailure();

    assert.equal(sampleOf(rendered(metrics), 'swarm_hls_manifest_publish_failures_total'), 2);
  });

  /** Takes a count rather than a call, because the uploader learns of a whole run of them at once. */
  it('adds up the segments no manifest ever named, and renders them under their own name', () => {
    const metrics = new ServiceMetrics();

    metrics.recordSegmentsNeverNamed(3);
    metrics.recordSegmentsNeverNamed(2);

    assert.equal(sampleOf(rendered(metrics), 'swarm_hls_segments_never_named_total'), 5);
  });

  it('renders both at zero on a broadcast that lost nothing, rather than leaving them out', () => {
    const text = rendered(new ServiceMetrics());

    assert.equal(sampleOf(text, 'swarm_hls_manifest_publish_failures_total'), 0);
    assert.equal(sampleOf(text, 'swarm_hls_segments_never_named_total'), 0);
  });
});
