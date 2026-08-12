/**
 * Distil longrun reports into one row per arm, plus the five-hop breakdown.
 *
 * Written against the 2026-08-12 GOP sustain sitting BEFORE the GOP floor sitting's arms landed, so
 * the analysis is fixed in advance rather than chosen once the answer is visible.
 *
 * ⚠️ segmentBytes are FETCHED bytes over a sampled subset, never published bytes. Cost per byte must
 * be computed against bitrate x duration elsewhere. Nothing here prices anything.
 *
 *   node distil-longrun.mjs <file.json> [more.json ...]
 */
import { readFileSync } from 'node:fs';

const HOPS = ['segment', 'upload', 'manifestPublish', 'feedPropagation', 'fetch'];

const median = (xs) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Wall-clock span the samples actually cover, which is what a rate must be divided by. */
function publishingSeconds(samples) {
  const captured = samples.map((s) => s.split.instants.capturedAtMs).filter(Number.isFinite);
  return captured.length < 2 ? NaN : (Math.max(...captured) - Math.min(...captured)) / 1000;
}

function distil(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const samples = report.samples ?? [];
  if (samples.length === 0) return null;

  const hopMedians = Object.fromEntries(
    HOPS.map((name) => [
      name,
      median(samples.map((s) => s.split.hops.find((h) => h.name === name)?.ms).filter(Number.isFinite)),
    ]),
  );
  // Everything the GOP does not directly buy: the floor a smaller segment cannot remove by itself.
  const nonSegment = HOPS.filter((h) => h !== 'segment').reduce((sum, h) => sum + hopMedians[h], 0);

  const spanS = publishingSeconds(samples);
  const bytes = samples.map((s) => s.segmentBytes).filter(Number.isFinite);
  const stalled = samples.filter((s) => (s.unservedForMs ?? 0) > 0);

  return {
    file: path.split('/').pop(),
    at: report.measuredAt,
    gop: report.knobs.gopSeconds,
    n: samples.length,
    totalMs: median(samples.map((s) => s.split.totalMs)),
    viewerMs: median(samples.map((s) => s.split.viewerLatencyMs)),
    segMs: median(samples.map((s) => s.declaredDurationS * 1000)),
    segKB: median(bytes) / 1024,
    // Sampled bytes over the span they cover. A coverage proxy, NOT the published byte rate.
    sampledMbps: (bytes.reduce((a, b) => a + b, 0) * 8) / spanS / 1e6,
    stalls: stalled.length,
    worstStallS: stalled.length ? Math.max(...stalled.map((s) => s.unservedForMs)) / 1000 : 0,
    refetch: samples.filter((s) => (s.fetchAttempts ?? 1) > 1).length,
    ...hopMedians,
    nonSegment,
  };
}

const rows = process.argv.slice(2).map(distil).filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));

const f = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '--');
console.log(
  ['#', 'gop', 'n', 'segMs', 'segKB', 'total', 'viewer', 'stall', 'seg', 'upl', 'man', 'feed', 'fetch', 'NONSEG'].join('\t'),
);
rows.forEach((r, i) => {
  console.log(
    [
      i + 1, r.gop, r.n, f(r.segMs), f(r.segKB), f(r.totalMs), f(r.viewerMs), r.stalls,
      f(r.segment), f(r.upload), f(r.manifestPublish), f(r.feedPropagation), f(r.fetch), f(r.nonSegment),
    ].join('\t'),
  );
});

console.log('\n--- by GOP, arm order preserved so warm-up stays visible ---');
for (const gop of [...new Set(rows.map((r) => r.gop))].sort((a, b) => a - b)) {
  const g = rows.filter((r) => r.gop === gop);
  console.log(
    `GOP ${gop}: total ${g.map((r) => f(r.totalMs)).join(', ')}` +
      ` | nonSegment ${g.map((r) => f(r.nonSegment)).join(', ')}` +
      ` | segKB ${g.map((r) => f(r.segKB)).join(', ')}` +
      ` | stalls ${g.map((r) => r.stalls).join(', ')}`,
  );
}
