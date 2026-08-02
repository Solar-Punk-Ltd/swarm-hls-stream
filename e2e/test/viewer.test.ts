import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { type E2EConfig, loadConfig } from '../src/config.js';
import type { Host } from '../src/harness/host.js';
import { type CatalogEntry, discoverCatalogFeed, fetchCatalog } from '../src/harness/viewer.js';

/**
 * The catalog feed is located by reading the uploader's own log rather than by hard-coding a
 * deployment's owner and topic. That keeps the suite portable and makes this regex the thing
 * standing between a scenario and the wrong feed: a near-miss does not fail, it points the viewer
 * assertions at a feed belonging to something else.
 */

const roots: string[] = [];

after(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function config(env: NodeJS.ProcessEnv = {}): E2EConfig {
  const rootDir = mkdtempSync(join(tmpdir(), 'e2e-viewer-'));
  roots.push(rootDir);
  return loadConfig({ env, rootDir });
}

interface HostCall {
  readonly container?: string;
  readonly tail?: number;
  readonly port?: number;
  readonly path?: string;
}

/** A Host that answers with canned text and records what it was asked for. */
function stubHost(logs: string, json: unknown = []): { host: Host; calls: HostCall[] } {
  const calls: HostCall[] = [];
  const host = {
    logs: async (container: string, tail: number) => {
      calls.push({ container, tail });
      return logs;
    },
    localJson: async (port: number, path: string) => {
      calls.push({ port, path });
      return json;
    },
  } as unknown as Host;
  return { host, calls };
}

const OWNER = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const TOPIC_HEX = '0'.repeat(64).slice(0, 62) + 'ab';

/** The line `StreamCatalog` logs after every feed write, which is the one the harness reads. */
function feedUpdatedLine(owner: string, topicHex: string, index = 12): string {
  return (
    `[2026-08-02T09:14:05.123Z] [DEBUG] - [StreamCatalog] Feed updated index=${index} entries=3 ` +
    `bytes=512 ref=9f8e7d owner=${owner} topicHex=${topicHex}`
  );
}

/** The line `StreamCatalog` logs at construction, which carries the same pair. */
function initLine(owner: string, topicHex: string): string {
  return (
    `[2026-08-02T09:14:01.000Z] [DEBUG] - [StreamCatalog] bee=http://bee-uploader:1633 owner=${owner} ` +
    `topic="swarm-stream" topicHex=${topicHex} stamp=0123456789ab…`
  );
}

describe('discoverCatalogFeed', () => {
  it('reads the owner and topic out of a feed-updated line', async () => {
    const { host } = stubHost(feedUpdatedLine(OWNER, TOPIC_HEX));
    assert.deepEqual(await discoverCatalogFeed(host, config()), { owner: OWNER, topicHex: TOPIC_HEX });
  });

  it('reads them out of the construction line too', async () => {
    const { host } = stubHost(initLine(OWNER, TOPIC_HEX));
    assert.deepEqual(await discoverCatalogFeed(host, config()), { owner: OWNER, topicHex: TOPIC_HEX });
  });

  /**
   * The last match wins on purpose. A container restarted mid-suite logs its construction line
   * again, and an earlier line can name the feed of a previous deployment on the same host, which
   * would send every viewer assertion to a feed that is not this run.
   */
  it('takes the most recent line when the log holds several', async () => {
    const older = 'f'.repeat(40);
    const { host } = stubHost([initLine(older, TOPIC_HEX), feedUpdatedLine(OWNER, TOPIC_HEX)].join('\n'));
    assert.equal((await discoverCatalogFeed(host, config())).owner, OWNER);
  });

  it('asks the profile-scoped uploader container', async () => {
    const { host, calls } = stubHost(feedUpdatedLine(OWNER, TOPIC_HEX));
    await discoverCatalogFeed(host, config({ E2E_PROFILE: 'streamer1' }), 500);
    assert.deepEqual(calls, [{ container: 'streamer1-stream-uploader-1', tail: 500 }]);
  });

  // Failing loudly matters more than usual here: the alternative to "no line" is not a wrong
  // answer, it is `undefined` reaching every downstream comparison as a silent mismatch.
  it('throws when the log holds no catalog line', async () => {
    const { host } = stubHost('[2026-08-02T09:14:05.123Z] [LOG] - Segment 0 uploaded: bzz://a1b2c3');
    await assert.rejects(discoverCatalogFeed(host, config()), /no \[StreamCatalog\]/);
  });

  /**
   * A length-sensitive pattern, because both fields are fixed-width hex. An owner that is a
   * character short is not a different owner, it is a truncated line, and matching it anyway would
   * hand back a feed address that cannot resolve.
   */
  it('refuses a truncated owner or topic', async () => {
    for (const line of [
      feedUpdatedLine(OWNER.slice(0, 39), TOPIC_HEX),
      feedUpdatedLine(OWNER, TOPIC_HEX.slice(0, 63)),
    ]) {
      const { host } = stubHost(line);
      await assert.rejects(discoverCatalogFeed(host, config()), /no \[StreamCatalog\]/);
    }
  });

  // The uploader logs the owner without a `0x` prefix, and the pattern requires the hex to start
  // immediately. Pinned because the entry the catalog itself carries IS `0x`-prefixed, so the two
  // spellings live a few lines apart in the uploader.
  it('does not match a 0x-prefixed owner, which is the other spelling in the uploader', async () => {
    const { host } = stubHost(feedUpdatedLine(`0x${OWNER}`, TOPIC_HEX));
    await assert.rejects(discoverCatalogFeed(host, config()), /no \[StreamCatalog\]/);
  });
});

describe('fetchCatalog', () => {
  const entries: CatalogEntry[] = [
    {
      title: '2026-08-02 09:14',
      owner: `0x${OWNER}`,
      topic: 'topic-a',
      state: 'live',
      index: 3,
      mediatype: 'video',
      timestamp: 1786000445123,
    },
  ];

  // Through the bee-GATEWAY, not the uploader's own bee. That is the player-visible path, and
  // reading the uploader's node instead would assert something no viewer can see.
  it('reads the feed from the gateway port', async () => {
    const { host, calls } = stubHost('', entries);
    const cfg = config({ E2E_PORT_SLOT: '2' });
    assert.deepEqual(await fetchCatalog(host, cfg, { owner: OWNER, topicHex: TOPIC_HEX }), entries);
    assert.deepEqual(calls, [{ port: 10027, path: `/feeds/${OWNER}/${TOPIC_HEX}` }]);
  });
});
