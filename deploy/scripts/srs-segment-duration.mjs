/**
 * Measures the segment duration SRS actually publishes for a given `hls_fragment` and GOP.
 *
 * ⭐ THIS COSTS NOTHING. The BZZ in a fragment sweep is spent by the uploader putting segments on
 * Swarm, and this question lives entirely inside SRS: publish, then read `#EXTINF` out of the m3u8.
 * No bee, no uploader, no postage. Four arms cost what four arms of ffmpeg cost.
 *
 * ⭐ It runs a MINIMAL config against the stock `ossrs/srs:6` image rather than our own entrypoint, so
 * a reproduction here implicates SRS and a non-reproduction implicates our template. Those are
 * different bugs and the instrument should not blur them.
 *
 * ⛔ The playlist is read off a mounted directory, not over SRS's HTTP server. Two earlier attempts
 * returned zero segments: SRS removes the published tree when the stream unpublishes, and its
 * `-> HLS ... dur=` log line is a periodic summary rather than one entry per segment, so neither an
 * after-the-fact fetch nor a log scrape sees the series.
 *
 * ⛔⛔ THE FIRST VERSION OF THIS FILE CLAIMED TO COPY THE BENCH PUBLISHER AND DID NOT. It left out
 * `-use_wallclock_as_timestamps 1` and `-copyts`, which is the difference between a timeline the
 * encoder invents and one that records when each frame was really made. Under the invented timeline a
 * starved encoder still yields segments exactly `hls_fragment` long, so the six arms that all landed
 * on the knob were measuring a recipe the deployment does not publish with. The `recipe` dimension
 * exists so both timelines run in the same sitting and the difference is a column rather than a
 * comparison across two documents. See `encoder-capability.mjs` for the frame rate underneath it.
 *
 * ⛔ Wallclock stamps are epoch values, which a 32-bit RTMP timestamp cannot carry, so the stamped
 * recipes publish MPEG-TS over SRT exactly as the bench does. Transport is therefore confounded with
 * stamping across those two, which is what `bench-nostamp` is for: SRT and MPEG-TS with an invented
 * timeline, so the two factors separate.
 *
 * Encoder settings are copied from `e2e/src/bench/wallclockPublisher.ts` so an arm here is comparable
 * to a broadcast arm. See `docs/bench/srs-segment-close-path-2026-08-11.md` for what the source says
 * the answer should be.
 *
 * Usage:
 *   node deploy/scripts/srs-segment-duration.mjs <arms.json> <out.json>
 *
 * where arms.json is [{ "fragment": 1.0, "gop": 1.0, "recipe": "bench", "size": "1920x1080",
 * "bitrateKbps": 6000 }, ...] and `recipe` is one of `probe`, `bench` or `bench-nostamp`.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const IMAGE = 'ossrs/srs:6';
const CONTAINER = 'srs-fragment-probe';
const RTMP_PORT = 11935;
const SRT_PORT = 11936;
const FPS = 30;
const DEFAULT_SIZE = '1920x1080';
const DEFAULT_BITRATE_KBPS = 6000;
/** Long enough that even a 4s fragment yields a double-figure sample. */
const PUBLISH_SECONDS = 60;
const READY_ATTEMPTS = 40;
const READY_INTERVAL_MS = 500;
/** Our deployment's value. High enough that the absolute-overflow path cannot fire. */
const AOF_RATIO = 10;
/** Held at 200 throughout the bench profiles, so the SRT arms carry the deployment's own buffering. */
const SRT_LATENCY_MS = 200;

const RECIPE_STAMPED = 'bench';
const RECIPE_SRT_UNSTAMPED = 'bench-nostamp';

const [, , armsPath, outPath] = process.argv;
if (!armsPath || !outPath) {
  throw new Error('usage: srs-segment-duration.mjs <arms.json> <out.json>');
}

function confFor(fragment) {
  return `listen              ${RTMP_PORT};
max_connections     100;
daemon              off;
srs_log_tank        console;

srt_server {
    enabled         on;
    listen          ${SRT_PORT};
    latency         ${SRT_LATENCY_MS};
    tlpktdrop       on;
    tsbpdmode       on;
}

vhost __defaultVhost__ {
    srt {
        enabled     on;
    }

    hls {
        enabled         on;
        hls_fragment    ${fragment};
        hls_aof_ratio   ${AOF_RATIO};
        hls_window      600;
        hls_cleanup     off;
        hls_dispose     0;
        hls_path        /hls;
        hls_m3u8_file   [app]/[stream].m3u8;
        hls_ts_file     [app]/[stream]-[seq].ts;
    }
}
`;
}

/**
 * Where an arm publishes, and how its frames are timestamped.
 *
 * The stamped recipe is the bench publisher's, verbatim. The other two invent a timeline, and differ
 * from each other only in transport, so `bench` against `bench-nostamp` isolates the stamping and
 * `bench-nostamp` against `probe` isolates SRT and MPEG-TS.
 */
function outputArgs(recipe) {
  return recipe === 'probe'
    ? ['-f', 'flv', `rtmp://127.0.0.1:${RTMP_PORT}/live/t`]
    : ['-f', 'mpegts', `srt://127.0.0.1:${SRT_PORT}?streamid=#!::r=live/t,m=publish`];
}

function encodeArgs(arm) {
  const gop = arm.gop;
  const size = arm.size ?? DEFAULT_SIZE;
  const bitrateKbps = arm.bitrateKbps ?? DEFAULT_BITRATE_KBPS;
  const stamped = arm.recipe === RECIPE_STAMPED;
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
    `testsrc2=size=${size}:rate=${FPS}`,
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
    `${bitrateKbps}k`,
    '-g',
    String(Math.round(FPS * gop)),
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
    // ⛔ `-t` is measured against output timestamps, and under `-copyts` those are epoch values, so a
    // duration limit on a stamped arm either never fires or fires at once. Those arms are stopped on
    // the wall clock instead, which is what `runPublisher` does for every arm so the two paths differ
    // in one thing only.
    ...(stamped ? ['-copyts'] : ['-t', String(PUBLISH_SECONDS)]),
    ...outputArgs(arm.recipe),
  ];
}

/** The last progress line ffmpeg rewrote, which is where the achieved frame rate is legible. */
function lastProgress(stderr) {
  const line =
    stderr
      .split(/[\r\n]+/)
      .filter((entry) => entry.includes('frame='))
      .at(-1) ?? '';
  const read = (pattern) => Number((line.match(pattern) ?? [])[1] ?? NaN);
  return { frames: read(/frame=\s*(\d+)/), fps: read(/fps=\s*([\d.]+)/), speed: read(/speed=\s*([\d.]+)x/) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => (socket.destroy(), resolve(false)));
  });
}

/**
 * RTMP readiness stands in for SRT readiness too, because SRT is UDP and has nothing to connect to.
 * Both listeners come up from the same config load, so the TCP one answering means the process is
 * past its startup.
 */
async function waitForSrs() {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    if (await canConnect(RTMP_PORT)) {
      return;
    }
    await sleep(READY_INTERVAL_MS);
  }
  throw new Error('SRS never accepted RTMP');
}

/**
 * Publish for {@link PUBLISH_SECONDS} of wall clock and return what ffmpeg reported achieving.
 *
 * Stopped here rather than by `-t` so a stamped arm and an unstamped one get the same window. An arm
 * ended by SIGINT exits non-zero by design, so only a failure to produce any progress line at all is
 * treated as an error.
 */
async function runPublisher(arm) {
  const stderr = await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', encodeArgs(arm), { stdio: ['ignore', 'ignore', 'pipe'] });
    let captured = '';
    ff.stderr.on('data', (chunk) => (captured += chunk));
    const stop = setTimeout(() => ff.kill('SIGINT'), PUBLISH_SECONDS * 1000);
    ff.on('close', () => (clearTimeout(stop), resolve(captured)));
    ff.on('error', reject);
  });
  const progress = lastProgress(stderr);
  if (!Number.isFinite(progress.frames)) {
    throw new Error(`ffmpeg produced no progress line: ${stderr.slice(-400)}`);
  }
  return progress;
}

function extinfDurations(playlist) {
  return [...playlist.matchAll(/#EXTINF:([0-9.]+)/g)].map((m) => Number(m[1]));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function stopProbe() {
  await run('docker', ['rm', '-f', CONTAINER]).catch(() => {});
}

async function measure(arm) {
  const dir = await mkdtemp(join(tmpdir(), 'srs-frag-'));
  const confPath = join(dir, 'probe.conf');
  const hlsDir = join(dir, 'hls');
  await writeFile(confPath, confFor(arm.fragment));
  await run('mkdir', ['-p', hlsDir]);

  await stopProbe();
  await run('docker', [
    'run',
    '--rm',
    '-d',
    '--name',
    CONTAINER,
    '-p',
    `${RTMP_PORT}:${RTMP_PORT}`,
    '-p',
    `${SRT_PORT}:${SRT_PORT}/udp`,
    '-v',
    `${confPath}:/usr/local/srs/conf/probe.conf:ro`,
    '-v',
    `${hlsDir}:/hls`,
    IMAGE,
    './objs/srs',
    '-c',
    'conf/probe.conf',
  ]);

  try {
    await waitForSrs();
    const progress = await runPublisher(arm);

    const playlist = await readFile(join(hlsDir, 'live', 't.m3u8'), 'utf-8');
    const durations = extinfDurations(playlist);
    if (durations.length < 5) {
      throw new Error(`only ${durations.length} segments, not enough to read a median`);
    }
    // The first segment carries the encoder's startup and the last is cut short by unpublish, so
    // both are artefacts of the sitting rather than of the configuration under test.
    const interior = durations.slice(1, -1);
    return {
      ...arm,
      ...progress,
      segments: durations.length,
      median: median(interior),
      min: Math.min(...interior),
      max: Math.max(...interior),
      ratio: Number((median(interior) / arm.fragment).toFixed(3)),
      durations,
    };
  } finally {
    await stopProbe();
    await rm(dir, { recursive: true, force: true });
  }
}

const arms = JSON.parse(await readFile(armsPath, 'utf-8'));
const results = [];
console.log('  recipe         frag   gop   size          fps   segments   median   ratio   min-max');
for (const arm of arms) {
  const result = await measure({ recipe: 'probe', size: DEFAULT_SIZE, ...arm });
  results.push(result);
  console.log(
    `  ${result.recipe.padEnd(15)}${String(result.fragment).padStart(4)}${String(result.gop).padStart(6)}` +
      `   ${result.size.padEnd(12)}${result.fps.toFixed(1).padStart(6)}${String(result.segments).padStart(11)}` +
      `${result.median.toFixed(3).padStart(9)}s${result.ratio.toFixed(2).padStart(8)}x` +
      `   ${result.min}-${result.max}`,
  );
}

await writeFile(outPath, `${JSON.stringify(results, null, 1)}\n`);
console.log(`\nwritten to ${outPath}`);
