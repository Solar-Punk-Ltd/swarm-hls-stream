import { Bee } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RecoveryStore } from '../src/libs/RecoveryStore.js';
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { StreamUploader } from '../src/libs/StreamUploader.js';
import { MEDIA_TYPE_VIDEO, StreamState } from '../src/types.js';

import { makeFakeCatalog, makeFakeRecoveryStore } from './helpers/fakes.js';

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

function newUploader(
  segmentControl: SegmentUploadControl = {},
  opts: { restoreState?: unknown; feedWriteFails?: boolean } = {},
): StreamUploader {
  return new StreamUploader(
    makeBee(segmentControl, opts.feedWriteFails),
    '',
    makeFakeCatalog(),
    makeFakeRecoveryStore(),
    TEST_STREAM_KEY,
    'stamp',
    'stream-test',
    MEDIA_TYPE_VIDEO,
    opts.restoreState as never,
  );
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

  it('flags the next segment as a discontinuity when the engine never delivered one', async () => {
    const uploader = newUploader();

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    uploader.handleSegmentLoss(1, 1);
    await drain(uploader);

    assert.equal(
      uploader.getConsecutiveSegmentFailures(),
      0,
      'a loss deliberately leaves the upload-failure counter alone, since no upload was attempted',
    );

    uploader.handleSegment(2, 2, Buffer.from('seg2'));
    await drain(uploader);

    const byIndex = new Map(uploader.getStreamState().segments.map((s) => [s.index, s]));

    assert.deepEqual(
      [...byIndex.keys()].sort((a, b) => a - b),
      [0, 2],
    );
    assert.equal(
      byIndex.get(0)?.discontinuity,
      false,
      'a segment already queued when the loss arrives is not flagged retroactively',
    );
    assert.equal(byIndex.get(2)?.discontinuity, true, 'the first segment after the gap carries the discontinuity');
  });

  it('flags one discontinuity for a gap however many segments it spans', async () => {
    const uploader = newUploader();

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    uploader.handleSegmentLoss(1, 40);
    uploader.handleSegment(41, 2, Buffer.from('seg41'));
    uploader.handleSegment(42, 2, Buffer.from('seg42'));
    await drain(uploader);

    const byIndex = new Map(uploader.getStreamState().segments.map((s) => [s.index, s]));

    assert.equal(byIndex.get(41)?.discontinuity, true, 'the segment that closes the gap carries the marker');
    assert.equal(byIndex.get(42)?.discontinuity, false, 'and the one after it does not');
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
    const uploader = new StreamUploader(
      makeBee({ fail: permanentError }),
      '',
      makeFakeCatalog(),
      recovery,
      TEST_STREAM_KEY,
      'stamp',
      'stream-test',
      MEDIA_TYPE_VIDEO,
    );

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

    const uploader = new StreamUploader(
      bee,
      '',
      makeFakeCatalog(),
      makeFakeRecoveryStore(),
      TEST_STREAM_KEY,
      'stamp',
      'stream-test',
      MEDIA_TYPE_VIDEO,
    );

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

describe('StreamUploader finalization (CON-25)', () => {
  /**
   * Two callers reach `notifyStop` for one session and neither can see the other. A reconnect during a
   * drain retires the live session and hands it to `finalizeRetiredSession`, which deliberately stays
   * out of `drainPromises` because the id belongs to the replacement by then, so the guard in
   * `stopStream` that answers a duplicate stop with the in-flight drain never sees it. Both then
   * finalize the same session: two VOD manifests, each a SOC write and the postage for it, and the
   * second rewrites the catalog entry the first published.
   */
  it('publishes one VOD however many times it is asked to finalize', async () => {
    const socWrites: number[] = [];
    const published: { state: string }[] = [];
    const bee = {
      uploadData: async () => ({ reference: { toHex: () => 'ref0' } }),
      makeFeedWriter: () => ({
        uploadPayload: async (_stamp: string, _data: unknown, opts: { index: number }) => {
          socWrites.push(opts.index);
          return { reference: { toHex: () => `soc${opts.index}` } };
        },
      }),
    } as unknown as Bee;
    const catalog = {
      addStream: async (entry: { state: string }) => {
        published.push(entry);
      },
    } as unknown as StreamCatalog;

    const uploader = new StreamUploader(
      bee,
      '',
      catalog,
      makeFakeRecoveryStore(),
      TEST_STREAM_KEY,
      'stamp',
      'stream-test',
      MEDIA_TYPE_VIDEO,
    );

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    // Sequential, not concurrent. Two calls issued before either is awaited are deduped by any memo,
    // including one that clears itself once the first settles, and that mutant survived. The second
    // stop really can arrive after the first finished: `stopStream` deletes its `drainPromises` entry
    // when the drain resolves, and `finalizeRetiredSession` never registers one at all.
    await uploader.notifyStop();
    await uploader.notifyStop();

    assert.deepEqual(
      published.map((entry) => entry.state),
      ['live', 'vod'],
      'a session announces once and finalizes once, whoever asks',
    );
    assert.deepEqual(
      socWrites,
      [0, 1],
      'the second finalize committed another VOD manifest at the next index, paid for and identical',
    );
  });
});
