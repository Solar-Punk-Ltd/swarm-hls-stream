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
 * Encoder settings are copied from `e2e/src/bench/wallclockPublisher.ts` so an arm here is comparable
 * to a broadcast arm. See `docs/bench/srs-segment-close-path-2026-08-11.md` for what the source says
 * the answer should be.
 *
 * Usage:
 *   node deploy/scripts/srs-segment-duration.mjs <arms.json> <out.json>
 *
 * where arms.json is [{ "fragment": 1.0, "gop": 1.0 }, ...]
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
const FPS = 30;
const SIZE = '1920x1080';
const BITRATE_KBPS = 6000;
/** Long enough that even a 4s fragment yields a double-figure sample. */
const PUBLISH_SECONDS = 60;
const READY_ATTEMPTS = 40;
const READY_INTERVAL_MS = 500;
/** Our deployment's value. High enough that the absolute-overflow path cannot fire. */
const AOF_RATIO = 10;

const [, , armsPath, outPath] = process.argv;
if (!armsPath || !outPath) {
  throw new Error('usage: srs-segment-duration.mjs <arms.json> <out.json>');
}

function confFor(fragment) {
  return `listen              ${RTMP_PORT};
max_connections     100;
daemon              off;
srs_log_tank        console;

vhost __defaultVhost__ {
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

function encodeArgs(gop) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${SIZE}:rate=${FPS}`,
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
    `${BITRATE_KBPS}k`,
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
    '-t',
    String(PUBLISH_SECONDS),
    '-f',
    'flv',
    `rtmp://127.0.0.1:${RTMP_PORT}/live/t`,
  ];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => (socket.destroy(), resolve(false)));
  });
}

async function waitForRtmp() {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    if (await canConnect(RTMP_PORT)) {
      return;
    }
    await sleep(READY_INTERVAL_MS);
  }
  throw new Error('SRS never accepted RTMP');
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
    await waitForRtmp();
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', encodeArgs(arm.gop), { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      ff.stderr.on('data', (chunk) => (stderr += chunk));
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr}`))));
      ff.on('error', reject);
    });

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
for (const arm of arms) {
  process.stdout.write(`fragment ${arm.fragment} gop ${arm.gop} ... `);
  const result = await measure(arm);
  results.push(result);
  console.log(
    `${result.segments} segments, median ${result.median.toFixed(3)}s, ratio ${result.ratio}x (${result.min}-${
      result.max
    })`,
  );
}

await writeFile(outPath, `${JSON.stringify(results, null, 1)}\n`);
console.log(`\nwritten to ${outPath}`);
