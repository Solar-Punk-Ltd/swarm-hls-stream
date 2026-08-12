import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import type { Segment } from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestManagement';

/**
 * The measurement behind `docs/bench/manifest-growth-2026-08-12.md`, kept so the numbers there can
 * be re-run rather than trusted.
 *
 * Skipped unless `PROBE_OUT` names a file to write, because it is a timing run rather than a check:
 * it asserts nothing, and a wall-clock assertion in the suite would either be flaky or so loose it
 * could not fail. What this side does structurally is guarded in `manifestGrowth.test.ts` instead.
 *
 *   PROBE_OUT=/tmp/growth.txt pnpm --filter client test -- manifestGrowth.probe
 *
 * ⛔ It runs under vitest rather than as a script because `ManifestManagement` reaches
 * `import.meta.env` transitively, which only a vite environment defines.
 *
 * ⛔ These are this machine's numbers. A viewer's phone is several times slower, and this side's
 * rebuild is only a floor on what a poll costs: hls.js re-parses the whole playlist on top of it.
 */
const OUT = process.env.PROBE_OUT;

const HEADERS = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1'];
const BYTES_URL = 'http://localhost:1633/bzz/';
const SAMPLES_PER_POINT = 9;
const COUNTS = [1_200, 3_600, 7_200, 14_400, 28_800, 72_000];

/**
 * Both segment lengths, which is a control rather than a second arm: the manifests are byte
 * identical at equal count, so whatever separates the two is this probe's own noise.
 */
const SEGMENT_LENGTHS_S = [0.5, 1];

function ref(index: number): string {
  return index.toString(16).padStart(64, '0');
}

function segmentAt(index: number, durationS: number): Segment {
  return { extinf: `#EXTINF:${durationS.toFixed(6)},`, uri: ref(index) };
}

/** One poll that found something new, which is what a viewer at the live edge does nearly always. */
function timeOneDirtyRebuild(manager: ManifestStateManager, topic: string, index: number, durationS: number): number {
  manager.updateManifest(topic, HEADERS, [segmentAt(index, durationS)], false);
  const started = performance.now();
  manager.serialize(topic, BYTES_URL);
  return performance.now() - started;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function fill(manager: ManifestStateManager, topic: string, from: number, to: number, durationS: number): void {
  if (to <= from) {
    return;
  }
  const batch = Array.from({ length: to - from }, (_unused, offset) => segmentAt(from + offset, durationS));
  manager.updateManifest(topic, HEADERS, batch, false);
}

/**
 * The control, run before anything else. A rebuild is only paid when the state is dirty, so a poll
 * that found nothing new has to collapse to nothing. If it does not, the curve below is timing the
 * wrong path and none of it means anything.
 */
function controlCleanAgainstDirty(manager: ManifestStateManager): string {
  const topic = 'probe-control';
  manager.clear(topic);
  fill(manager, topic, 0, 72_000, 0.5);

  const dirty: number[] = [];
  const clean: number[] = [];
  for (let i = 0; i < SAMPLES_PER_POINT; i++) {
    dirty.push(timeOneDirtyRebuild(manager, topic, 72_000 + i, 0.5));
    const started = performance.now();
    manager.serialize(topic, BYTES_URL);
    clean.push(performance.now() - started);
  }

  return `at 72,000 segments: found a new segment ${median(dirty).toFixed(3)} ms, found nothing ${median(clean).toFixed(
    4,
  )} ms`;
}

describe.skipIf(!OUT)('manifest growth probe', () => {
  it('writes the cost curve', () => {
    const manager = ManifestStateManager.getInstance();
    const lines = ['=== CONTROL ===', controlCleanAgainstDirty(manager), ''];
    lines.push('segment_s\tsegments\tbroadcast_min\tmedian_ms\tmin_ms\tmax_ms\tmanifest_kb');

    for (const durationS of SEGMENT_LENGTHS_S) {
      const topic = `probe-growth-${durationS}`;
      manager.clear(topic);
      let placed = 0;

      for (const target of COUNTS) {
        fill(manager, topic, placed, target - SAMPLES_PER_POINT, durationS);
        placed = Math.max(placed, target - SAMPLES_PER_POINT);

        const timings: number[] = [];
        for (let i = 0; i < SAMPLES_PER_POINT; i++) {
          timings.push(timeOneDirtyRebuild(manager, topic, placed, durationS));
          placed++;
        }

        lines.push(
          [
            durationS,
            placed,
            ((placed * durationS) / 60).toFixed(1),
            median(timings).toFixed(3),
            Math.min(...timings).toFixed(3),
            Math.max(...timings).toFixed(3),
            (manager.serialize(topic, BYTES_URL).length / 1024).toFixed(1),
          ].join('\t'),
        );
      }
    }

    writeFileSync(OUT as string, `${lines.join('\n')}\n`);
  });
});
