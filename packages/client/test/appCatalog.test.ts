import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { catalogUpdater, toCatalogRead } from '@/providers/catalogState';
import { Stream } from '@/types/stream';

function streamAt(timestamp: number, title: string): Stream {
  return { owner: '0xabc', topic: `topic-${timestamp}`, timestamp, mediatype: 'video', title };
}

describe('the read a catalog poll hands to the stream list', () => {
  it('carries the slot its body was read from, so the list can tell a newer read from an older one', () => {
    assert.deepEqual(toCatalogRead('https://gateway.example', { body: '[{"a":1}]', slot: 8n }), {
      gateway: 'https://gateway.example',
      streams: [{ a: 1 }],
      slot: 8n,
    });
  });

  it('carries neither a body nor a slot when the gateway had nothing newer', () => {
    assert.deepEqual(toCatalogRead('https://gateway.example', null), {
      gateway: 'https://gateway.example',
      streams: null,
      slot: null,
    });
  });
});

describe('the catalog provider state update', () => {
  it('applies a response from the gateway that is still selected', () => {
    const selectedGateway = { current: 'https://gateway-b.example' };
    const gatewayB = [streamAt(500, 'selected gateway B')];
    const updater = catalogUpdater({ gateway: selectedGateway.current, streams: gatewayB, slot: 3n }, selectedGateway);

    assert.deepEqual(updater({ gateway: null, streams: [], slot: null }), {
      gateway: selectedGateway.current,
      streams: gatewayB,
      slot: 3n,
    });
  });

  it('discards gateway A when the viewer selects gateway B before the queued update runs', () => {
    const selectedGateway = { current: 'https://gateway-a.example' };
    const lateGatewayA = [streamAt(600, 'stale gateway A')];
    const updater = catalogUpdater(
      { gateway: 'https://gateway-a.example', streams: lateGatewayA, slot: 9n },
      selectedGateway,
    );
    const gatewayB = {
      gateway: 'https://gateway-b.example',
      streams: [streamAt(500, 'selected gateway B')],
      slot: 4n,
    };

    selectedGateway.current = 'https://gateway-b.example';

    assert.equal(updater(gatewayB), gatewayB, 'a late response replaced the selected gateway catalog');
  });

  /**
   * The slot held beside the list is what the next read is ordered against, so it has to describe the
   * list on screen: it moves with a list that is taken and stays put for a read that is refused.
   */
  it('keeps the slot of the list on screen, so each later read is ordered against what is shown', () => {
    const gateway = { current: 'https://gateway.example' };
    const afterUnpublish = [streamAt(100, 'a'), streamAt(200, 'b')];
    const beforeUnpublish = [...afterUnpublish, streamAt(300, 'c')];
    const onScreen = { gateway: gateway.current, streams: afterUnpublish, slot: 8n };

    const afterOlderRead = catalogUpdater(
      { gateway: gateway.current, streams: beforeUnpublish, slot: 7n },
      gateway,
    )(onScreen);
    const afterNewerRead = catalogUpdater(
      { gateway: gateway.current, streams: [streamAt(200, 'b')], slot: 9n },
      gateway,
    )(afterOlderRead);

    assert.deepEqual(afterOlderRead, onScreen, 'a read from an older slot replaced the list on screen');
    assert.deepEqual(afterNewerRead, { gateway: gateway.current, streams: [streamAt(200, 'b')], slot: 9n });
  });
});
