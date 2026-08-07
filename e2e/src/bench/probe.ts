/**
 * Reading a downloaded segment's video timestamps out of ffprobe: when its first frame was shown, and
 * how much media it holds.
 *
 * Split into a spawn and a pure parser because the parser is where this fails silently. ffprobe exits
 * **0** on a segment that holds no video at all and returns empty arrays, so a reader that reaches
 * straight for `packets[0].pts` gets `undefined`, and arithmetic on it yields `NaN` rather than an
 * error. Measured against ffprobe 7.1.1 on an audio-only MPEG-TS: `{"packets":[],"streams":[]}`,
 * exit 0. Every shape below was captured from the real tool, not written from the documentation.
 *
 * The span is measured here rather than read from the manifest's `#EXTINF` because the manifest is
 * the engine's claim about the segment and the packets are the segment. See LAT-9, and
 * `segmentSpan.ts` for the two ways the arithmetic over those packets goes quietly wrong.
 */

import { measureSpanTicks } from '@swarm-hls-stream/shared';
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
    // Every video packet, not just the first. This used to stop at one packet, which is all the
    // capture instant needs, and is why the span had to come from the manifest instead. The cost is
    // bounded by what the bench fetches: segments named in a live manifest, seconds of media each.
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

/** What one downloaded segment's own video packets say about it. */
export interface ProbedSegment {
  /**
   * The earliest frame in presentation order, which is the one the capture instant is recovered from.
   *
   * The earliest rather than the first listed. Those coincide on every segment observed here, because
   * a segment opens on the keyframe that starts its group, but they coincide by a property of how
   * these engines cut segments rather than by anything the container guarantees, and the listing
   * order is decode order.
   */
  firstFrame: FramePts;
  /** Seconds of video it holds, measured from those packets rather than declared by a manifest. */
  mediaSpanS: number;
  /** Seconds the final frame was credited with, which is the resolution `mediaSpanS` is good to. */
  frameDurationS: number;
  /** How many video packets the span was measured across, so a report can say how thin a reading is. */
  videoPacketCount: number;
}

/** Every video packet's presentation timestamp, refusing any that ffprobe could not put a number on. */
function readTimestamps(output: ProbeOutput, source: string): number[] {
  const packets = output.packets ?? [];
  if (packets.length === 0) {
    // The empty-array case, which is what an audio-only segment produces at exit 0.
    fail(source, 'it holds no video packets, so the media never reached the far end even though the fetch succeeded');
  }

  return packets.map(({ pts }) => {
    if (typeof pts !== 'number' || !Number.isFinite(pts)) {
      fail(source, `one of its video packets has no usable timestamp (pts ${JSON.stringify(pts)})`);
    }
    return pts;
  });
}

/**
 * The segment's video timestamps, as `wallclock.ts` and `split.ts` need them.
 *
 * @param json stdout of `ffprobe ${probeArgs(path)}`
 * @param source what to name in an error, normally the segment reference
 */
export function parseProbedSegment(json: string, source: string): ProbedSegment {
  let output: ProbeOutput;
  try {
    output = JSON.parse(json) as ProbeOutput;
  } catch {
    fail(source, `ffprobe wrote ${json.trim() === '' ? 'nothing' : 'output that is not JSON'}`);
  }

  const timestamps = readTimestamps(output, source);

  const timeBase = output.streams?.[0]?.time_base;
  if (typeof timeBase !== 'string') {
    fail(source, 'ffprobe reported no time_base for the video stream, so its ticks have no known rate');
  }
  const rational = TIME_BASE_RE.exec(timeBase);
  if (!rational) {
    fail(source, `time_base "${timeBase}" is not a rational this can read`);
  }
  // time_base is seconds per tick; the caller wants ticks per second.
  const timescale = Number(rational[2]) / Number(rational[1]);
  // Checked on the computed rate rather than on either side of it, because both sides can be zero
  // and they fail differently: `0/90000` gives infinity, `1/0` gives zero, `0/0` gives NaN. Only the
  // first of those is obviously wrong at a glance, and a rate of zero divides a timestamp into a
  // non-finite number that the physical bounds in `wallclock.ts` cannot reject.
  if (!Number.isFinite(timescale) || timescale <= 0) {
    fail(source, `time_base "${timeBase}" gives no usable tick rate, working out to ${timescale} ticks per second`);
  }

  const formatName = output.format?.format_name;
  if (typeof formatName !== 'string') {
    fail(source, 'ffprobe reported no format_name, so whether its timestamps wrap is unknown');
  }

  const span = measureSpanTicks(timestamps, source);

  return {
    firstFrame: {
      timescale,
      pts: Math.min(...timestamps),
      wrapTicks: formatName.split(',').includes(MPEGTS_FORMAT_NAME) ? MPEGTS_WRAP_TICKS : null,
    },
    mediaSpanS: span.total / timescale,
    frameDurationS: span.finalFrame / timescale,
    videoPacketCount: span.packets,
  };
}

/** Probe a segment already on disk. `source` names it in errors, normally the Swarm reference. */
export async function probeSegment(path: string, source: string): Promise<ProbedSegment> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ffprobe', probeArgs(path), { timeout: PROBE_TIMEOUT_MS }));
  } catch (error) {
    // ffprobe exits non-zero on a truncated segment, writing the reason to stderr and `{}` to stdout,
    // so its own words are more useful than the parser's would be.
    const stderr = (error as { stderr?: string }).stderr?.trim();
    fail(source, stderr && stderr !== '' ? stderr : (error as Error).message);
  }
  return parseProbedSegment(stdout, source);
}
