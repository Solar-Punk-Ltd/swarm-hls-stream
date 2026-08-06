/**
 * Throwaway: does a published playlist's `#EXTINF` now match the media in the segments it names?
 *
 * Runs the shipped readers against a real recording, so it also checks that what went into the
 * uploader works on bytes a real encoder produced rather than only on the ones a test builds.
 * Delete after use.
 */
import { measureSpanTicks } from './src/segmentSpan.js';
import { readVideoPts, TS_TIMESCALE_HZ } from './src/mpegTs.js';

const GATEWAY = process.env.GATEWAY ?? 'http://49.12.149.62:10077';
const [manifestUrl, take] = [process.argv[2], Number(process.argv[3] ?? 12)];

async function main(): Promise<void> {
  const manifest = await (await fetch(manifestUrl)).text();
  const lines = manifest.split('\n').map((line) => line.trim());

  const segments: { declared: number; url: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXTINF:')) {
      segments.push({ declared: Number.parseFloat(lines[i].slice(8)), url: lines[i + 1] });
    }
  }
  const declaredTotal = segments.reduce((sum, s) => sum + s.declared, 0);
  console.log(`gateway ${GATEWAY}`);
  console.log(`playlist: ${segments.length} segments, #EXTINF total ${declaredTotal.toFixed(3)}s\n`);
  console.log('idx | declared | measured | difference');
  console.log('----+----------+----------+-----------');

  let worst = 0;
  for (let i = 0; i < Math.min(take, segments.length); i++) {
    const bytes = new Uint8Array(await (await fetch(segments[i].url)).arrayBuffer());
    const span = measureSpanTicks(readVideoPts(bytes), segments[i].url);
    const measured = span.total / TS_TIMESCALE_HZ;
    const difference = segments[i].declared - measured;
    worst = Math.max(worst, Math.abs(difference));
    console.log(
      `${String(i).padStart(3)} | ${segments[i].declared.toFixed(6).padStart(8)} | ` +
        `${measured.toFixed(6).padStart(8)} | ${difference.toFixed(6).padStart(10)}`,
    );
  }

  console.log(`\nworst disagreement over ${Math.min(take, segments.length)} segments: ${worst.toFixed(6)}s`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
