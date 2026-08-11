/**
 * How many frames per second does a publisher recipe actually produce, and does its timestamping
 * record the answer?
 *
 * ⛔ THIS EXISTS BECAUSE #76 COMPARED TWO RECIPES AND REPORTED IT AS TWO HOSTS. The bench publisher
 * stamps both inputs with `-use_wallclock_as_timestamps 1` and carries those stamps through with
 * `-copyts`, so a frame's presentation time is the instant it was demuxed. An encoder that cannot
 * keep up therefore writes its own slowness into the timeline, and a media engine cutting on that
 * timeline emits a longer segment carrying the same bytes. `srs-segment-duration.mjs` used neither
 * option, so it generated an ideal 30 fps timeline no matter how slow the encode really ran, and a
 * starved encoder was invisible to it. That is why three attempts to starve it there changed nothing.
 *
 * ⭐ THE DISCRIMINATING PAIR, and the reason both recipes run here rather than just the bench one:
 *
 * | recipe | encoder at 30 fps | encoder at 15 fps |
 * | --- | --- | --- |
 * | generated stamps | fps 30, speed 1.0x | fps 15, **speed 0.5x** |
 * | wallclock stamps | fps 30, speed 1.0x | fps 15, **speed 1.0x** |
 *
 * Under wallclock stamps a starved encoder still reports realtime, because the timeline stretches to
 * meet it. `speed` alone cannot tell the two columns apart, so **`fps` is the measurement** and speed
 * is only there to show which recipe is being fooled.
 *
 * ⭐ No media engine, no container, no network: an encoder's frame rate is a property of the encoder.
 * Output goes to the null muxer, so this measures encoding and nothing downstream of it.
 *
 * ⛔⛔ WHICH IS WHY THE STAMPED ROWS HERE ARE NOT A CAPABILITY FIGURE, MEASURED 2026-08-12. The
 * `realtime` filter decides how long to sleep from the frame's own presentation time and resets its
 * timer on any gap over its two-second `limit`. An epoch timestamp is always over that limit, so
 * under wallclock stamping the filter stops pacing and the encode runs flat out: the 720p arm
 * reported **882 fps**, which is the absence of a brake rather than the presence of speed. In a real
 * publish the SRT socket supplies the pacing this sink does not, so a stamped arm has to go through
 * a media engine to mean anything. `srs-segment-duration.mjs` is where that lives.
 *
 * ⭐ The unstamped rows are unaffected and are the reason to keep this: they say what the encoder can
 * do when something is pacing it, which is the number the stamped path needs to be judged against.
 *
 * Arms alternate within the sitting rather than running one recipe then the other, because thermal
 * state and whatever else shares the machine both drift over a sitting. See the gate lessons, AGS.
 *
 * Usage:
 *   node deploy/scripts/encoder-capability.mjs <arms.json> <out.json>
 *
 * where arms.json is [{ "recipe": "bench", "size": "1920x1080", "bitrateKbps": 6000, "fps": 30 }, ...]
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

/** Long enough for the reported rate to settle past the encoder's own startup. */
const MEASURE_SECONDS = 60;
/** Grace beyond the measurement window before the process is taken down. */
const KILL_GRACE_MS = 3000;
const ROUNDS = 2;

const RECIPE_WALLCLOCK = 'bench';
const RECIPE_GENERATED = 'probe';

const [, , armsPath, outPath] = process.argv;
if (!armsPath || !outPath) {
  throw new Error('usage: encoder-capability.mjs <arms.json> <out.json>');
}

/**
 * @typedef {{ recipe: string, size: string, bitrateKbps: number, fps: number, gopSeconds: number }} Arm
 * @typedef {{ arm: Arm, round: number, fps: number, speed: number, frames: number, mediaSeconds: number,
 *             wallSeconds: number }} Sample
 */

/**
 * The two recipes, differing only in whether presentation times come from the wall clock.
 *
 * Everything else is copied from `e2e/src/bench/wallclockPublisher.ts` so the bench arm here is the
 * encode the bench actually runs. `-t` is deliberately absent: it is measured against output
 * timestamps, and under `-copyts` those are epoch values, so a duration limit either never fires or
 * fires at once. The caller stops the process on the wall clock instead.
 */
function recipeArgs(arm) {
  const stamped = arm.recipe === RECIPE_WALLCLOCK;
  const stampInput = stamped ? ['-use_wallclock_as_timestamps', '1'] : [];
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-stats',
    ...stampInput,
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${arm.size}:rate=${arm.fps}`,
    ...stampInput,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-vf',
    'realtime',
    '-af',
    'arealtime',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    '-b:v',
    `${arm.bitrateKbps}k`,
    '-g',
    String(Math.round(arm.fps * arm.gopSeconds)),
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-b:a',
    '128k',
    ...(stamped ? ['-copyts'] : []),
    '-f',
    'null',
    '-',
  ];
}

/** ffmpeg rewrites its progress line in place with carriage returns, so the last one wins. */
function lastProgress(stderr) {
  const lines = stderr.split(/[\r\n]+/).filter((line) => line.includes('frame='));
  const last = lines.at(-1) ?? '';
  const read = (pattern) => Number((last.match(pattern) ?? [])[1] ?? NaN);
  return {
    frames: read(/frame=\s*(\d+)/),
    fps: read(/fps=\s*([\d.]+)/),
    speed: read(/speed=\s*([\d.]+)x/),
    mediaSeconds: (() => {
      const stamp = last.match(/time=\s*(-?)(\d+):(\d+):([\d.]+)/);
      if (!stamp) {
        return NaN;
      }
      const [, sign, hours, minutes, seconds] = stamp;
      const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
      return sign === '-' ? -total : total;
    })(),
  };
}

async function measure(arm, round) {
  const startedAt = process.hrtime.bigint();
  const stderr = await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', recipeArgs(arm), { stdio: ['ignore', 'ignore', 'pipe'] });
    let captured = '';
    ff.stderr.on('data', (chunk) => (captured += chunk));
    const stop = setTimeout(() => ff.kill('SIGINT'), MEASURE_SECONDS * 1000);
    const abandon = setTimeout(() => ff.kill('SIGKILL'), MEASURE_SECONDS * 1000 + KILL_GRACE_MS);
    ff.on('close', () => (clearTimeout(stop), clearTimeout(abandon), resolve(captured)));
    ff.on('error', reject);
  });
  const wallSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  return { arm, round, wallSeconds: Number(wallSeconds.toFixed(2)), ...lastProgress(stderr) };
}

const arms = JSON.parse(await readFile(armsPath, 'utf-8'));
/** @type {Sample[]} */
const samples = [];

console.log('  recipe    size          kbps   round   frames     fps   speed   media/wall');
for (let round = 0; round < ROUNDS; round++) {
  // Rotated so no recipe keeps the cold-machine slot, and so the pair is never separated by more
  // than one arm's worth of drift.
  const order = arms.map((_, i) => arms[(i + round) % arms.length]);
  for (const arm of order) {
    const sample = await measure(arm, round);
    samples.push(sample);
    console.log(
      `  ${arm.recipe.padEnd(10)}${arm.size.padEnd(12)}${String(arm.bitrateKbps).padStart(6)}` +
        `${String(round).padStart(8)}${String(sample.frames).padStart(9)}` +
        `${sample.fps.toFixed(1).padStart(8)}${sample.speed.toFixed(3).padStart(8)}x` +
        `${(sample.mediaSeconds / sample.wallSeconds).toFixed(3).padStart(13)}`,
    );
  }
}

await writeFile(outPath, `${JSON.stringify(samples, null, 1)}\n`);

console.log('\n  recipe    size          kbps   meanFps   requested   ratio');
const seen = new Set();
for (const arm of arms) {
  const key = `${arm.recipe}|${arm.size}|${arm.bitrateKbps}`;
  if (seen.has(key)) {
    continue;
  }
  seen.add(key);
  const mine = samples.filter(
    (s) => s.arm.recipe === arm.recipe && s.arm.size === arm.size && s.arm.bitrateKbps === arm.bitrateKbps,
  );
  const meanFps = mine.reduce((sum, s) => sum + s.fps, 0) / mine.length;
  console.log(
    `  ${arm.recipe.padEnd(10)}${arm.size.padEnd(12)}${String(arm.bitrateKbps).padStart(6)}` +
      `${meanFps.toFixed(1).padStart(10)}${String(arm.fps).padStart(12)}${(meanFps / arm.fps).toFixed(3).padStart(8)}`,
  );
}
console.log(`\n  written to ${outPath}`);
