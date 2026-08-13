import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  exposeGatewayForInstrumentation,
  GATEWAY_HANDLE,
  type GatewaySwitch,
} from '../src/providers/gatewayTestHandle';

/**
 * That a harness can move a running viewer between gateways, and that nothing else can.
 *
 * ⭐ The measurement this exists for is the one every viewer figure in this project is missing: all of
 * them were taken through a chequebook-funded gateway, which is the best case rather than the
 * shipping one. Answering it properly needs both gateways warm and alternating **under one
 * broadcast**, because two soaks compared against each other is the between-sitting confound the
 * interleaved GOP arms just caught.
 *
 * `bundle.test.ts` covers the shipping direction, that a production build carries no handle at all.
 * These cover the instrumented direction and the lifetime, which a build cannot show.
 */

const holder = globalThis as unknown as { [GATEWAY_HANDLE]?: GatewaySwitch };

function aSwitch(url = 'http://gateway-a:1733'): GatewaySwitch {
  return { current: () => url, select: vi.fn() };
}

afterEach(() => {
  delete holder[GATEWAY_HANDLE];
  vi.unstubAllEnvs();
});

describe('the gateway switch a measurement harness drives', () => {
  it('publishes nothing when the build did not ask for instrumentation', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '');

    const detach = exposeGatewayForInstrumentation(aSwitch());

    expect(detach).toBeNull();
    expect(holder[GATEWAY_HANDLE]).toBeUndefined();
  });

  it('publishes the switch when it did', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');
    const gatewaySwitch = aSwitch('http://gateway-a:1733');

    exposeGatewayForInstrumentation(gatewaySwitch);

    expect(holder[GATEWAY_HANDLE]?.current()).toBe('http://gateway-a:1733');
  });

  it('drives the real switch rather than a copy of the url', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');
    const gatewaySwitch = aSwitch();

    exposeGatewayForInstrumentation(gatewaySwitch);
    holder[GATEWAY_HANDLE]?.select('http://gateway-b:1733');

    // The client's own setter is what resets the catalog reader and marks manifests dirty, so a
    // handle that only recorded a string would leave the next fetch going to the old node.
    expect(gatewaySwitch.select).toHaveBeenCalledWith('http://gateway-b:1733');
  });

  it('withdraws the switch on detach', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');

    const detach = exposeGatewayForInstrumentation(aSwitch());
    detach?.();

    expect(holder[GATEWAY_HANDLE]).toBeUndefined();
  });

  /**
   * ⛔ React publishes a remounted provider's switch before it runs the old one's cleanup. An
   * unconditional delete there would withdraw the live switch and leave a harness holding nothing
   * partway through an arm, which reads as an arm that refused to change gateway rather than as a
   * teardown ordering bug.
   */
  it('leaves a newer switch alone when an older one detaches', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');
    const older = aSwitch('http://older:1733');
    const newer = aSwitch('http://newer:1733');

    const detachOlder = exposeGatewayForInstrumentation(older);
    exposeGatewayForInstrumentation(newer);
    detachOlder?.();

    expect(holder[GATEWAY_HANDLE]?.current()).toBe('http://newer:1733');
  });
});
