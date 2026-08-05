import { Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import {
  DEFAULT_FEED_READER,
  FEED_BLACKOUT_LIMIT_MS,
  FeedFollower,
  gatewayHealthProblem,
  GatewayStatusError,
  isFeedBlackout,
  isFeedPendingFirstWrite,
  MAX_WALK_PER_READ,
  parseFeedReaderMode,
  resolvedFeedIndex,
  segmentRefFromUri,
} from '../src/bench/gateway.js';

/**
 * The one status that means "not yet" rather than "wrong".
 *
 * A Swarm feed answers 404 until its first update is written, and the uploader writes that only after
 * the first segment has closed and uploaded. The bench starts polling the moment the publisher is up,
 * so the very first read of a run can land in that window: on 2026-08-03 four of five 1080p runs at a
 * one-second GOP died there, on four different topics, with the deployment healthy throughout.
 */
describe('telling a feed that has not been written yet from one that broke', () => {
  it('waits out a 404 the first time, because a feed with no updates has nothing to serve', () => {
    assert.equal(isFeedPendingFirstWrite(new GatewayStatusError('http://gw/feeds/o/t', 404), false), true);
  });

  /**
   * The half that keeps the tolerance narrow. Polling through every 404 would turn a feed that
   * vanished mid-run into a run that quietly collected fewer samples than it was asked for.
   */
  it('fails on a 404 once the feed has answered, since that is a disappearance', () => {
    assert.equal(isFeedPendingFirstWrite(new GatewayStatusError('http://gw/feeds/o/t', 404), true), false);
  });

  it('fails on any other status, waited for or not', () => {
    assert.equal(isFeedPendingFirstWrite(new GatewayStatusError('http://gw/feeds/o/t', 500), false), false);
    assert.equal(isFeedPendingFirstWrite(new GatewayStatusError('http://gw/feeds/o/t', 403), false), false);
  });

  /** A timeout and a refused connection arrive as plain errors, and neither is a feed saying "not yet". */
  it('fails on an error that carries no status at all', () => {
    assert.equal(isFeedPendingFirstWrite(new Error('The operation was aborted due to timeout'), false), false);
  });
});

/**
 * The uploader writes absolute segment URIs built from its own bee url, so a manifest entry looks
 * like `http://10.0.0.4:1633/bytes/<ref>`. The bench, like the client, keeps only the reference and
 * re-hosts it against the gateway a viewer is actually configured with. Taking the whole URI instead
 * would send every fetch to the uploader's private bee, which measures a path no viewer takes and on
 * most deployments is not reachable from here at all.
 */
describe('taking the reference out of a manifest entry', () => {
  const ref = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

  it('reads an absolute uri as the uploader writes it', () => {
    assert.equal(segmentRefFromUri(`http://10.0.0.4:1633/bytes/${ref}`), ref);
  });

  it('reads a bare reference, which is what an uploader with no bee url configured emits', () => {
    assert.equal(segmentRefFromUri(ref), ref);
  });

  it('ignores a query string rather than folding it into the reference', () => {
    assert.equal(segmentRefFromUri(`http://host:1633/bytes/${ref}?redundancy=1`), ref);
  });

  it('ignores a trailing slash rather than reading the reference as empty', () => {
    assert.equal(segmentRefFromUri(`http://host:1633/bytes/${ref}/`), ref);
  });

  it('reads an encrypted reference, which is twice as long', () => {
    assert.equal(segmentRefFromUri(`http://host:1633/bytes/${ref}${ref}`), `${ref}${ref}`);
  });

  /**
   * The shape has to be checked, not just the position. Taking the last path element of a URI with
   * no path yields the host and port, which would then be fetched as `/bytes/host:1633` and 404 —
   * a failure an operator would spend the run blaming the gateway for.
   */
  it('reports nothing for a uri with no path at all, rather than the host and port', () => {
    assert.equal(segmentRefFromUri('http://host:1633/'), null);
  });

  it('reports nothing for an entry that is not a reference', () => {
    assert.equal(segmentRefFromUri('http://host:1633/bytes/not-a-reference'), null);
  });

  it('reports nothing for a reference of the wrong width', () => {
    assert.equal(segmentRefFromUri(`http://host:1633/bytes/${ref.slice(0, 32)}`), null);
  });

  it('reports nothing for an empty entry', () => {
    assert.equal(segmentRefFromUri(''), null);
  });
});

/**
 * `Swarm-Feed-Index` is the gateway's answer to "which update did I resolve this feed to", and it is
 * the difference between knowing a feed stopped advancing and knowing why.
 *
 * The 2026-08-03 long run found the feed frozen for 29 to 48 seconds at a time, 57% of a twenty
 * minute broadcast, while the uploader wrote 96 manifests inside one of those windows with no error.
 * Comparing manifest bodies says only that nothing changed. The index says what the reader was stuck
 * on and how far it jumped when it moved, which is the whole shape of the fault.
 */
describe('the feed index the gateway resolved to', () => {
  it('reads the header as the hexadecimal the gateway writes', () => {
    assert.equal(resolvedFeedIndex(new Headers({ 'swarm-feed-index': '0000000000000966' })), 2_406);
  });

  it('reads a small index, where hex and decimal would disagree', () => {
    assert.equal(resolvedFeedIndex(new Headers({ 'swarm-feed-index': '0000000000000022' })), 34);
  });

  /**
   * A gateway that does not send it is not a failure to report. Older Bee versions and any proxy in
   * front of one may drop it, and a run that threw here would lose every latency figure it had over
   * a diagnostic column.
   */
  it('answers null rather than throwing when the gateway does not send it', () => {
    assert.equal(resolvedFeedIndex(new Headers()), null);
  });

  it('answers null for a header that is not a number, rather than NaN', () => {
    assert.equal(resolvedFeedIndex(new Headers({ 'swarm-feed-index': 'not-hex' })), null);
  });
});

/**
 * The preflight exists so a run fails for free rather than after the postage is spent, and it did
 * exactly that on 2026-08-03 when the bench was pointed at a public Swarm gateway. But it refused for
 * the wrong reason: the public gateway answers `/health` with the plain text `OK` rather than a bee
 * node's JSON, and it serves the feed API perfectly well.
 *
 * That matters now rather than in the abstract. LAT-10's only no-cost mitigation is to point viewers
 * at a different gateway, and a bench that can only measure a bee node cannot measure whether the
 * mitigation works.
 */
describe('what counts as a reachable viewer gateway', () => {
  it('accepts a bee node, which answers /health with a status', () => {
    assert.equal(gatewayHealthProblem('{"status":"ok","version":"2.8.1"}'), null);
  });

  it('accepts a gateway that answers OK, which is what the public ones do', () => {
    assert.equal(gatewayHealthProblem('OK'), null);
  });

  /**
   * The case the guard was written for and still has to catch: a port that is open and serving
   * something else entirely. Refusing this is the whole reason the preflight runs before the publish.
   */
  it('refuses a port serving something that is not a gateway at all', () => {
    assert.match(gatewayHealthProblem('<!DOCTYPE html><title>nginx</title>') ?? '', /not a gateway/);
  });

  it('refuses an empty answer, which a proxy can give for a dead upstream', () => {
    assert.match(gatewayHealthProblem('   ') ?? '', /not a gateway/);
  });
});

/**
 * The rule that decides whether a run of failing feed polls is a measurement or a dead gateway.
 *
 * A failed feed poll used to end the run outright, and that was wrong twice over. It discarded every
 * sample already collected, at the cost of a real broadcast and real postage. And what triggered it
 * was the very thing the run exists to measure: LAT-10 is feed polls being slow, so a poll slow
 * enough to exceed the timeout is the strongest sample of the effect there is, and it was the one
 * sample guaranteed to destroy the run. A 34-minute run died this way on 2026-08-04 with 30 minutes
 * of good samples in hand.
 *
 * Treating every failure as data has the opposite failure mode, though, which is why the limit
 * exists: a gateway that is simply down would otherwise be reported as a feed frozen for the whole
 * broadcast, and that is a wrong answer wearing the shape of a finding.
 */
describe('telling a slow feed from a gateway that has gone', () => {
  it('keeps measuring through a failure well inside the limit', () => {
    assert.equal(isFeedBlackout(15_000), false);
  });

  /**
   * The freeze under study runs 30 to 45s on a 63s cycle, so the limit has to clear a whole cycle of
   * it comfortably or the instrument would call the effect a dead gateway.
   */
  it('keeps measuring across a full freeze cycle', () => {
    assert.equal(isFeedBlackout(63_000), false);
  });

  it('gives up once nothing has answered for the whole limit', () => {
    assert.equal(isFeedBlackout(FEED_BLACKOUT_LIMIT_MS), true);
  });

  it('gives up past the limit as well as at it', () => {
    assert.equal(isFeedBlackout(FEED_BLACKOUT_LIMIT_MS + 1), true);
  });

  /** Asserted against the freeze it must survive rather than against itself, so the constant is real. */
  it('leaves room for more than two freeze cycles before giving up', () => {
    assert.ok(FEED_BLACKOUT_LIMIT_MS > 2 * 63_000);
  });
});

/**
 * The defect this bench shipped with, stated as a test.
 *
 * `collectSamples` resolved the feed with `GET /feeds/{owner}/{topic}` on every poll. The player asks
 * for that once, on mount, and walks explicit slot addresses after it. The two are not close:
 * measured 2026-08-04 against a synthetic feed advancing one slot per second, the head lookup was 50
 * to 57% frozen with responses of 1.0 to 7.0 seconds, while an explicit-address reader riding the
 * live edge was 0.2% frozen at 46ms. It fails identically against the node holding every chunk
 * locally, so it is the lookup and not retrieval.
 *
 * The whole of LAT-10 was built on frozen shares this instrument produced, which means they described
 * the instrument. Nothing here could have caught that, because nothing asserted which request the
 * bench makes.
 */
describe('following the feed the way the player does (LAT-10)', () => {
  /** Records every path asked for, and answers a feed that is one slot ahead of wherever it is asked. */
  async function stubGateway(
    answer: (path: string) => { status: number; body?: string; headers?: Record<string, string> },
  ) {
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(req.url ?? '');
      const { status, body = '', headers = {} } = answer(req.url ?? '');
      res.writeHead(status, headers);
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { asked, url: `http://127.0.0.1:${port}`, close: () => server.close() };
  }

  const OWNER = '1111111111111111111111111111111111111111';
  const TOPIC_HEX = Topic.fromString('lat10').toString();
  const MANIFEST = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://bee/bytes/' + 'a'.repeat(64);

  /**
   * The assertion that would have caught it. One head lookup for the whole run, however many polls.
   *
   * Written against the count rather than the ratio because a bench polling a live broadcast makes
   * hundreds of reads, and "mostly not the head" is exactly what a viewer does not experience.
   */
  it('resolves the head once and never again', async () => {
    // Nothing after the anchor is written, so this measures the anchor alone rather than the walk.
    const gw = await stubGateway((path) =>
      path.startsWith('/feeds/')
        ? { status: 200, body: MANIFEST, headers: { 'swarm-feed-index': '5' } }
        : { status: 404 },
    );
    try {
      const follower = new FeedFollower(gw.url, OWNER, TOPIC_HEX, 'walk');
      for (let poll = 0; poll < 5; poll++) {
        await follower.read();
      }

      const headLookups = gw.asked.filter((path) => path.startsWith('/feeds/'));
      assert.equal(headLookups.length, 1, `the head was resolved ${headLookups.length} times: ${gw.asked.join(' ')}`);
      assert.equal(gw.asked.length, 5, `a caught-up poll cost more than one request: ${gw.asked.join(' ')}`);
    } finally {
      gw.close();
    }
  });

  /**
   * ⛔ **The defect that made the 0.25s rows measure the instrument, and the reason they are retracted.**
   *
   * A follower advancing one slot per read has a catch-up rate equal to its read rate, so once it
   * falls behind it never recovers and every later reading is its own accumulated lag rather than the
   * viewer's latency. The collection loop pays a segment fetch between reads, which at a 0.25s GOP is
   * ~260ms against the 250ms the publisher takes to write the next slot, so it falls behind by
   * construction and the shortfall compounds for the length of the run.
   *
   * The same shape was found and fixed in the client's catalog reader on the same day. It was written
   * down there as a property not to ship, and it was already shipped here.
   */
  it('catches up to the live edge in one read rather than one slot per read', async () => {
    const written = 5 + 8;
    let served = 0;
    const gw = await stubGateway((path) => {
      if (path.startsWith('/feeds/')) {
        return { status: 200, body: `${MANIFEST}5`, headers: { 'swarm-feed-index': '5' } };
      }
      // Answers while the walk is inside what the publisher has written, then stops. The follower
      // cannot know how many that is, which is the point: it walks until a slot is missing.
      served += 1;
      return served <= written - 5 ? { status: 200, body: `${MANIFEST}${5 + served}` } : { status: 404 };
    });
    try {
      const follower = new FeedFollower(gw.url, OWNER, TOPIC_HEX, 'walk');
      await follower.read();
      const caughtUp = await follower.read();

      assert.equal(caughtUp.resolvedIndex, written, `one read reached slot ${caughtUp.resolvedIndex}, not ${written}`);
      assert.equal(caughtUp.body, `${MANIFEST}${written}`, 'the read returned an older manifest than it walked to');
    } finally {
      gw.close();
    }
  });

  /**
   * The bound is what keeps a catch-up from becoming an unbounded stall. A feed that answers every
   * slot forever, which is what a misconfigured gateway or a replayed fixture looks like, must not
   * hold one read open indefinitely.
   */
  it('stops walking at the bound rather than reading a feed without end', async () => {
    const gw = await stubGateway((path) =>
      path.startsWith('/feeds/')
        ? { status: 200, body: MANIFEST, headers: { 'swarm-feed-index': '5' } }
        : { status: 200, body: MANIFEST },
    );
    try {
      const follower = new FeedFollower(gw.url, OWNER, TOPIC_HEX, 'walk');
      await follower.read();
      await follower.read();

      const slotReads = gw.asked.filter((path) => path.startsWith('/soc/'));
      assert.equal(slotReads.length, MAX_WALK_PER_READ, `one read made ${slotReads.length} slot reads`);
    } finally {
      gw.close();
    }
  });

  /**
   * A poll that finds nothing new has to look like a poll that found nothing new, not like a failure.
   * `feedProgress` counts a repeated `newestRef` as a stall, so returning the previous manifest is
   * what keeps a genuine freeze measurable rather than turning it into a dead run.
   */
  it('answers with the previous manifest when the publisher has not written the next slot', async () => {
    let served = 0;
    const gw = await stubGateway((path) => {
      if (path.startsWith('/feeds/')) {
        return { status: 200, body: MANIFEST, headers: { 'swarm-feed-index': '5' } };
      }
      served += 1;
      return served === 1 ? { status: 200, body: MANIFEST } : { status: 404 };
    });
    try {
      const follower = new FeedFollower(gw.url, OWNER, TOPIC_HEX, 'walk');
      await follower.read();
      const advanced = await follower.read();
      const stalled = await follower.read();

      assert.equal(stalled.body, advanced.body, 'a slot the publisher has not written yet lost the manifest');
      assert.equal(stalled.resolvedIndex, advanced.resolvedIndex, 'an unwritten slot advanced the index');
      assert.ok(stalled.atMs >= advanced.atMs, 'the stalled poll was not stamped when it happened');
    } finally {
      gw.close();
    }
  });

  /**
   * The escape hatch has to work, or the instrument's own contribution can only be argued about. This
   * is the mode that produced every frozen share LAT-10 was built on.
   */
  it('still resolves the head on every poll in head mode', async () => {
    const gw = await stubGateway(() => ({
      status: 200,
      body: MANIFEST,
      headers: { 'swarm-feed-index': '5' },
    }));
    try {
      const follower = new FeedFollower(gw.url, OWNER, TOPIC_HEX, 'head');
      for (let poll = 0; poll < 3; poll++) {
        await follower.read();
      }

      assert.equal(gw.asked.filter((path) => path.startsWith('/feeds/')).length, 3);
    } finally {
      gw.close();
    }
  });

  it('defaults to walking, so a caller that says nothing measures the viewer', () => {
    assert.equal(parseFeedReaderMode(undefined), 'walk');
    assert.equal(DEFAULT_FEED_READER, 'walk');
  });

  it('refuses a mode it does not have, rather than silently walking', () => {
    assert.throws(() => parseFeedReaderMode('latest'), /must be 'walk' or 'head'/);
  });
});
