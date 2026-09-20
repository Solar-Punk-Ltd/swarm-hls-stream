import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

import type { BoundedCommand, CommandResult } from '../src/continuation/dockerCli.js';
import { createFixturePlan,FixtureRefusal } from '../src/continuation/fixture.js';
import {
  BROWSER_CONTROL_SCRIPT,
  FixtureReadinessControlExecutor,
  type FixtureReadinessControlInput,
} from '../src/continuation/readinessControls.js';
import { createContinuationTopology, type TopologyServiceRole } from '../src/continuation/topology.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const COMMIT = 'b'.repeat(40);
const UPLOADER_ID = '22222222-2222-4222-8222-222222222222';
const BATCH_ID = 'c'.repeat(64);
const STREAM_ID = '11111111-1111-4111-8111-111111111111';
const REFERENCE = 'd'.repeat(64);

interface Call {
  file: string;
  args: readonly string[];
}

class FakeCommand implements BoundedCommand {
  readonly calls: Call[] = [];

  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ file, args: [...args] });
    const joined = args.join('\n');
    if (joined.includes('bee-upload-read-control')) {
      return json({
        source: 'bee-upload-read-control',
        batchIdHash: `sha256:${hash(BATCH_ID)}`,
        usable: true,
        capacityBytes: 536_870_912,
        ttlSeconds: 1_800,
        uploadStatus: 201,
        readStatus: 200,
        bytesMatch: true,
        browserMediaReference: REFERENCE,
      });
    }
    if (joined.includes('srs-callback-control')) {
      return json({ source: 'srs-callback-control', callbacksBefore: 7, callbacksAfter: 8 });
    }
    if (joined.includes("source: 'ffprobe'")) {
      return json({ source: 'ffprobe', exitCode: 0, formatName: 'mpegts' });
    }
    if (joined.includes('browser-false-codec-control') && controlInput(args).mode === 'false-codec') {
      return json({
        source: 'browser-false-codec-control',
        attemptedCodec: 'video/mp4; codecs="definitely-not-a-codec"',
        supported: false,
        sourceBufferAttempted: true,
        sourceBufferAccepted: false,
        sourceBufferRefused: true,
        loadedMetadata: false,
      });
    }
    if (joined.includes('browser-media-control') && controlInput(args).mode === 'decode') {
      return json({
        source: 'browser-media-control',
        playEvent: true,
        decodedFramesBefore: 0,
        decodedFramesAfter: 4,
        decodedAudioBytesBefore: 0,
        decodedAudioBytesAfter: 4_096,
        currentTimeBefore: 0,
        currentTimeAfter: 0.75,
        codecs: ['avc1.42c00a', 'mp4a.40.2'],
      });
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const role = roleForContainer(args.at(-1) ?? '');
      const limits = input().topology.services.find((service) => service.role === role)?.container.limits;
      assert.ok(limits);
      return json({
        state: role === 'media-sender' ? 'created' : 'running',
        nanoCpus: limits.cpus * 1_000_000_000,
        memoryBytes: limits.memoryBytes,
        pidsLimit: limits.pidsLimit,
      });
    }
    if (joined.includes('/sys/fs/cgroup/memory.current')) {
      return {
        stdout: '1048576\n2\nusage_usec 10\nuser_usec 5\nsystem_usec 5\nnr_periods 1\nnr_throttled 0\nthrottled_usec 0\n',
        stderr: '',
      };
    }
    if (args.includes('df')) {
      return {
        stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 10000000 1 9000000 1% /\n',
        stderr: '',
      };
    }
    throw new Error(`unexpected command ${file} ${joined}`);
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): CommandResult {
  return { stdout: `${JSON.stringify(value)}\n`, stderr: '' };
}

function controlInput(args: readonly string[]): Record<string, unknown> {
  return JSON.parse(Buffer.from(args.at(-1) ?? '', 'base64').toString('utf8')) as Record<string, unknown>;
}

function roleForContainer(id: string): TopologyServiceRole {
  const suffix = '-id';
  assert.ok(id.endsWith(suffix));
  return id.slice(0, -suffix.length) as TopologyServiceRole;
}

function input(): FixtureReadinessControlInput {
  const plan = createFixturePlan({
    fixtureId: FIXTURE_ID,
    outputRoot: `/private/tmp/${FIXTURE_ID}`,
    candidates: [
      { role: 'stack', root: '/private/tmp/stack', commit: COMMIT },
      { role: 'admin', root: '/private/tmp/admin', commit: COMMIT },
      { role: 'manager', root: '/private/tmp/manager', commit: COMMIT },
    ],
    candidateImages: {
      postgres: IMAGE_ID,
      srs: IMAGE_ID,
      uploader: IMAGE_ID,
      adminApi: IMAGE_ID,
      adminWeb: IMAGE_ID,
      viewer: IMAGE_ID,
      mediaSender: IMAGE_ID,
      browser: IMAGE_ID,
    },
    loopbackPorts: { rpc: 18_545, admin: 19_877, viewer: 18_080 },
    minimumStorageBytes: 1_000_000,
    minimumStorageTtlSeconds: 900,
    expectedChainId: 1_337,
  });
  const topology = createContinuationTopology(plan, UPLOADER_ID);
  return {
    fixtureId: FIXTURE_ID,
    topology,
    containers: new Map(
      topology.services.map(({ role }) => [role, { id: `${role}-id`, name: `${FIXTURE_ID}-${role}` }]),
    ),
    postageBatchId: BATCH_ID,
    viewerMediaBaseUrl: 'http://client',
    srs: { host: 'srs', rtmpPort: 10_012 },
    readinessStreamTopic: STREAM_ID,
    requiredDiskBytes: 1_000_000_000,
    controlTimeoutMs: 30_000,
  };
}

function decode(value: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>;
}

function generatedBrowserProgram(inputValue: Record<string, unknown>): string {
  let target = '';
  runInNewContext(BROWSER_CONTROL_SCRIPT, {
    Buffer,
    process: {
      argv: ['node', Buffer.from(JSON.stringify(inputValue)).toString('base64')],
      exit: (code: number) => { throw new Error(`browser wrapper exited ${code}`); },
      stdout: { write: () => {} },
    },
    require: (specifier: string) => {
      assert.equal(specifier, 'node:child_process');
      return {
        spawnSync: (file: string, args: readonly string[]) => {
          assert.equal(file, '/opt/google/chrome/google-chrome');
          target = args.at(-1) ?? '';
          return { status: 0, stdout: '<body>{"source":"captured"}</body>' };
        },
      };
    },
  });
  const prefix = 'data:text/html;base64,';
  assert.ok(target.startsWith(prefix));
  const html = Buffer.from(target.slice(prefix.length), 'base64').toString('utf8');
  const match = /<script>([\s\S]+)<\/script>/.exec(html);
  assert.ok(match);
  return match[1];
}

async function runGeneratedBrowserProgram(
  mode: 'decode' | 'false-codec',
  emitSourceOpen = true,
): Promise<{
  result: Record<string, unknown>;
  codecQueries: string[];
  sourceOpenObserved: boolean;
  sourceBufferAttempted: boolean;
}> {
  const program = generatedBrowserProgram(
    mode === 'decode' ? { mode, mediaUrl: `http://client/bee/bytes/${REFERENCE}` } : { mode },
  );
  let rendered = '';
  const codecQueries: string[] = [];
  let sourceOpenObserved = false;
  let sourceBufferAttempted = false;
  const videoListeners = new Map<string, () => void>();
  const video = {
    currentTime: 0,
    webkitAudioDecodedByteCount: 0,
    webkitDecodedFrameCount: 0,
    addEventListener: (event: string, listener: () => void) => videoListeners.set(event, listener),
    canPlayType: () => '',
    play: async () => {
      videoListeners.get('play')?.();
      video.currentTime = 0.75;
      video.webkitAudioDecodedByteCount = 4_096;
      video.webkitDecodedFrameCount = 4;
    },
  };
  class MediaSourceStub {
    static isTypeSupported(codec: string): boolean {
      codecQueries.push(codec);
      return mode === 'decode' && [
        'video/mp4; codecs="avc1.42c00a"',
        'video/mp4; codecs="mp4a.40.2"',
      ].includes(codec);
    }

    readyState = 'closed';

    addEventListener(event: string, listener: () => void): void {
      if (event === 'sourceopen') {
        sourceOpenObserved = true;
        if (emitSourceOpen) {
          this.readyState = 'open';
          queueMicrotask(listener);
        }
      }
    }

    addSourceBuffer(): never {
      sourceBufferAttempted = true;
      throw new Error('unsupported codec');
    }
  }
  const completion = runInNewContext(program, {
    JSON,
    MediaSource: MediaSourceStub,
    Promise,
    URL: { createObjectURL: () => 'blob:fixture' },
    clearTimeout: () => {},
    document: {
      body: {
        append: () => {},
        set textContent(value: string) { rendered = value; },
      },
      createElement: () => video,
    },
    setTimeout: (callback: () => void, milliseconds: number) => {
      if (milliseconds > 1_000 || !emitSourceOpen) {queueMicrotask(callback);}
      return 1;
    },
  });
  await Promise.resolve(completion);
  return {
    result: JSON.parse(rendered) as Record<string, unknown>,
    codecQueries,
    sourceOpenObserved,
    sourceBufferAttempted,
  };
}

describe('FixtureReadinessControlExecutor', () => {
  it('derives every media control from bounded real-process observations', async () => {
    const command = new FakeCommand();
    const controls = new FixtureReadinessControlExecutor(command, input());

    assert.deepEqual(decode(await controls.run('storage', 64 * 1024)), {
      source: 'bee-upload-read-control',
      batchIdHash: `sha256:${hash(BATCH_ID)}`,
      usable: true,
      capacityBytes: 536_870_912,
      ttlSeconds: 1_800,
      uploadStatus: 201,
      readStatus: 200,
      bytesMatch: true,
    });
    assert.deepEqual(decode(await controls.run('callbacks', 64 * 1024)), {
      source: 'srs-callback-control',
      callbacksBefore: 7,
      callbacksAfter: 8,
    });
    assert.deepEqual(decode(await controls.run('openingFormat', 64 * 1024)), {
      source: 'ffprobe',
      exitCode: 0,
      formatName: 'mpegts',
    });
    assert.deepEqual(decode(await controls.run('browserDecode', 64 * 1024)), {
      source: 'browser-media-control',
      playEvent: true,
      decodedFramesBefore: 0,
      decodedFramesAfter: 4,
      decodedAudioBytesBefore: 0,
      decodedAudioBytesAfter: 4_096,
      currentTimeBefore: 0,
      currentTimeAfter: 0.75,
      codecs: ['avc1.42c00a', 'mp4a.40.2'],
    });
    assert.deepEqual(decode(await controls.run('falseCodec', 64 * 1024)), {
      source: 'browser-false-codec-control',
      attemptedCodec: 'video/mp4; codecs="definitely-not-a-codec"',
      supported: false,
      sourceBufferAttempted: true,
      sourceBufferAccepted: false,
      sourceBufferRefused: true,
      loadedMetadata: false,
    });

    const serialized = command.calls.flatMap(({ args }) => args).join('\n');
    assert.doesNotMatch(serialized, new RegExp(BATCH_ID));
    assert.match(serialized, /\/usr\/bin\/ffprobe/);
    assert.match(serialized, /\/usr\/bin\/ffmpeg/);
    assert.match(serialized, /webkitAudioDecodedByteCount/);
    const inputs = command.calls
      .filter(({ args }) => args[0] === 'exec' && args[2] === 'node')
      .map(({ args }) => controlInput(args));
    assert.ok(inputs.some((value) => value.streamTopic === STREAM_ID && value.invalidKey === 'readiness-invalid'));
    assert.match(serialized, /\/video\//);
    assert.ok(inputs.some((value) => value.mediaUrl === `http://client/bee/bytes/${REFERENCE}`));
  });

  it('refuses browser evidence before storage proved a viewer-path read', async () => {
    const controls = new FixtureReadinessControlExecutor(new FakeCommand(), input());

    await assert.rejects(
      controls.run('browserDecode', 64 * 1024),
      /browser readiness requires a verified storage control/i,
    );
  });

  it('binds SRS and viewer controls to the declared internal topology', () => {
    const resolved = input();
    const containers = new Map(resolved.containers);
    containers.set('srs', { id: 'srs-id', name: 'guarded-uploader-srs-1' });
    containers.set('uploader', { id: 'uploader-id', name: 'guarded-uploader-stream-uploader-1' });
    containers.set('viewer', { id: 'viewer-id', name: 'guarded-viewer-client-1' });
    assert.doesNotThrow(() => new FixtureReadinessControlExecutor(
      new FakeCommand(),
      { ...resolved, containers },
    ));

    assert.throws(
      () => new FixtureReadinessControlExecutor(
        new FakeCommand(),
        { ...input(), viewerMediaBaseUrl: 'not a URL' },
      ),
      (error: unknown) => error instanceof FixtureRefusal && /viewer media URL/i.test(error.message),
    );
    assert.throws(
      () => new FixtureReadinessControlExecutor(
        new FakeCommand(),
        { ...input(), viewerMediaBaseUrl: 'http://example.test' },
      ),
      /viewer media URL does not match the topology/i,
    );
    assert.throws(
      () => new FixtureReadinessControlExecutor(
        new FakeCommand(),
        { ...input(), srs: { host: 'srs', rtmpPort: 1_935 } },
      ),
      /SRS endpoint does not match the topology/i,
    );
  });

  it('requires the browser to reject creating a source buffer for the false codec', async () => {
    class AcceptedSourceBufferCommand extends FakeCommand {
      override async run(file: string, args: readonly string[]): Promise<CommandResult> {
        if (args.join('\n').includes('browser-false-codec-control')) {
          return json({
            source: 'browser-false-codec-control',
            attemptedCodec: 'video/mp4; codecs="definitely-not-a-codec"',
            supported: false,
            sourceBufferAttempted: true,
            sourceBufferAccepted: true,
            sourceBufferRefused: false,
            loadedMetadata: false,
          });
        }
        return super.run(file, args);
      }
    }

    const controls = new FixtureReadinessControlExecutor(new AcceptedSourceBufferCommand(), input());
    await assert.rejects(controls.run('falseCodec', 64 * 1024), /did not observe a browser refusal/i);
  });

  it('generates executable decode and sourceopen-based false-codec browser pages', async () => {
    const decoded = await runGeneratedBrowserProgram('decode');
    assert.equal(decoded.result.source, 'browser-media-control');
    assert.equal(decoded.result.decodedFramesAfter, 4);
    assert.equal(decoded.result.decodedAudioBytesAfter, 4_096);
    assert.deepEqual(decoded.codecQueries, [
      'video/mp4; codecs="avc1.42c00a"',
      'video/mp4; codecs="mp4a.40.2"',
    ]);

    const refused = await runGeneratedBrowserProgram('false-codec');
    assert.equal(refused.sourceOpenObserved, true);
    assert.equal(refused.sourceBufferAttempted, true);
    assert.deepEqual(refused.result, {
      source: 'browser-false-codec-control',
      attemptedCodec: 'video/mp4; codecs="definitely-not-a-codec"',
      supported: false,
      sourceBufferAttempted: true,
      sourceBufferAccepted: false,
      sourceBufferRefused: true,
      loadedMetadata: false,
    });
  });

  it('treats a false-codec sourceopen timeout as inconclusive', async () => {
    const timedOut = await runGeneratedBrowserProgram('false-codec', false);
    assert.equal(timedOut.sourceOpenObserved, true);
    assert.equal(timedOut.sourceBufferAttempted, false);

    class SourceOpenTimeoutCommand extends FakeCommand {
      override async run(file: string, args: readonly string[]): Promise<CommandResult> {
        if (args.join('\n').includes('browser-false-codec-control')) {
          return json(timedOut.result);
        }
        return super.run(file, args);
      }
    }
    const controls = new FixtureReadinessControlExecutor(new SourceOpenTimeoutCommand(), input());
    await assert.rejects(controls.run('falseCodec', 64 * 1024), /did not observe a browser refusal/i);
  });

  it('refuses callback evidence unless one real SRS rejection reached the uploader', async () => {
    class NoCallbackCommand extends FakeCommand {
      override async run(file: string, args: readonly string[]): Promise<CommandResult> {
        if (args.join('\n').includes('srs-callback-control')) {
          return json({ source: 'srs-callback-control', callbacksBefore: 7, callbacksAfter: 7 });
        }
        return super.run(file, args);
      }
    }

    const controls = new FixtureReadinessControlExecutor(new NoCallbackCommand(), input());
    await assert.rejects(controls.run('callbacks', 64 * 1024), /callback control did not observe exactly one rejection/i);
  });

  it('refuses a video-only browser reading as proof of the H.264 and AAC sample', async () => {
    class VideoOnlyCommand extends FakeCommand {
      override async run(file: string, args: readonly string[]): Promise<CommandResult> {
        if (args.join('\n').includes('browser-media-control') && controlInput(args).mode === 'decode') {
          return json({
            source: 'browser-media-control',
            playEvent: true,
            decodedFramesBefore: 0,
            decodedFramesAfter: 4,
            decodedAudioBytesBefore: 0,
            decodedAudioBytesAfter: 0,
            currentTimeBefore: 0,
            currentTimeAfter: 0.75,
            codecs: ['avc1.42c00a', 'mp4a.40.2'],
          });
        }
        return super.run(file, args);
      }
    }

    const controls = new FixtureReadinessControlExecutor(new VideoOnlyCommand(), input());
    await controls.run('storage', 64 * 1024);
    await assert.rejects(
      controls.run('browserDecode', 64 * 1024),
      /did not prove video and audio decoding/i,
    );
  });

  it('reads actual resource limits, usage, throttling, and disk for every planned service', async () => {
    const command = new FakeCommand();
    const configured = input();
    const controls = new FixtureReadinessControlExecutor(command, configured, {
      now: () => 1_000,
      sleep: async () => {},
    });

    const result = decode(await controls.run('capacity', 64 * 1024));
    assert.equal(result.source, 'fixture-capacity-control');
    assert.equal(result.availableDiskBytes, 9_000_000 * 1_024);
    assert.equal(result.requiredDiskBytes, configured.requiredDiskBytes);
    assert.equal(result.timeoutsWithinBounds, true);
    const services = result.services as Array<Record<string, unknown>>;
    assert.equal(services.length, configured.topology.services.length);
    assert.deepEqual(services.find(({ role }) => role === 'media-sender'), {
      role: 'media-sender',
      memoryCurrentBytes: 0,
      memoryLimitBytes: 2_147_483_648,
      pidsCurrent: 0,
      pidsLimit: 256,
      cpuLimit: 2,
      cpuThrottledDelta: 0,
    });
    assert.ok(
      configured.topology.services
        .filter(({ role }) => role !== 'media-sender')
        .every(({ role }) => services.some((service) => service.role === role)),
    );
  });

  it('bounds emitted evidence and does not disclose malformed child output', async () => {
    class OversizedCommand extends FakeCommand {
      override async run(): Promise<CommandResult> {
        return { stdout: `SENTINEL${'x'.repeat(2_000)}`, stderr: '' };
      }
    }
    const controls = new FixtureReadinessControlExecutor(new OversizedCommand(), input());

    await assert.rejects(controls.run('storage', 128), (error: unknown) => {
      assert.ok(error instanceof FixtureRefusal);
      assert.match(error.message, /bounded JSON/i);
      assert.doesNotMatch(error.message, /SENTINEL/);
      return true;
    });
  });

  it('carries a measured over-budget control into the capacity refusal evidence', async () => {
    let now = 0;
    class SlowCommand extends FakeCommand {
      override async run(file: string, args: readonly string[]): Promise<CommandResult> {
        const result = await super.run(file, args);
        if (args.join('\n').includes('bee-upload-read-control')) {
          now = 30_001;
        }
        return result;
      }
    }
    const controls = new FixtureReadinessControlExecutor(new SlowCommand(), input(), {
      now: () => now,
      sleep: async () => {},
    });

    await controls.run('storage', 64 * 1024);
    const capacity = decode(await controls.run('capacity', 64 * 1024));
    assert.equal(capacity.timeoutsWithinBounds, false);
  });
});
