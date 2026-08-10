/**
 * What a preview card should do with the manifest it just asked for.
 *
 * Extracted from the component so the decision can be tested without a DOM. The card itself has no
 * test at all, and the bug this replaced was entirely in the branching rather than in the rendering:
 * one early return covered three different situations and left the spinner up for two of them.
 */

import type { Segment } from '@swarm-hls-stream/shared';

/** Only the fields the decision reads, so a test does not have to build a whole `Response`. */
export interface PreviewManifestResponse {
  ok: boolean;
  status: number;
}

export type PreviewSource =
  | { kind: 'playable'; firstSegment: Segment }
  /** Nothing to show, and the card must say so rather than keep spinning. `reason` is for the log. */
  | { kind: 'unavailable'; reason: string };

/**
 * ⛔ The distinction this exists to keep: `parseManifest` returns `segments: []` both for a playlist
 * that genuinely lists no segments and for a body that was never a playlist, and a 404 page parses to
 * exactly the same empty result as an empty playlist. Reading `ok` first is what separates "the
 * gateway does not have this" from "the broadcast published nothing", which are the same value by the
 * time the parser is done with them.
 *
 * Both still end as `unavailable`, because a viewer can do nothing about either. They are kept apart
 * so the reason reaching the log names the one that happened.
 */
export function previewSourceFrom(response: PreviewManifestResponse, segments: readonly Segment[]): PreviewSource {
  if (!response.ok) {
    return { kind: 'unavailable', reason: `the gateway answered ${response.status} for this preview manifest` };
  }
  if (segments.length === 0) {
    return { kind: 'unavailable', reason: 'the preview manifest lists no segments' };
  }
  return { kind: 'playable', firstSegment: segments[0] };
}
