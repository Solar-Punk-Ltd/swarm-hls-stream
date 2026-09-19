import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MEDIA_TYPE_VIDEO,
  STOP_FAILURE_FINALIZE_FAILED,
  STREAM_LIFECYCLE_FAILED,
  STREAM_STATUS_VOD,
  StreamState,
} from '../src/types.js';

import { makeFakeCatalog, makeFakeRecoveryStore, makeTestOrchestrator } from './helpers/fakes.js';
import { waitFor } from './helpers/waiting.js';

const STREAM_ID = 'live/stream';

/**
 * A ceiling on a hung wait rather than a measurement. A satisfied wait returns at the poll it is
 * satisfied on, so this costs nothing on the passing path and is what keeps the file green on a
 * loaded machine.
 */
const SETTLE_CEILING_MS = 4_000;

/**
 * A catalog that refuses to record the recording, which is the cheapest way to make a finalize reject
 * after it has spent its postage. The live writes still land, so the broadcast reaches the stop the
 * way a real one does.
 */
function makeRefusingCatalog() {
  return makeFakeCatalog({
    addStream: async (entry: { state?: string }) => {
      if (entry.state === STREAM_STATUS_VOD) {
        throw new Error('fake catalog refused the recording');
      }
    },
  });
}

/**
 * ⛔⛔⛔ A finalize that fails keeps its recovery entry on purpose, because that file is the only
 * record the broadcast was ever live and the next boot publishes the recording from it. Every other
 * place in the package treats it as irreplaceable: `StreamUploader.readManifestFeedHead` throws
 * rather than guess, `StreamOrchestrator.drainUploader` catches that and retires the uploader so the
 * file stops being touched, and `FinalizeResume.test.ts` asserts the entry survives a deferral.
 *
 * A second stop of the same id then walked past all of it. `performDrain` found no live session,
 * concluded there was nothing to keep, and deleted the file. A second stop is ordinary rather than
 * exotic: OME sends its closing after the puller has already stopped the stream, SRS sends
 * `on_unpublish` for a session that outlived a reap, and an operator who reads `failed` from
 * `GET /stream/status` retries the stop, which is the natural response to that word.
 *
 * What it cost: the recording is never published, the segments already bought stay in Swarm with
 * nothing pointing at them, the catalog entry says `live` for ever, and no health reason fires,
 * because `unrecoverable_stream` counts quarantined entries and this file was removed rather than
 * quarantined.
 */
describe('a stop that finds no live session leaves the recovery entry a failed finalize kept', () => {
  async function broadcastUntilItsFinalizeFails(): Promise<{
    orch: ReturnType<typeof makeTestOrchestrator>;
    removed: string[];
  }> {
    const removed: string[] = [];
    const saved: StreamState[] = [];
    const orch = makeTestOrchestrator(
      {},
      {},
      makeFakeRecoveryStore({
        remove: (streamId: string) => removed.push(streamId),
        save: (_streamId: string, state: StreamState) => saved.push(state),
      }),
      makeRefusingCatalog(),
    );

    orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    orch.handleSegment(STREAM_ID, 0, 2, Buffer.from('one'));
    // Without media the finalize ends on the no-segments branch, which clears the entry legitimately,
    // and every assertion below would be about a case this is not.
    await waitFor(() => saved.length > 0, SETTLE_CEILING_MS);

    await orch.stopStream(STREAM_ID);

    const report = orch.getStreamStatus(STREAM_ID);
    assert.equal(report.state, STREAM_LIFECYCLE_FAILED, 'the finalize was supposed to fail, so nothing here is tested');
    assert.equal(report.reason, STOP_FAILURE_FINALIZE_FAILED);

    return { orch, removed };
  }

  it('keeps the entry through the stop whose finalize failed', async () => {
    const { orch, removed } = await broadcastUntilItsFinalizeFails();

    assert.deepEqual(removed, [], 'the failed finalize discarded the only record the broadcast was live');

    await orch.cleanup();
  });

  it('keeps the entry through a second stop of the same id', async () => {
    const { orch, removed } = await broadcastUntilItsFinalizeFails();

    await orch.stopStream(STREAM_ID);

    assert.deepEqual(removed, [], 'the second stop deleted the recording the first one deferred to the next boot');

    await orch.cleanup();
  });
});
