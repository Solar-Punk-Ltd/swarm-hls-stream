import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { catalogUpdater } from '@/providers/catalogState';
import { Stream } from '@/types/stream';

function streamAt(timestamp: number, title: string): Stream {
  return { owner: '0xabc', topic: `topic-${timestamp}`, timestamp, mediatype: 'video', title };
}

describe('the catalog provider state update', () => {
  it('discards gateway A when the viewer selects gateway B before the queued update runs', () => {
    const selectedGateway = { current: 'https://gateway-a.example' };
    const lateGatewayA = [streamAt(600, 'stale gateway A')];
    const updater = catalogUpdater({ gateway: 'https://gateway-a.example', streams: lateGatewayA }, selectedGateway);
    const gatewayB = {
      gateway: 'https://gateway-b.example',
      streams: [streamAt(500, 'selected gateway B')],
    };

    selectedGateway.current = 'https://gateway-b.example';

    assert.equal(updater(gatewayB), gatewayB, 'a late response replaced the selected gateway catalog');
  });
});
