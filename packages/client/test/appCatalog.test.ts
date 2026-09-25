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

    assert.deepEqual(updater({ gateway: null, streams: [] }), {
      gateway: selectedGateway.current,
      streams: gatewayB,
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
    };

    selectedGateway.current = 'https://gateway-b.example';

    assert.equal(updater(gatewayB), gatewayB, 'a late response replaced the selected gateway catalog');
  });
});
