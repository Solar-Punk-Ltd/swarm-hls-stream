import { Bee } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { MEDIA_TYPE_VIDEO, STREAM_STATUS_LIVE } from '../src/types.js';

const TEST_STREAM_KEY = '0'.repeat(63) + '1';

describe('StreamCatalog Swarm write options', () => {
  it('requests a deferred upload for the catalog feed write', async () => {
    const captured: { deferred?: boolean }[] = [];
    const bee = {
      makeFeedWriter: () => ({
        uploadPayload: async (_stamp: string, _data: unknown, opts: { deferred?: boolean }) => {
          captured.push(opts);
          return { reference: { toHex: () => 'ref' } };
        },
      }),
    } as unknown as Bee;

    const catalog = new StreamCatalog(bee, TEST_STREAM_KEY, 'test-topic', 'stamp');
    await catalog.addStream({
      title: 'title',
      owner: 'owner',
      topic: 'topic-uuid',
      state: STREAM_STATUS_LIVE,
      mediatype: MEDIA_TYPE_VIDEO,
      timestamp: 0,
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].deferred, true);
  });
});
