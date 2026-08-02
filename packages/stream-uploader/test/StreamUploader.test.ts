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

/** A status in `RETRYABLE_HTTP_STATUSES`, so the write is expected to be attempted again. */
const transientError = () => Object.assign(new Error('503 service unavailable'), { status: 503 });

interface SegmentUploadControl {
  fail?: () => Error | null;
}

/** Fails the first `times` calls with `error` and succeeds from then on. */
function failFirst(times: number, error: () => Error): () => Error | null {
  let remaining = times;
  return () => (remaining-- > 0 ? error() : null);
}

/** Counts the calls a control saw, which is what tells one attempt apart from a retried one. */
function countingControl(fail: () => Error | null): SegmentUploadControl & { attempts: number } {
  const control = {
    attempts: 0,
    fail: () => {
      control.attempts++;
      return fail();
    },
  };
  return control;
}

function makeBee(segmentControl: SegmentUploadControl, feedControl: SegmentUploadControl = {}): Bee {
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
        const err = feedControl.fail?.();
        if (err) {
          throw err;
        }
        return { reference: { toHex: () => `soc${opts.index}` } };
      },
    }),
  };
  return bee as unknown as Bee;
}

function newUploader(
  segmentControl: SegmentUploadControl = {},
  opts: { restoreState?: unknown; feedWriteFails?: boolean; feedControl?: SegmentUploadControl } = {},
): StreamUploader {
  const feedControl = opts.feedControl ?? (opts.feedWriteFails ? { fail: permanentError } : {});
  return new StreamUploader(
    makeBee(segmentControl, feedControl),
    '',
    makeFakeCatalog(),
    makeFakeRecoveryStore(),
    TEST_STREAM_KEY,
    'stamp',
    'stream-test',
    MEDIA_TYPE_VIDEO,
    { restoreState: opts.restoreState as never },
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

/**
 * `retryUntilDeadlineAsync` and `isRetryableError` had direct unit tests in `common.test.ts` and
 * nothing else. Measured rather than assumed: replacing the retry loop's body with a bare rethrow
 * left every one of the other 27 uploader test files green, including this one, because every
 * induced failure here was a 402 chosen to keep the tests fast. So the helpers were proven, and
 * their two callers' dependence on them was not.
 *
 * TEST-1 recorded this as "the Bee mock always succeeds", which is no longer true: this file builds
 * a 402, `OmeHlsPuller.test.ts` a 503, `StreamCatalog.test.ts` a real `BeeResponseError`. The
 * conclusion held anyway, for a different reason.
 *
 * One retry costs one real backoff sleep, 175-350ms, which is why these fail once rather than
 * repeatedly.
 */
describe('StreamUploader survives a transient Bee failure (TEST-1)', () => {
  it('retries a segment upload that fails with a retryable status, and keeps the segment', async () => {
    const control = countingControl(failFirst(1, transientError));
    const uploader = newUploader(control);

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    assert.equal(control.attempts, 2, 'a 503 has to be attempted again, not dropped on the first answer');
    assert.deepEqual(
      uploader.getStreamState().segments.map((s) => s.index),
      [0],
      'the segment survived the flake, so nothing downstream sees a gap',
    );
  });

  it('does not retry a segment upload that fails with a permanent status', async () => {
    const control = countingControl(() => permanentError());
    const uploader = newUploader(control);

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    assert.equal(control.attempts, 1, 'a 402 means the stamp is exhausted, so retrying only burns the window');
    assert.deepEqual(uploader.getStreamState().segments, [], 'and the segment is dropped rather than held');
  });

  it('retries a live manifest publish that fails with a retryable status', async () => {
    const feedControl = countingControl(failFirst(1, transientError));
    const uploader = newUploader({}, { feedControl });

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    assert.equal(feedControl.attempts, 2, 'the SOC write has to be attempted again');
    assert.equal(uploader.getStreamState().socIndex, 0, 'and the feed advanced, so a reader can find it');
  });

  /**
   * The stale flag needs a publish that actually fails, which a retried one never is: the retry
   * swallows the transient error before the uploader sees it, so the counter is still at its
   * initial 0 and an assertion that it is 0 cannot fail. An earlier version of the test above
   * carried exactly that assertion, and deleting `consecutiveManifestFailures = 0` from the success
   * path left all 561 tests green.
   *
   * So the reset is driven the only way it can be: fail permanently until the flag is set, then
   * succeed, and watch it go back down.
   */
  it('clears the stale-manifest flag once a publish finally succeeds', async () => {
    const feedControl = countingControl(failFirst(2, () => permanentError()));
    const uploader = newUploader({}, { feedControl });

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);
    uploader.handleSegment(1, 2, Buffer.from('seg1'));
    await drain(uploader);

    assert.equal(uploader.getConsecutiveManifestFailures(), 2, 'two refused publishes have to be a stale manifest');

    uploader.handleSegment(2, 2, Buffer.from('seg2'));
    await drain(uploader);

    assert.equal(
      uploader.getConsecutiveManifestFailures(),
      0,
      'a manifest that published is not stale, and /health reports this counter',
    );
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
    const catalog = makeFakeCatalog({
      addStream: async (entry: { state: string }) => {
        published.push(entry);
      },
    });

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

describe('StreamUploader catalog announce backoff (CON-3)', () => {
  function makeCatalog(attempts: unknown[], shouldFail: () => boolean): StreamCatalog {
    return makeFakeCatalog({
      addStream: async (entry: unknown) => {
        attempts.push(entry);
        if (shouldFail()) {
          throw new Error('catalog feed write refused');
        }
      },
    });
  }

  function newAnnouncingUploader(catalog: StreamCatalog, catalogAnnounceRetryMs: number): StreamUploader {
    return new StreamUploader(
      makeBee({}),
      '',
      catalog,
      makeFakeRecoveryStore(),
      TEST_STREAM_KEY,
      'stamp',
      'stream-test',
      MEDIA_TYPE_VIDEO,
      { catalogAnnounceRetryMs },
    );
  }

  async function publishSegments(uploader: StreamUploader, count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      uploader.handleSegment(index, 2, Buffer.from(`seg${index}`));
      await drain(uploader);
    }
  }

  /**
   * A failed announce left `isFirstManifestReady` false, so every later manifest publish tried again:
   * a feed read, a feed write and the postage for it once per segment, for as long as the catalog was
   * down, with nothing surfaced.
   */
  it('attempts the catalog announce once per retry window, not once per segment', async () => {
    const attempts: unknown[] = [];
    const uploader = newAnnouncingUploader(
      makeCatalog(attempts, () => true),
      60_000,
    );

    await publishSegments(uploader, 5);

    assert.equal(attempts.length, 1, `five segments cost ${attempts.length} paid catalog writes against a dead feed`);
  });

  /**
   * The other half, and the one that matters more: the catalog entry is the only thing that makes a
   * live broadcast discoverable, so an announce that gives up leaves the stream running and unlistable
   * for its whole duration. Suppressing the retry is a worse outcome than the cost it was suppressing.
   */
  it('keeps retrying once the window has elapsed, so a recovered catalog still lists the stream', async () => {
    const attempts: unknown[] = [];
    let catalogIsDown = true;
    const uploader = newAnnouncingUploader(
      makeCatalog(attempts, () => catalogIsDown),
      0,
    );

    await publishSegments(uploader, 2);
    assert.equal(attempts.length, 2, 'a zero window must not suppress anything');

    catalogIsDown = false;
    await publishSegments(uploader, 1);

    assert.equal(attempts.length, 3, 'the announce never landed after the catalog came back');
    assert.equal(uploader.getMsSinceCatalogAnnounceFailed(), null, 'a listed stream still reads as unlisted');
  });

  it('stops announcing once the catalog accepts it', async () => {
    const attempts: unknown[] = [];
    const uploader = newAnnouncingUploader(
      makeCatalog(attempts, () => false),
      0,
    );

    await publishSegments(uploader, 4);

    assert.equal(attempts.length, 1, 'a listed stream re-announced itself on every publish');
  });

  /**
   * An age rather than a count, because the retry window and the segment cadence are unrelated, so a
   * count of failures says nothing about how long a viewer has been unable to find the broadcast.
   */
  it('reports how long the stream has been live and unlisted', async () => {
    const attempts: unknown[] = [];
    const uploader = newAnnouncingUploader(
      makeCatalog(attempts, () => true),
      60_000,
    );

    assert.equal(uploader.getMsSinceCatalogAnnounceFailed(), null, 'nothing has failed yet');

    await publishSegments(uploader, 1);

    const age = uploader.getMsSinceCatalogAnnounceFailed();
    assert.ok(age !== null && age >= 0, `a live unlisted stream must be reportable, got ${age}`);
  });
});

describe('StreamUploader recovery persist failures (OBS-4)', () => {
  function newUploaderWithStore(recoveryStore: RecoveryStore): StreamUploader {
    return new StreamUploader(
      makeBee({}),
      '',
      makeFakeCatalog(),
      recoveryStore,
      TEST_STREAM_KEY,
      'stamp',
      'stream-test',
      MEDIA_TYPE_VIDEO,
    );
  }

  /**
   * A swallowed persist means recovery loads state older than reality, so a crash re-uploads or drops
   * everything written since the last save that landed. Nothing outside the log said it had happened.
   */
  it('reports how long state has been failing to persist', async () => {
    let saveFails = true;
    const uploader = newUploaderWithStore(
      makeFakeRecoveryStore({
        save: () => {
          if (saveFails) {
            throw new Error('ENOSPC: no space left on device');
          }
        },
      }),
    );

    assert.equal(uploader.getMsSinceStatePersistFailed(), null, 'nothing has been written yet');

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    const age = uploader.getMsSinceStatePersistFailed();
    assert.ok(age !== null && age >= 0, `a stream whose state is not on disk must be reportable, got ${age}`);

    saveFails = false;
    uploader.handleSegment(1, 2, Buffer.from('seg1'));
    await drain(uploader);

    assert.equal(uploader.getMsSinceStatePersistFailed(), null, 'a save that landed must clear the signal');
  });
});
