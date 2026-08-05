/**
 * Reading the player's own QoE overlay, which is where `hls.latency` is visible from outside.
 *
 * The client renders this overlay behind `?qoe=1` and it already carries every number this
 * validation needs. Reading it beats instrumenting the client for two reasons: the shipped build is
 * the thing under test, and an overlay a viewer can turn on is a feature rather than a test hook, so
 * nothing here can drift out of the product without someone noticing in the product.
 *
 * The cost is that the join is a label written as prose. That is handled by looking values up under
 * their section heading and **throwing when a label is absent**, so a reworded overlay stops the run
 * instead of quietly reporting nulls that would read as "the player had no latency".
 */

export interface OverlayRow {
  section: string;
  label: string;
  value: string;
}

/** The overlay's placeholder for a metric it does not have a value for yet. */
export const OVERLAY_EMPTY = '—';

/** Section and label pairs, as `QoeOverlay.tsx` writes them. */
export const OVERLAY_FIELDS = {
  startupTime: { section: 'Startup', label: 'Startup Time' },
  rebufferCount: { section: 'Rebuffering', label: 'Count' },
  rebufferDuration: { section: 'Rebuffering', label: 'Duration' },
  resolution: { section: 'Quality', label: 'Delivered Resolution' },
  droppedFrames: { section: 'Quality', label: 'Dropped Frames' },
  fatalErrors: { section: 'Reliability', label: 'Fatal Errors' },
  liveLatency: { section: 'Live', label: 'E2E Live Latency' },
} as const;

export interface OverlayMetrics {
  startupMs: number | null;
  rebufferCount: number;
  rebufferMs: number;
  resolution: string | null;
  droppedFrames: number;
  fatalErrors: number;
  liveLatencyS: number | null;
}

/**
 * Pull one field out of the rows, or say which one was missing.
 *
 * Throwing rather than defaulting: a label this cannot find is a label that was renamed, and the
 * honest response to "I no longer know where the latency is" is to stop, not to report that there
 * was none.
 */
function requireField(rows: readonly OverlayRow[], field: { section: string; label: string }): string {
  const row = rows.find((candidate) => candidate.section === field.section && candidate.label === field.label);
  if (!row) {
    throw new Error(
      `the QoE overlay has no '${field.label}' under '${field.section}'. The overlay was reworded, and ` +
        'every number this harness reads out of it is now suspect. Update OVERLAY_FIELDS.',
    );
  }
  return row.value;
}

/**
 * The leading number in an overlay value, or null for the placeholder.
 *
 * Values arrive with their units attached (`1234 ms`, `5.20 s`, `12.3%`) because the overlay is
 * written for a person. The unit is not read back: each field's unit is fixed by the overlay's own
 * formatter and named in {@link OverlayMetrics}, so parsing it would only introduce a way to
 * disagree with it.
 */
export function parseOverlayNumber(value: string): number | null {
  if (value.trim() === OVERLAY_EMPTY) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readOverlayMetrics(rows: readonly OverlayRow[]): OverlayMetrics {
  const number = (field: { section: string; label: string }) => parseOverlayNumber(requireField(rows, field));
  const resolution = requireField(rows, OVERLAY_FIELDS.resolution);

  return {
    startupMs: number(OVERLAY_FIELDS.startupTime),
    // Counters, so a placeholder means none rather than unknown.
    rebufferCount: number(OVERLAY_FIELDS.rebufferCount) ?? 0,
    rebufferMs: number(OVERLAY_FIELDS.rebufferDuration) ?? 0,
    resolution: resolution.trim() === OVERLAY_EMPTY ? null : resolution.trim(),
    droppedFrames: number(OVERLAY_FIELDS.droppedFrames) ?? 0,
    fatalErrors: number(OVERLAY_FIELDS.fatalErrors) ?? 0,
    liveLatencyS: number(OVERLAY_FIELDS.liveLatency),
  };
}
