/**
 * Reading the first video frame's presentation timestamp out of a downloaded segment, via ffprobe.
 *
 * Split into a spawn and a pure parser because the parser is where this fails silently. ffprobe exits
 * **0** on a segment that holds no video at all and returns empty arrays, so a reader that reaches
 * straight for `packets[0].pts` gets `undefined`, and arithmetic on it yields `NaN` rather than an
 * error. Measured against ffprobe 7.1.1 on an audio-only MPEG-TS: `{"packets":[],"streams":[]}`,
 * exit 0. Every shape below was captured from the real tool, not written from the documentation.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { type FramePts, MPEGTS_WRAP_TICKS } from './wallclock.js';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 20_000;

/**
 * `format_name` is a comma-separated list of every format the demuxer answers to, so MP4 reports
 * `mov,mp4,m4a,3gp,3g2,mj2`. Only MPEG-TS truncates timestamps to 33 bits, so only it wraps.
 *
 * Read as a list rather than compared whole, which is what the field is, though only the MP4 side is
 * observed as one here: MPEG-TS reports the bare `mpegts`, so nothing in the tests exercises the
 * split and an equality check would pass them all. Kept as a list read because that is the field's
 * definition, and because the failure direction is safe either way — a container mistaken for
 * non-wrapping produces a timestamp the bounds in `wallclock.ts` reject out loud.
 */
const MPEGTS_FORMAT_NAME = 'mpegts';

/** `time_base` as ffprobe writes it: seconds per tick, as an exact rational. */
const TIME_BASE_RE = /^(\d+)\/(\d+)$/;

/** The one ffprobe invocation this module makes, kept next to the parser written against its output. */
export function probeArgs(path: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    // Decode only as far as the first packet. A live segment is small, but a VOD manifest's is not.
    '-read_intervals',
    '%+#1',
    '-show_entries',
    'packet=pts',
    '-show_entries',
    'stream=time_base',
    '-show_entries',
    'format=format_name',
    '-of',
    'json',
    path,
  ];
}

interface ProbeOutput {
  packets?: { pts?: unknown }[];
  streams?: { time_base?: unknown }[];
  format?: { format_name?: unknown };
}

function fail(source: string, why: string): never {
  throw new Error(`cannot read a presentation timestamp from ${source}: ${why}`);
}

/**
 * The segment's first video frame, as `wallclock.ts` needs it.
 *
 * @param json stdout of `ffprobe ${probeArgs(path)}`
 * @param source what to name in an error, normally the segment reference
 */
export function parseProbedFrame(json: string, source: string): FramePts {
  let output: ProbeOutput;
  try {
    output = JSON.parse(json) as ProbeOutput;
  } catch {
    fail(source, `ffprobe wrote ${json.trim() === '' ? 'nothing' : 'output that is not JSON'}`);
  }

  const pts = output.packets?.[0]?.pts;
  if (typeof pts !== 'number' || !Number.isFinite(pts)) {
    // Also the empty-array case, which is what an audio-only segment produces at exit 0.
    fail(
      source,
      pts === undefined
        ? 'it holds no video packets, so the media never reached the far end even though the fetch succeeded'
        : `its first video packet has no usable timestamp (pts ${JSON.stringify(pts)})`,
    );
  }

  const timeBase = output.streams?.[0]?.time_base;
  if (typeof timeBase !== 'string') {
    fail(source, 'ffprobe reported no time_base for the video stream, so its ticks have no known rate');
  }
  const rational = TIME_BASE_RE.exec(timeBase);
  if (!rational) {
    fail(source, `time_base "${timeBase}" is not a rational this can read`);
  }
  const numerator = Number(rational[1]);
  const denominator = Number(rational[2]);
  if (numerator === 0) {
    fail(source, `time_base "${timeBase}" has a zero numerator, so the tick rate is undefined`);
  }

  const formatName = output.format?.format_name;
  if (typeof formatName !== 'string') {
    fail(source, 'ffprobe reported no format_name, so whether its timestamps wrap is unknown');
  }

  return {
    // time_base is seconds per tick; the caller wants ticks per second.
    timescale: denominator / numerator,
    pts,
    wrapTicks: formatName.split(',').includes(MPEGTS_FORMAT_NAME) ? MPEGTS_WRAP_TICKS : null,
  };
}

/** Probe a segment already on disk. `source` names it in errors, normally the Swarm reference. */
export async function probeFirstVideoFrame(path: string, source: string): Promise<FramePts> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ffprobe', probeArgs(path), { timeout: PROBE_TIMEOUT_MS }));
  } catch (error) {
    // ffprobe exits non-zero on a truncated segment, writing the reason to stderr and `{}` to stdout,
    // so its own words are more useful than the parser's would be.
    const stderr = (error as { stderr?: string }).stderr?.trim();
    fail(source, stderr && stderr !== '' ? stderr : (error as Error).message);
  }
  return parseProbedFrame(stdout, source);
}
