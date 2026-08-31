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
 * A metric with one label dimension, rendered as one sample per label value.
 *
 * Deliberately one dimension and not a general label set. The only thing here that needs breaking
 * down is the ABR rung, and a renderer that accepted arbitrary label maps would be carrying a
 * Prometheus client library's problem without carrying the library.
 */
interface LabelledMetric {
  name: string;
  type: MetricType;
  help: string;
  labelName: string;
  /** Empty is legal and renders the HELP and TYPE with no samples, which is what "no rungs" means. */
  byLabel: Readonly<Record<string, number>>;
}

/**
 * Milliseconds everywhere else in this service, seconds here, because Prometheus convention is base
 * units and a timestamp gauge is compared against `time()` in a query. Rendering is the only place
 * that conversion belongs, so nothing upstream has to remember it.
 *
 * ⛔ The null branch is an EQUIVALENT MUTANT and no test can kill it. `null / 1000` is already `0` in
 * JavaScript, so removing the check leaves every output identical. It is kept because relying on that
 * coercion would state the intent nowhere, and it is written down here so the surviving mutant is not
 * mistaken for a coverage gap and chased a second time.
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
      name: 'opening_segments_withheld_total',
      type: 'counter',
      help: 'Segments withheld from the manifest because the broadcast had produced no video yet, so a player would have fixed an audio-only codec set from the first one and kept it for the whole stream. Read next to segments_uploaded_total: a few at the start is the guard working, climbing while uploads stay flat is a publisher sending no frames.',
      value: snapshot.openingSegmentsWithheldTotal,
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
      name: 'streams_reaped_total',
      type: 'counter',
      help: 'Streams the reaper gave up on because their engine went silent, rather than because a stop was sent. Counts the decision, not the finalize that follows it, so cross-reference streams_failed_total to see whether the recording was published. A rising rate means an engine is dying without unpublishing.',
      value: snapshot.streamsReapedTotal,
    },
    {
      name: 'segment_durations_unread_total',
      type: 'counter',
      help: "Segments published with the engine's declared duration because their own timestamps could not be read. Both shipped engines deliver MPEG-TS, so this is expected to stay at zero. Any rise means those segments' durations are the engine's claim, which on SRS measured 20 to 25% long.",
      value: snapshot.segmentDurationsUnreadTotal,
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
 * Per-rung breakdowns, which the unlabelled totals above cannot give.
 *
 * ⛔ **Added 2026-08-31 because the number that decides this phase had no instrument.** Four rungs at
 * 0.5s segments need 8.00 uploads a second between them and 2.00 each, and the shared single Bee node
 * was measured delivering 5.61 in total. Whether one node per rung fixes that is a per-rung question,
 * and the only reading anyone had was a grep of the uploader's log. A reading that names a decision
 * has to come from where the decision is made.
 *
 * ⚠️ **Empty on a single-rendition deployment, and that is not zero uploads.** A stream with no ladder
 * has no rung to attribute a segment to, so it appears in `segments_uploaded_total` and nowhere here.
 * The HELP text says so, because a dashboard panel reading empty looks exactly like a dead service.
 */
function describeByRung(snapshot: MetricsSnapshot): LabelledMetric[] {
  return [
    {
      name: 'rung_segments_uploaded_total',
      type: 'counter',
      help: 'Segments whose payload reached Swarm, by ABR rung. Difference two scrapes to get a rate: four rungs at 0.5s segments need 2.00 a second each. Empty on a single-rendition deployment, where a segment belongs to no rung and is counted only in segments_uploaded_total.',
      labelName: 'rung',
      byLabel: snapshot.segmentsUploadedByRung,
    },
  ];
}

/**
 * Prometheus text exposition, hand-rendered rather than through a client library: no histograms, no
 * registry and one label dimension, against a dependency that would have to be provenance checked and
 * carried. Every consumer of this format reads it, including a plain curl.
 */
export function renderPrometheusMetrics(snapshot: MetricsSnapshot): string {
  const plain = describe(snapshot).flatMap(({ name, type, help, value }) => [
    `# HELP ${PREFIX}_${name} ${help}`,
    `# TYPE ${PREFIX}_${name} ${type}`,
    `${PREFIX}_${name} ${value}`,
  ]);

  const labelled = describeByRung(snapshot).flatMap(({ name, type, help, labelName, byLabel }) => [
    `# HELP ${PREFIX}_${name} ${help}`,
    `# TYPE ${PREFIX}_${name} ${type}`,
    // Sorted, so two scrapes of an unchanged service are byte-identical and a diff shows only what moved.
    ...Object.keys(byLabel)
      .sort()
      .map((label) => `${PREFIX}_${name}{${labelName}="${escapeLabelValue(label)}"} ${byLabel[label]}`),
  ]);

  // Trailing newline is required by the exposition format, not cosmetic.
  return `${[...plain, ...labelled].join('\n')}\n`;
}

/**
 * Escaped per the exposition format: backslash, double quote and newline.
 *
 * `AbrLadder` already refuses a rung name containing any of them, so nothing that reaches here today
 * needs escaping. It is done anyway because a rung name arrives from configuration, and a value that
 * broke out of its quotes would corrupt every sample after it in the response rather than its own.
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
