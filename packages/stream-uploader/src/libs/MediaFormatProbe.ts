import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

export interface VideoFormatTrack {
  readonly kind: 'video';
  readonly codec: string;
  readonly profile: string | null;
  readonly level: number | null;
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: string;
  readonly chromaLocation: string | null;
  readonly bitsPerRawSample: number | null;
}

export interface AudioFormatTrack {
  readonly kind: 'audio';
  readonly codec: string;
  readonly profile: string | null;
  readonly sampleRate: number;
  readonly channels: number;
  readonly channelLayout: string;
}

export type MediaFormatTrack = VideoFormatTrack | AudioFormatTrack;

export interface MediaFormatFingerprint {
  readonly version: 1;
  readonly container: 'mpegts';
  readonly tracks: readonly MediaFormatTrack[];
}

export type MediaFormatProbeResult =
  | { readonly kind: 'valid'; readonly fingerprint: MediaFormatFingerprint }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface MediaFormatProbeOptions {
  readonly executable?: string;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
}

export interface MediaFormatInspector {
  inspect(data: Buffer): Promise<MediaFormatProbeResult>;
}

interface FfprobeStream {
  codec_type?: unknown;
  codec_name?: unknown;
  profile?: unknown;
  level?: unknown;
  width?: unknown;
  height?: unknown;
  pix_fmt?: unknown;
  chroma_location?: unknown;
  bits_per_raw_sample?: unknown;
  sample_rate?: unknown;
  channels?: unknown;
  channel_layout?: unknown;
}

const DEFAULT_MAX_INPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONCURRENT = 2;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value !== 'unknown' && value !== 'N/A' ? value : null;
}

function nullableString(value: unknown): string | null {
  return value === undefined || value === null || value === 'unknown' ? null : nonEmptyString(value);
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) && Number(parsed) > 0 ? Number(parsed) : null;
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === 'N/A' || value === 'unknown') {
    return null;
  }
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) && Number(parsed) >= 0 ? Number(parsed) : null;
}

function canonicalTrackKey(track: MediaFormatTrack): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(track).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function normalizeFingerprint(fingerprint: MediaFormatFingerprint): MediaFormatFingerprint | null {
  return mediaFormatFingerprintFromFfprobe({
    streams: fingerprint.tracks.map((track) =>
      track.kind === 'video'
        ? {
            codec_type: 'video',
            codec_name: track.codec,
            profile: track.profile,
            level: track.level,
            width: track.width,
            height: track.height,
            pix_fmt: track.pixelFormat,
            chroma_location: track.chromaLocation,
            bits_per_raw_sample: track.bitsPerRawSample,
          }
        : {
            codec_type: 'audio',
            codec_name: track.codec,
            profile: track.profile,
            sample_rate: track.sampleRate,
            channels: track.channels,
            channel_layout: track.channelLayout,
          },
    ),
  });
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isMediaFormatFingerprint(value: unknown): value is MediaFormatFingerprint {
  if (!value || typeof value !== 'object') {return false;}
  const fingerprint = value as Partial<MediaFormatFingerprint>;
  if (
    !hasExactKeys(value, ['version', 'container', 'tracks']) ||
    fingerprint.version !== 1 ||
    fingerprint.container !== 'mpegts' ||
    !Array.isArray(fingerprint.tracks)
  ) {
    return false;
  }
  for (const track of fingerprint.tracks) {
    if (!track || typeof track !== 'object' || !('kind' in track)) {return false;}
    const exact =
      track.kind === 'video'
        ? hasExactKeys(track, [
            'kind',
            'codec',
            'profile',
            'level',
            'width',
            'height',
            'pixelFormat',
            'chromaLocation',
            'bitsPerRawSample',
          ])
        : track.kind === 'audio'
          ? hasExactKeys(track, ['kind', 'codec', 'profile', 'sampleRate', 'channels', 'channelLayout'])
          : false;
    if (!exact) {return false;}
  }
  const normalized = normalizeFingerprint(fingerprint as MediaFormatFingerprint);
  return normalized !== null;
}

export function sameMediaFormatFingerprint(
  left: MediaFormatFingerprint,
  right: MediaFormatFingerprint,
): boolean {
  const normalizedLeft = normalizeFingerprint(left);
  const normalizedRight = normalizeFingerprint(right);
  return (
    normalizedLeft !== null &&
    normalizedRight !== null &&
    JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight)
  );
}

/** Normalize ffprobe's loose JSON into the exact compatibility fields persisted by managed runs. */
export function mediaFormatFingerprintFromFfprobe(value: unknown): MediaFormatFingerprint | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { streams?: unknown }).streams)) {
    return null;
  }
  const tracks: MediaFormatTrack[] = [];
  for (const raw of (value as { streams: FfprobeStream[] }).streams) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const codec = nonEmptyString(raw.codec_name);
    if (raw.codec_type === 'video') {
      const width = positiveInteger(raw.width);
      const height = positiveInteger(raw.height);
      const pixelFormat = nonEmptyString(raw.pix_fmt);
      if (!codec || width === null || height === null || !pixelFormat) {
        return null;
      }
      tracks.push({
        kind: 'video',
        codec,
        profile: nullableString(raw.profile),
        level: nullableNonNegativeInteger(raw.level),
        width,
        height,
        pixelFormat,
        chromaLocation: nullableString(raw.chroma_location),
        bitsPerRawSample: nullableNonNegativeInteger(raw.bits_per_raw_sample),
      });
    } else if (raw.codec_type === 'audio') {
      const sampleRate = positiveInteger(raw.sample_rate);
      const channels = positiveInteger(raw.channels);
      const channelLayout = nonEmptyString(raw.channel_layout);
      if (!codec || sampleRate === null || channels === null || !channelLayout) {
        return null;
      }
      tracks.push({
        kind: 'audio',
        codec,
        profile: nullableString(raw.profile),
        sampleRate,
        channels,
        channelLayout,
      });
    }
  }
  if (tracks.length === 0) {
    return null;
  }
  tracks.sort((left, right) => {
    const kindOrder = left.kind.localeCompare(right.kind);
    if (kindOrder !== 0) {return kindOrder;}
    const leftKey = canonicalTrackKey(left);
    const rightKey = canonicalTrackKey(right);
    return leftKey.localeCompare(rightKey);
  });
  return { version: 1, container: 'mpegts', tracks };
}

/** Bounded ffprobe subprocess pool. Input is fixed to MPEG-TS on stdin and no network protocol is allowed. */
export class MediaFormatProbe {
  private readonly executable: string;
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private active = 0;

  constructor(options: MediaFormatProbeOptions = {}) {
    this.executable = options.executable ?? '/usr/bin/ffprobe';
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (
      !Number.isSafeInteger(this.maxInputBytes) ||
      this.maxInputBytes <= 0 ||
      !Number.isSafeInteger(this.maxOutputBytes) ||
      this.maxOutputBytes <= 0 ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      !Number.isSafeInteger(this.maxConcurrent) ||
      this.maxConcurrent <= 0
    ) {
      throw new Error('Media format probe bounds must be positive integers');
    }
  }

  public async inspect(data: Buffer): Promise<MediaFormatProbeResult> {
    if (data.length === 0 || data.length > this.maxInputBytes) {
      return { kind: 'failed', reason: 'input_limit' };
    }
    if (this.active >= this.maxConcurrent) {
      return { kind: 'busy' };
    }
    this.active++;
    try {
      return await this.run(data);
    } finally {
      this.active--;
    }
  }

  private run(data: Buffer): Promise<MediaFormatProbeResult> {
    return new Promise((resolve) => {
      let settled = false;
      let terminalFailure: string | undefined;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      const child = spawn(
        this.executable,
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'pipe',
          '-f',
          'mpegts',
          '-show_entries',
          'stream=codec_type,codec_name,profile,level,width,height,pix_fmt,chroma_location,bits_per_raw_sample,sample_rate,channels,channel_layout',
          '-of',
          'json',
          'pipe:0',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      ) as ChildProcessWithoutNullStreams;
      const finish = (result: MediaFormatProbeResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const append = (current: Buffer, chunk: Buffer): Buffer | null => {
        if (current.length + chunk.length > this.maxOutputBytes) {
          terminalFailure ??= 'output_limit';
          child.kill('SIGKILL');
          return null;
        }
        return Buffer.concat([current, chunk]);
      };
      const timer = setTimeout(() => {
        terminalFailure ??= 'timeout';
        child.kill('SIGKILL');
      }, this.timeoutMs);
      timer.unref();
      child.stdout.on('data', (chunk: Buffer) => {
        const next = append(stdout, chunk);
        if (next) {stdout = next;}
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const next = append(stderr, chunk);
        if (next) {stderr = next;}
      });
      child.on('error', (error) => finish({ kind: 'failed', reason: `spawn:${error.message}` }));
      child.on('close', (code) => {
        if (settled) {return;}
        if (terminalFailure) {
          finish({ kind: 'failed', reason: terminalFailure });
          return;
        }
        if (code !== 0) {
          finish({ kind: 'incomplete' });
          return;
        }
        try {
          const fingerprint = mediaFormatFingerprintFromFfprobe(JSON.parse(stdout.toString('utf8')));
          finish(fingerprint ? { kind: 'valid', fingerprint } : { kind: 'incomplete' });
        } catch {
          finish({ kind: 'failed', reason: 'invalid_json' });
        }
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(data);
    });
  }
}
