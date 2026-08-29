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
  qualitySwitches: { section: 'Quality', label: 'Quality Switches' },
  droppedFrames: { section: 'Quality', label: 'Dropped Frames' },
  levelSelection: { section: 'ABR', label: 'Level Selection' },
  selectedRung: { section: 'ABR', label: 'Selected Rung' },
  bandwidthEstimate: { section: 'ABR', label: 'Bandwidth Estimate' },
  fatalErrors: { section: 'Reliability', label: 'Fatal Errors' },
  liveLatency: { section: 'Live', label: 'E2E Live Latency' },
  liveTargetLatency: { section: 'Live', label: 'Latency Target' },
  bufferStalls: { section: 'Live', label: 'Buffer Stalls' },
} as const;

export interface OverlayMetrics {
  startupMs: number | null;
  rebufferCount: number;
  rebufferMs: number;
  resolution: string | null;
  /**
   * How many times hls.js changed level this session, which is the switch counted rather than seen.
   *
   * ⭐ Distinct from {@link resolution} changing. The decoder reports what it is producing, so two
   * rungs of the same height read as one, and a switch that has been chosen but not yet decoded is
   * invisible. This counter moves on the decision.
   */
  qualitySwitches: number;
  droppedFrames: number;
  /**
   * The rung hls.js has selected, by height in pixels, or null before it has picked one.
   *
   * ⛔ The rung CHOSEN, which is not necessarily the one on screen. Read beside {@link resolution} to
   * tell a player that decided to step down from one that managed to.
   */
  selectedRungHeight: number | null;
  /** Whether the player is choosing its own rung. False means something pinned it and ABR is not under test. */
  abrEnabled: boolean;
  /** What hls.js believes the connection can carry, which is the input its choice is made from. */
  bandwidthEstimateKbps: number | null;
  /** Every rung the player parsed out of the master, by height. Empty where it has no ladder at all. */
  ladderHeights: readonly number[];
  fatalErrors: number;
  liveLatencyS: number | null;
  /**
   * The target hls.js is steering to, which a stall raises above the configured one and nothing
   * lowers again. Read it before believing {@link liveLatencyS} is comparable with another run's.
   */
  liveTargetLatencyS: number | null;
  bufferStalls: number;
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

/** What the overlay writes in `Level Selection` while the player is choosing its own rung. */
export const LEVEL_SELECTION_AUTO = 'auto';

/**
 * A ladder row, as `QoeOverlay.tsx` labels one: the height, behind a marker for the current rung.
 *
 * ⛔ The marker is `▸` on the current rung and a NON-BREAKING SPACE on every other one, so a class
 * written with a literal space would match only the rung being played and report a four rung ladder
 * as ONE. That is exactly the failure this reading exists to catch, so it must not be the failure
 * this reading has. `\s` is what makes it safe: in JavaScript it matches U+00A0 as well as an
 * ordinary space, which is why the non-breaking space is not spelled out beside it.
 */
const LADDER_ROW_RE = /^[\u25b8\s]*(\d+)p$/;

/**
 * Every rung the player parsed out of the master playlist, by height, in the overlay's own order.
 *
 * ⭐ Empty on a single-rendition stream and on a player that has no master, which are the two states
 * a ladder assertion has to be able to tell apart from a ladder. The overlay renders one row per
 * level hls.js holds, so this is the player's view of the ladder rather than the deployment's.
 */
export function ladderHeights(rows: readonly OverlayRow[]): readonly number[] {
  return rows
    .filter((row) => row.section === OVERLAY_FIELDS.selectedRung.section)
    .map((row) => LADDER_ROW_RE.exec(row.label))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
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
    qualitySwitches: number(OVERLAY_FIELDS.qualitySwitches) ?? 0,
    droppedFrames: number(OVERLAY_FIELDS.droppedFrames) ?? 0,
    // `720p`, so the leading number is the height. The placeholder is a rung not yet picked.
    selectedRungHeight: number(OVERLAY_FIELDS.selectedRung),
    abrEnabled: requireField(rows, OVERLAY_FIELDS.levelSelection).trim() === LEVEL_SELECTION_AUTO,
    bandwidthEstimateKbps: number(OVERLAY_FIELDS.bandwidthEstimate),
    ladderHeights: ladderHeights(rows),
    fatalErrors: number(OVERLAY_FIELDS.fatalErrors) ?? 0,
    liveLatencyS: number(OVERLAY_FIELDS.liveLatency),
    liveTargetLatencyS: number(OVERLAY_FIELDS.liveTargetLatency),
    bufferStalls: number(OVERLAY_FIELDS.bufferStalls) ?? 0,
  };
}
