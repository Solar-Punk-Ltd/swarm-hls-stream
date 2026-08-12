import { Bee } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RecoveryStore } from '../src/libs/RecoveryStore.js';
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { StreamUploader } from '../src/libs/StreamUploader.js';
import { MEDIA_TYPE_VIDEO, StreamState } from '../src/types.js';

// A valid 32-byte secp256k1 private key (value 1) — enough for bee-js to derive a signer in tests.
const TEST_STREAM_KEY = '0'.repeat(63) + '1';

const permanentError = () => Object.assign(new Error('402 payment required'), { status: 402 });

interface SegmentUploadControl {
  fail?: () => Error | null;
}

function makeBee(segmentControl: SegmentUploadControl, feedWriteFails = false): Bee {
  let refCounter = 0;
  const bee = {
    uploadData: async () => {
      const err = segmentControl.fail?.();
      if (err) {
        throw err;
      }
      const ref = `ref${refCounter++}`;
      return { reference: { toHex: () => ref } };
    },
    makeFeedWriter: () => ({
      uploadPayload: async (_stamp: string, _data: unknown, opts: { index: number }) => {
        if (feedWriteFails) {
          throw permanentError();
        }
        return { reference: { toHex: () => `soc${opts.index}` } };
      },
    }),
  };
  return bee as unknown as Bee;
}

function makeCatalog(): StreamCatalog {
  return { addStream: async () => {} } as unknown as StreamCatalog;
}

function makeRecovery(): RecoveryStore {
  return {
    save: () => {},
    load: () => null,
    remove: () => {},
    listActive: () => [],
  } as unknown as RecoveryStore;
}

function newUploader(
  segmentControl: SegmentUploadControl = {},
  opts: { restoreState?: unknown; feedWriteFails?: boolean } = {},
): StreamUploader {
  return new StreamUploader({
    bee: makeBee(segmentControl, opts.feedWriteFails),
    manifestBeeUrl: '',
    streamCatalog: makeCatalog(),
    recoveryStore: makeRecovery(),
    streamKey: TEST_STREAM_KEY,
    stamp: 'stamp',
    redundancyLevel: 1,
    streamId: 'stream-test',
    streamTopic: 'topic-test',
    mediatype: MEDIA_TYPE_VIDEO,
    restoreState: opts.restoreState as never,
  });
}

async function drain(uploader: StreamUploader): Promise<void> {
  await uploader.segmentQueue.onIdle();
  await (uploader as unknown as { manifestQueue: { onIdle(): Promise<void> } }).manifestQueue.onIdle();
}

describe('StreamUploader discontinuity lifecycle', () => {
  it('marks the first segment after a failed upload as a discontinuity, then clears the flag', async () => {
    const control: SegmentUploadControl = {};
    const uploader = newUploader(control);

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    // Segment 1's upload fails permanently (fast) → dropped, discontinuity armed.
    control.fail = permanentError;
    uploader.handleSegment(1, 2, Buffer.from('seg1'));
    await drain(uploader);

    // Segment 2 uploads cleanly → carries the discontinuity...
    control.fail = undefined;
    uploader.handleSegment(2, 2, Buffer.from('seg2'));
    await drain(uploader);

    // ...and segment 3 does not (flag was reset).
    uploader.handleSegment(3, 2, Buffer.from('seg3'));
    await drain(uploader);

    const state = uploader.getStreamState();
    const byIndex = new Map(state.segments.map((s) => [s.index, s]));

    assert.deepEqual(
      [...byIndex.keys()].sort((a, b) => a - b),
      [0, 2, 3],
      'segment 1 should have been dropped after exhausting its upload',
    );
    assert.equal(byIndex.get(0)?.discontinuity, false);
    assert.equal(byIndex.get(2)?.discontinuity, true);
    assert.equal(byIndex.get(3)?.discontinuity, false);
    assert.equal(state.pendingDiscontinuity, false);
  });

  it('restores pendingDiscontinuity across a restart so the next segment is flagged', async () => {
    const uploader = newUploader(
      {},
      {
        restoreState: {
          streamRawTopic: 'topic-abc',
          socIndex: 5,
          segments: [{ index: 0, duration: 2, ref: 'ref0', discontinuity: false }],
          hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
          isFirstSegmentReady: true,
          isFirstManifestReady: true,
          pendingDiscontinuity: true,
        },
      },
    );

    uploader.handleSegment(7, 2, Buffer.from('seg7'));
    await drain(uploader);

    const state = uploader.getStreamState();
    const seg7 = state.segments.find((s) => s.index === 7);
    assert.equal(seg7?.discontinuity, true);
    assert.equal(state.pendingDiscontinuity, false);
  });

  it('persists pendingDiscontinuity when a segment upload fails, so it survives a crash', async () => {
    const saved: StreamState[] = [];
    const recovery = {
      save: (_id: string, state: StreamState) => {
        saved.push(state);
      },
      load: () => null,
      remove: () => {},
      listActive: () => [],
    } as unknown as RecoveryStore;
    const uploader = new StreamUploader({
      bee: makeBee({ fail: permanentError }),
      manifestBeeUrl: '',
      streamCatalog: makeCatalog(),
      recoveryStore: recovery,
      streamKey: TEST_STREAM_KEY,
      stamp: 'stamp',
      redundancyLevel: 1,
      streamId: 'stream-test',
      streamTopic: 'topic-test',
      mediatype: MEDIA_TYPE_VIDEO,
    });

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    assert.ok(
      saved.some((s) => s.pendingDiscontinuity === true),
      'a failed segment upload must persist pendingDiscontinuity=true',
    );
  });
});

describe('StreamUploader Swarm write options', () => {
  it('requests deferred uploads for segment and manifest feed writes', async () => {
    const dataOptions: unknown[] = [];
    const payloadOptions: unknown[] = [];
    let refCounter = 0;
    const bee = {
      uploadData: async (_stamp: string, _data: unknown, opts: unknown) => {
        dataOptions.push(opts);
        return { reference: { toHex: () => `ref${refCounter++}` } };
      },
      makeFeedWriter: () => ({
        uploadPayload: async (_stamp: string, _data: unknown, opts: { index: number }) => {
          payloadOptions.push(opts);
          return { reference: { toHex: () => `soc${opts.index}` } };
        },
      }),
    } as unknown as Bee;

    const uploader = new StreamUploader({
      bee,
      manifestBeeUrl: '',
      streamCatalog: makeCatalog(),
      recoveryStore: makeRecovery(),
      streamKey: TEST_STREAM_KEY,
      stamp: 'stamp',
      redundancyLevel: 1,
      streamId: 'stream-test',
      streamTopic: 'topic-test',
      mediatype: MEDIA_TYPE_VIDEO,
    });

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    assert.deepEqual(dataOptions, [{ redundancyLevel: 1, deferred: true }]);
    assert.deepEqual(payloadOptions, [{ index: 0, deferred: true }]);
  });
});

describe('StreamUploader live manifest failure surfacing', () => {
  it('flags liveManifestStale when manifest publishes fail while segments still upload', async () => {
    const uploader = newUploader({}, { feedWriteFails: true });

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    const state = uploader.getStreamState();
    assert.equal(state.liveManifestStale, true);
    // The segment itself uploaded fine — only the manifest (SOC feed) write failed.
    assert.equal(state.segments.length, 1);
  });
});

describe('StreamUploader catalog failures on the segment path', () => {
  const LADDER = {
    group: 'group-1',
    rung: { name: '360p', width: 640, height: 360, configuredKbps: 800 },
  };

  /**
   * Puts the uploader in the state refreshBandwidthIfDrifted acts on: a rung that has announced
   * once, long enough ago for the interval to have passed, whose measured bitrate has since moved
   * far enough to be worth correcting.
   */
  function primeForDriftCorrection(uploader: StreamUploader): void {
    const inner = uploader as unknown as {
      isFirstManifestReady: boolean;
      announcedBandwidth: number;
      lastBandwidthAnnounceAt: number;
      bitrate: { peakBps: number };
    };
    inner.isFirstManifestReady = true;
    inner.announcedBandwidth = 1_000_000;
    inner.lastBandwidthAnnounceAt = 0;
    inner.bitrate.peakBps = 5_000_000;
  }

  function uploaderWithCatalog(catalog: StreamCatalog, saved: StreamState[] = []): StreamUploader {
    const recovery = {
      save: (_id: string, state: StreamState) => {
        saved.push(state);
      },
      load: () => null,
      remove: () => {},
      listActive: () => [],
    } as unknown as RecoveryStore;

    return new StreamUploader({
      bee: makeBee({}),
      manifestBeeUrl: '',
      streamCatalog: catalog,
      recoveryStore: recovery,
      streamKey: TEST_STREAM_KEY,
      stamp: 'stamp',
      redundancyLevel: 1,
      streamId: 'stream-test',
      streamTopic: 'topic-test',
      mediatype: MEDIA_TYPE_VIDEO,
      ladder: LADDER,
    });
  }

  it('keeps a failed rendition announcement inside the segment task', async () => {
    // Nothing awaits the promise segmentQueue.add returns, so a rejection escaping the task becomes
    // a process-level unhandledRejection: logged without the ErrorHandler context that says which
    // stream it came from, and never surfaced to anything that could act on it.
    //
    // The listener is the assertion. Watching persistState instead would not work — commitManifest
    // persists from the manifest queue too, so state still lands either way and the escape hides.
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const catalog = {
      addStream: async () => {},
      upsertRendition: async () => {
        throw new Error('catalog feed read failed after the retry window');
      },
    } as unknown as StreamCatalog;

    try {
      const uploader = uploaderWithCatalog(catalog);
      primeForDriftCorrection(uploader);

      uploader.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(uploader);
      // onIdle resolves whether or not a task rejected, so give the loop a turn to emit the
      // rejection while this test is still the one on the stack to attribute it to.
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(uploader.getStreamState().segments.length, 1, 'the segment itself must still be recorded');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    assert.deepEqual(
      rejections.map((r) => (r as Error)?.message),
      [],
      'a failing catalog write must not escape the segment queue as an unhandled rejection',
    );
  });

  it('does not advance the drift baseline when the announcement failed to land', async () => {
    // The baseline is what every later comparison is measured against. Advancing it on a write the
    // catalog never received would have the uploader compare the new measurement against itself,
    // find no drift, and never retry the correction.
    const catalog = {
      addStream: async () => {},
      upsertRendition: async () => {
        throw new Error('catalog feed read failed after the retry window');
      },
    } as unknown as StreamCatalog;

    const uploader = uploaderWithCatalog(catalog);
    primeForDriftCorrection(uploader);

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    const inner = uploader as unknown as { announcedBandwidth: number };
    assert.equal(inner.announcedBandwidth, 1_000_000, 'the unpublished bandwidth must not become the baseline');
  });

  it('advances the drift baseline once the announcement lands', async () => {
    const announced: number[] = [];
    const catalog = {
      addStream: async () => {},
      upsertRendition: async (_identity: unknown, rendition: { bandwidth: number }) => {
        announced.push(rendition.bandwidth);
      },
    } as unknown as StreamCatalog;

    const uploader = uploaderWithCatalog(catalog);
    primeForDriftCorrection(uploader);

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    assert.equal(announced.length, 1);
    const inner = uploader as unknown as { announcedBandwidth: number };
    assert.equal(inner.announcedBandwidth, announced[0]);
    assert.notEqual(inner.announcedBandwidth, 1_000_000);
  });
});
