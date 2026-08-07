import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { describe, expect, it } from 'vitest';

import { CatalogFeedReader } from '@/utils/catalogFeed';
import type { TimedResponse } from '@/utils/fetchWithTimeout';

/**
 * That the catalog is followed by walking rather than by resolving its head on every poll.
 *
 * The catalog is polled every five seconds forever, gains a slot per broadcast lifecycle event, and
 * is never reset. Resolving the head each time costs a lookup that grows with the feed: measured at
 * about 1s on a one slot feed and 5s at a thousand, against 4ms for a slot read by address. Past a
 * few hundred events the poll no longer fits inside its own interval.
 *
 * These drive the reader against a stubbed fetcher and assert on the URLs it asks for, because the
 * whole change is *which request is made*, and a test that only checked the returned body would pass
 * against the version that never stopped resolving the head.
 */

const OWNER = '1f6e0f8a9b7c3d5e2a4b6c8d0e1f2a3b4c5d6e7f';
const TOPIC = Topic.fromString('catalog-test');

function respond(overrides: Partial<TimedResponse> = {}): TimedResponse {
  return { ok: true, status: 200, headers: new Headers(), text: '[]', ...overrides };
}

/**
 * A stub that records every URL and answers from a queue, so ordering is assertable.
 *
 * A queued `Error` is thrown rather than returned, which is how a transport failure or a timeout
 * reaches the reader. That is a different path from `ok: false`, and only the latter was ever driven.
 */
function stubFetcher(replies: (TimedResponse | Error)[]) {
  const urls: string[] = [];
  const fetcher = async (url: string): Promise<TimedResponse> => {
    urls.push(url);
    const reply = replies.shift();
    if (!reply) {
      throw new Error(`unexpected request to ${url}`);
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  };
  return { urls, fetcher: fetcher as never };
}

function headerFor(index: number): Headers {
  // Hexadecimal and zero padded, which is how a gateway sends it. Decimal here would pass for every
  // index under sixteen and diverge silently after.
  return new Headers({ 'swarm-feed-index': index.toString(16).padStart(16, '0') });
}

describe('CatalogFeedReader', () => {
  it('resolves the head once and then never again', async () => {
    const { urls, fetcher } = stubFetcher([
      respond({ headers: headerFor(41), text: '[{"a":1}]' }),
      respond({ ok: false, status: 404 }),
      respond({ ok: false, status: 404 }),
    ]);
    const reader = new CatalogFeedReader(OWNER, TOPIC, fetcher);

    await reader.read('http://gw');
    await reader.read('http://gw');
    await reader.read('http://gw');

    expect(urls.filter((url) => url.includes('/feeds/'))).toHaveLength(1);
    expect(urls[0]).toContain(`/feeds/${OWNER}/`);
    expect(urls[1]).toContain(`/soc/${OWNER}/`);
    expect(urls[2]).toContain(`/soc/${OWNER}/`);
  });

  it('takes its position from the header rather than from counting', async () => {
    // 0x22 is 34. A reader that parsed this as decimal would walk from 23 and ask for slots that were
    // written long ago, which reads as a catalog frozen eleven broadcasts in the past.
    const { fetcher } = stubFetcher([respond({ headers: new Headers({ 'swarm-feed-index': '0000000000000022' }) })]);
    const reader = new CatalogFeedReader(OWNER, TOPIC, fetcher);

    await reader.read('http://gw');

    expect(reader.getIndex()?.toBigInt()).toBe(34n);
  });

  it('reports nothing new as null rather than repeating the last body', async () => {
    const { fetcher } = stubFetcher([
      respond({ headers: headerFor(3), text: '[{"live":true}]' }),
      respond({ ok: false, status: 404 }),
    ]);
    const reader = new CatalogFeedReader(OWNER, TOPIC, fetcher);

    expect(await reader.read('http://gw')).toBe('[{"live":true}]');
    expect(await reader.read('http://gw')).toBeNull();
  });

  /**
   * The property that stops a follower falling permanently behind.
   *
   * Advancing one slot per poll gives a catch-up rate equal to the poll rate, so a reader that drops
   * behind never recovers. This is the same shape that made the bench unable to measure a quarter
   * second GOP, found the expensive way on 2026-08-05.
   */
  it('walks past several new slots in one read, so it can catch up', async () => {
    const { urls, fetcher } = stubFetcher([
      respond({ headers: headerFor(0), text: '[0]' }),
      respond({ text: '[1]' }),
      respond({ text: '[2]' }),
      respond({ text: '[3]' }),
      respond({ ok: false, status: 404 }),
    ]);
    const reader = new CatalogFeedReader(OWNER, TOPIC, fetcher);

    await reader.read('http://gw');
    const caughtUp = await reader.read('http://gw');

    expect(caughtUp).toBe('[3]');
    expect(reader.getIndex()?.toBigInt()).toBe(3n);
    expect(urls).toHaveLength(5);
  });

  it('stops walking at the bound rather than holding the page open', async () => {
    const replies = [respond({ headers: headerFor(0) })];
    for (let i = 0; i < 100; i++) {
      replies.push(respond({ text: `[${i}]` }));
    }
    const { urls, fetcher } = stubFetcher(replies);
    const reader = new CatalogFeedReader(OWNER, TOPIC, fetcher);

    await reader.read('http://gw');
    await reader.read('http://gw');

    // One head plus the walk bound, and it resumes from there on the next poll rather than looping.
    expect(urls).toHaveLength(33);
  });

  it('keeps the body when the header is unreadable, and resolves the head again next time', async () => {
    const { urls, fetcher } = stubFetcher([
      respond({ headers: new Headers(), text: '[{"a":1}]' }),
      respond({ headers: headerFor(7), text: '[{"a":2}]' }),
    ]);
    const reader = new CatalogFeedReader(OWNER, TOPIC, fetcher);

    expect(await reader.read('http://gw')).toBe('[{"a":1}]');
    expect(reader.getIndex()).toBeNull();
    await reader.read('http://gw');

    expect(urls[1]).toContain('/feeds/');
  });

  it('forgets its position on reset, since another gateway has its own view of the feed', async () => {
    const { urls, fetcher } = stubFetcher([respond({ headers: headerFor(5) }), respond({ headers: headerFor(9) })]);
    const reader = new CatalogFeedReader(OWNER, TOPIC, fetcher);

    await reader.read('http://gw-a');
    reader.reset();
    await reader.read('http://gw-b');

    expect(urls[1]).toContain('/feeds/');
    expect(reader.getIndex()?.toBigInt()).toBe(9n);
  });

  it('treats a failed head lookup as nothing to show rather than a position', async () => {
    const { fetcher } = stubFetcher([respond({ ok: false, status: 500 })]);
    const reader = new CatalogFeedReader(OWNER, TOPIC, fetcher);

    expect(await reader.read('http://gw')).toBeNull();
    expect(reader.getIndex()).toBeNull();
  });

  /**
   * A throw is a different shape from a refusal, and only the refusal was handled. `this.index` is
   * committed per slot inside the walk while the body is returned after it, so a rejection used to
   * drop a snapshot that had already been fetched and keep the index that consumed it. Each slot
   * carries the whole catalog rather than a delta, so the broadcast announced in the dropped slot was
   * never offered to this reader again.
   *
   * `fetchWithTimeout` rejects on a transport failure and on its own timeout, and answers `ok: false`
   * only for an HTTP status, so this is the ordinary shape of a gateway going slow mid-walk.
   */
  it('keeps the slot it already read when a later step of the same walk throws', async () => {
    const { fetcher } = stubFetcher([
      respond({ headers: headerFor(7) }),
      respond({ text: '[{"live":true}]' }),
      // Deliberately not `ok: false`. The refusal path was always handled, and a test that used one
      // here would pass against the version this covers.
      new Error('socket hang up') as never,
    ]);
    const reader = new CatalogFeedReader(OWNER, TOPIC, fetcher);

    await reader.read('http://gw');

    expect(await reader.read('http://gw')).toBe('[{"live":true}]');
    // The position and the body have to agree: index 8 is the slot the returned body came from.
    expect(reader.getIndex()?.toBigInt()).toBe(8n);
  });

  it('still raises when the first step of a walk throws, so a dead gateway is not read as an idle catalog', async () => {
    const { fetcher } = stubFetcher([respond({ headers: headerFor(7) }), new Error('socket hang up') as never]);
    const reader = new CatalogFeedReader(OWNER, TOPIC, fetcher);

    await reader.read('http://gw');

    await expect(reader.read('http://gw')).rejects.toThrow('socket hang up');
    expect(reader.getIndex()?.toBigInt()).toBe(7n);
  });
});
