import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  mediaFormatFingerprintFromFfprobe,
  MediaFormatProbe,
} from '../src/libs/MediaFormatProbe.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function executable(body: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'media-format-probe-'));
  temporaryDirectories.push(directory);
  const target = path.join(directory, 'ffprobe');
  fs.writeFileSync(target, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return target;
}

describe('MediaFormatProbe', () => {
  it('normalizes and canonically orders supported audio and video tracks', () => {
    const fingerprint = mediaFormatFingerprintFromFfprobe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'hevc',
          profile: 'Main 10',
          level: 120,
          width: 1920,
          height: 1080,
          pix_fmt: 'yuv420p10le',
          chroma_location: 'left',
          bits_per_raw_sample: '10',
        },
        {
          codec_type: 'audio',
          codec_name: 'aac',
          profile: 'LC',
          sample_rate: '48000',
          channels: 2,
          channel_layout: 'stereo',
        },
      ],
    });

    assert.deepEqual(fingerprint, {
      version: 1,
      container: 'mpegts',
      tracks: [
        {
          kind: 'audio',
          codec: 'aac',
          profile: 'LC',
          sampleRate: 48_000,
          channels: 2,
          channelLayout: 'stereo',
        },
        {
          kind: 'video',
          codec: 'hevc',
          profile: 'Main 10',
          level: 120,
          width: 1920,
          height: 1080,
          pixelFormat: 'yuv420p10le',
          chromaLocation: 'left',
          bitsPerRawSample: 10,
        },
      ],
    });
  });

  it('supports audio-only MP3 and preserves duplicate track multiplicity', () => {
    const audio = {
      codec_type: 'audio',
      codec_name: 'mp3',
      profile: 'unknown',
      sample_rate: '44100',
      channels: 1,
      channel_layout: 'mono',
    };
    const fingerprint = mediaFormatFingerprintFromFfprobe({ streams: [audio, audio] });

    assert.equal(fingerprint?.tracks.length, 2);
    assert.deepEqual(fingerprint?.tracks[0], {
      kind: 'audio',
      codec: 'mp3',
      profile: null,
      sampleRate: 44_100,
      channels: 1,
      channelLayout: 'mono',
    });
  });

  it('refuses missing compatibility fields instead of guessing them', () => {
    assert.equal(
      mediaFormatFingerprintFromFfprobe({
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }],
      }),
      null,
    );
    assert.equal(
      mediaFormatFingerprintFromFfprobe({
        streams: [{ codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }],
      }),
      null,
    );
    assert.equal(
      mediaFormatFingerprintFromFfprobe({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1280,
            height: 720,
            pix_fmt: 'unknown',
          },
        ],
      }),
      null,
    );
    assert.equal(
      mediaFormatFingerprintFromFfprobe({
        streams: [
          {
            codec_type: 'audio',
            codec_name: 'aac',
            sample_rate: '48000',
            channels: 2,
            channel_layout: 'N/A',
          },
        ],
      }),
      null,
    );
  });

  it('passes bytes only on stdin with the fixed MPEG-TS and pipe protocol arguments', async () => {
    const probe = new MediaFormatProbe({
      executable: executable(`
args="$*"
case "$args" in
  *"-protocol_whitelist pipe -f mpegts"*) ;;
  *) exit 2 ;;
esac
cat >/dev/null
printf '%s' '{"streams":[{"codec_type":"audio","codec_name":"aac","profile":"LC","sample_rate":"48000","channels":2,"channel_layout":"stereo"}]}'
      `),
    });

    assert.equal((await probe.inspect(Buffer.from('mpeg-ts'))).kind, 'valid');
  });

  it('bounds input, output and execution time', async () => {
    const inputBound = new MediaFormatProbe({ executable: executable('exit 0'), maxInputBytes: 3 });
    assert.deepEqual(await inputBound.inspect(Buffer.from('four')), { kind: 'failed', reason: 'input_limit' });

    const outputBound = new MediaFormatProbe({ executable: executable("printf '12345'"), maxOutputBytes: 4 });
    assert.deepEqual(await outputBound.inspect(Buffer.from('x')), { kind: 'failed', reason: 'output_limit' });

    const timeoutBound = new MediaFormatProbe({ executable: executable('sleep 1'), timeoutMs: 20 });
    assert.deepEqual(await timeoutBound.inspect(Buffer.from('x')), { kind: 'failed', reason: 'timeout' });

  });

  it('refuses excess work without retaining queued input buffers', async () => {
    const probe = new MediaFormatProbe({
      executable: executable(`
sleep 0.1
printf '%s' '{"streams":[{"codec_type":"audio","codec_name":"aac","profile":"LC","sample_rate":"48000","channels":2,"channel_layout":"stereo"}]}'
      `),
      maxConcurrent: 1,
    });
    const first = probe.inspect(Buffer.from('a'));
    const refused = await Promise.all(Array.from({ length: 20 }, () => probe.inspect(Buffer.alloc(1024 * 1024))));
    assert.deepEqual(new Set(refused.map((result) => result.kind)), new Set(['busy']));
    assert.equal((await first).kind, 'valid');
  });

  it('holds its concurrency slot until a killed child and inherited output pipe close', async () => {
    const probe = new MediaFormatProbe({
      executable: executable(`
printf '12345'
(sleep 0.1) &
wait
      `),
      maxConcurrent: 1,
      maxOutputBytes: 4,
    });
    const first = probe.inspect(Buffer.from('a'));
    assert.deepEqual(await probe.inspect(Buffer.from('b')), { kind: 'busy' });
    assert.deepEqual(await first, { kind: 'failed', reason: 'output_limit' });
  });
});
