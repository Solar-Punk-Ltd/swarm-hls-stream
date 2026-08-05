import { MetricsSnapshot } from '../libs/ServiceMetrics.js';

const PREFIX = 'swarm_hls';

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

type MetricType = 'counter' | 'gauge';

interface RenderedMetric {
  name: string;
  type: MetricType;
  help: string;
  value: number;
}

/**
 * Milliseconds everywhere else in this service, seconds here, because Prometheus convention is base
 * units and a timestamp gauge is compared against `time()` in a query. Rendering is the only place
 * that conversion belongs, so nothing upstream has to remember it.
 */
function toUnixSeconds(epochMs: number | null): number {
  return epochMs === null ? 0 : epochMs / 1000;
}

function describe(snapshot: MetricsSnapshot): RenderedMetric[] {
  return [
    {
      name: 'segments_uploaded_total',
      type: 'counter',
      help: 'Segments whose payload reached Swarm.',
      value: snapshot.segmentsUploadedTotal,
    },
    {
      name: 'segments_dropped_total',
      type: 'counter',
      help: 'Segments that reached the uploader and whose upload retry window was spent. The data is gone.',
      value: snapshot.segmentsDroppedTotal,
    },
    {
      name: 'segments_lost_total',
      type: 'counter',
      help: 'Segments the engine could never obtain, so they never reached an uploader.',
      value: snapshot.segmentsLostTotal,
    },
    {
      name: 'segments_skipped_total',
      type: 'counter',
      help: 'Segments discarded on purpose because they belong to the session a puller replaced. Not a failure.',
      value: snapshot.segmentsSkippedTotal,
    },
    {
      name: 'segments_never_named_total',
      type: 'counter',
      help: 'Segments uploaded to Swarm that no published manifest ever named, so no viewer can reach them.',
      value: snapshot.segmentsNeverNamedTotal,
    },
    {
      name: 'auth_rejections_total',
      type: 'counter',
      help: 'Requests refused by a credential gate. Rising with no ingest means a secret this deployment holds is wrong.',
      value: snapshot.authRejectionsTotal,
    },
    {
      name: 'takeovers_refused_total',
      type: 'counter',
      help: 'Announces refused because another publisher holds that stream id: either it is still being fed, or its holder proved the stream publish key, in which case going quiet will never free it. This cannot tell an attack from a broadcaster locked out of their own id, so read it next to who is publishing: if the live session is the wrong one, POST /stream/stop frees the id.',
      value: snapshot.takeoversRefusedTotal,
    },
    {
      name: 'manifest_publish_failures_total',
      type: 'counter',
      help: 'Live manifest publishes that failed. Retried at the same index when the next segment arrives.',
      value: snapshot.manifestPublishFailuresTotal,
    },
    {
      name: 'streams_finalized_total',
      type: 'counter',
      help: 'Streams whose stop published a VOD.',
      value: snapshot.streamsFinalizedTotal,
    },
    {
      name: 'streams_failed_total',
      type: 'counter',
      help: 'Streams whose stop did not publish a VOD. There is no recording of those broadcasts.',
      value: snapshot.streamsFailedTotal,
    },
    {
      name: 'last_segment_timestamp_seconds',
      type: 'gauge',
      help: 'Unix time of the newest segment that reached Swarm. Zero while none has.',
      value: toUnixSeconds(snapshot.lastSegmentAt),
    },
    {
      name: 'active_streams',
      type: 'gauge',
      help: 'Streams registered and expected to be producing segments.',
      value: snapshot.activeStreams,
    },
    {
      name: 'queue_depth',
      type: 'gauge',
      help: 'Segments waiting to upload, across every registered stream.',
      value: snapshot.queueDepth,
    },
    {
      name: 'queue_backlog_seconds',
      type: 'gauge',
      help: 'Playing time still waiting to upload for the worst stream, which is how far behind live it is.',
      value: snapshot.queueBacklogSeconds,
    },
  ];
}

/**
 * Prometheus text exposition, hand-rendered rather than through a client library: ten metrics with no
 * labels, no histograms and no registry, against a dependency that would have to be provenance
 * checked and carried. Every consumer of this format reads it, including a plain curl.
 */
export function renderPrometheusMetrics(snapshot: MetricsSnapshot): string {
  const lines = describe(snapshot).flatMap(({ name, type, help, value }) => [
    `# HELP ${PREFIX}_${name} ${help}`,
    `# TYPE ${PREFIX}_${name} ${type}`,
    `${PREFIX}_${name} ${value}`,
  ]);

  // Trailing newline is required by the exposition format, not cosmetic.
  return `${lines.join('\n')}\n`;
}
