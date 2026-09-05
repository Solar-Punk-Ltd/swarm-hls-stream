import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { BeePublisherPool, parsePublisherSpecs, SINGLE_PUBLISHER } from '../src/libs/BeePublisherPool.js';
import { getErrorMessage } from '../src/utils/common.js';

import { LOOPBACK_HOST } from './helpers/loopbackServer.js';

const BATCH = {
  '360p': '1'.repeat(64),
  '480p': '2'.repeat(64),
  '720p': '3'.repeat(64),
  '1080p': '4'.repeat(64),
};

/** Ascending by height, which is what AbrLadder.rungs() hands over. */
const RUNG_ORDER = ['360p', '480p', '720p', '1080p'];

/**
 * Every pooled node is built with a request deadline, so every case has to name one. What it is only
 * matters to the cases below that make a real request, which pass their own.
 */
const ANY_TIMEOUT_MS = 5_000;

const spec = (rung: keyof typeof BATCH, port: number) => ({
  rung,
  url: `http://localhost:${port}`,
  stamp: BATCH[rung],
});

describe('parsePublisherSpecs', () => {
  it('parses one entry per rung', () => {
    const specs = parsePublisherSpecs(
      `360p@http://localhost:1633<${BATCH['360p']}> 1080p@http://localhost:1663<${BATCH['1080p']}>`,
    );

    assert.deepEqual(specs, [
      { rung: '360p', url: 'http://localhost:1633', stamp: BATCH['360p'] },
      { rung: '1080p', url: 'http://localhost:1663', stamp: BATCH['1080p'] },
    ]);
  });

  it('treats an unset variable as the single-node deployment rather than an error', () => {
    assert.deepEqual(parsePublisherSpecs(''), []);
    assert.deepEqual(parsePublisherSpecs('   \n  '), []);
  });

  it('tolerates arbitrary whitespace between entries, as ABR_LADDER does', () => {
    const specs = parsePublisherSpecs(
      `  360p@http://a.example<${BATCH['360p']}>\n  720p@http://b.example<${BATCH['720p']}>  `,
    );

    assert.deepEqual(
      specs.map((s) => s.rung),
      ['360p', '720p'],
    );
  });

  it('keeps a URL that carries a port and a path intact', () => {
    // Split on the first @ and the last bracket, so neither a port's colon nor a path's slashes
    // are mistaken for a delimiter.
    const [parsed] = parsePublisherSpecs(`720p@https://bee.example:1633/api<${BATCH['720p']}>`);

    assert.equal(parsed.url, 'https://bee.example:1633/api');
    assert.equal(parsed.stamp, BATCH['720p']);
  });

  it('rejects an entry that is not rung@url<batch>', () => {
    assert.throws(() => parsePublisherSpecs('360p'), /must be rung@url<batch>/);
    assert.throws(() => parsePublisherSpecs('360p@http://a.example'), /must be rung@url<batch>/);
    assert.throws(() => parsePublisherSpecs(`@http://a.example<${BATCH['360p']}>`), /must be rung@url<batch>/);
    assert.throws(() => parsePublisherSpecs('360p@http://a.example<>'), /must be rung@url<batch>/);
  });

  it('still reads the older # form, so an existing config keeps working', () => {
    assert.deepEqual(parsePublisherSpecs(`360p@http://localhost:1633#${BATCH['360p']}`), [
      { rung: '360p', url: 'http://localhost:1633', stamp: BATCH['360p'] },
    ]);
  });

  it('survives a value dotenv has truncated at a #, by not needing one', () => {
    // The bug the brackets exist for. `#` opens a comment in a .env file, so an unquoted
    // BEE_PUBLISHERS lost everything from the first one and the parser was handed a bare URL —
    // reporting a string the operator had never typed. Brackets are not special to dotenv.
    const asDotenvWouldTruncateIt = '360p@http://localhost:1633';
    assert.throws(() => parsePublisherSpecs(asDotenvWouldTruncateIt), /must be rung@url<batch>/);
    assert.doesNotThrow(() => parsePublisherSpecs(`360p@http://localhost:1633<${BATCH['360p']}>`));
  });

  it('rejects a batch id that is not 32 bytes of hex', () => {
    // The failure this prevents is a truncated paste: Bee would reject every upload at runtime,
    // hours into a stream, with nothing pointing back at the config.
    assert.throws(() => parsePublisherSpecs('360p@http://a.example<abc123>'), /must be 64 hex characters/);
    assert.throws(() => parsePublisherSpecs(`360p@http://a.example<${'z'.repeat(64)}>`), /must be 64 hex characters/);
  });

  it('rejects a url that is not http or https', () => {
    assert.throws(() => parsePublisherSpecs(`360p@localhost:1633<${BATCH['360p']}>`), /must be http or https/);
    assert.throws(() => parsePublisherSpecs(`360p@not a url<${BATCH['360p']}>`), /must be rung@url<batch>/);
  });

  it('rejects a rung name that could not survive being spliced into a config', () => {
    assert.throws(() => parsePublisherSpecs(`360p;evil@http://a.example<${BATCH['360p']}>`), /must match/);
  });

  it('rejects two nodes for the same rung', () => {
    assert.throws(
      () => parsePublisherSpecs(`360p@http://a.example<${BATCH['360p']}> 360p@http://b.example<${BATCH['480p']}>`),
      /two nodes for rung "360p"/,
    );
  });
});

describe('BeePublisherPool.single', () => {
  const pool = BeePublisherPool.single('http://localhost:1633', BATCH['360p'], ANY_TIMEOUT_MS);

  it('serves every rung from the one node, which is today’s behaviour unchanged', () => {
    for (const rung of RUNG_ORDER) {
      const publisher = pool.forRung(rung);
      assert.equal(publisher.url, 'http://localhost:1633');
      assert.equal(publisher.stamp, BATCH['360p']);
      assert.equal(publisher.rung, SINGLE_PUBLISHER);
    }
  });

  it('coordinates through that same node', () => {
    assert.equal(pool.coordinator().url, 'http://localhost:1633');
  });

  it('does not warn its way to a fallback for an unknown rung — there is nothing else', () => {
    assert.equal(pool.forRung('2160p').rung, SINGLE_PUBLISHER);
  });

  it('refuses a truncated stamp at startup, exactly as the split path does', () => {
    assert.throws(
      () => BeePublisherPool.single('http://localhost:1633', 'abc123', ANY_TIMEOUT_MS),
      /must be 64 hex characters/,
    );
  });

  it('refuses a url that is not http or https', () => {
    assert.throws(
      () => BeePublisherPool.single('ftp://localhost:1633', BATCH['360p'], ANY_TIMEOUT_MS),
      /must be http or https/,
    );
  });

  it('lists the one node, so a startup check has something to enumerate', () => {
    assert.deepEqual(
      pool.nodes().map((publisher) => publisher.url),
      ['http://localhost:1633'],
    );
  });
});

describe('BeePublisherPool.perRung', () => {
  it('routes each rung to its own node and batch', () => {
    const pool = BeePublisherPool.perRung(
      [spec('360p', 1633), spec('480p', 1643), spec('720p', 1653), spec('1080p', 1663)],
      RUNG_ORDER,
      ANY_TIMEOUT_MS,
    );

    assert.equal(pool.forRung('1080p').url, 'http://localhost:1663');
    assert.equal(pool.forRung('1080p').stamp, BATCH['1080p']);
    assert.equal(pool.forRung('360p').stamp, BATCH['360p']);
  });

  it('coordinates through the lowest rung, whatever order the config was written in', () => {
    // The decision this encodes: postage batches drain in proportion to bitrate, so 1080p's expires
    // first. The catalog and the master playlist are the only addresses a viewer needs to open a
    // stage, so they ride the longest-lived batch — never the one designed to run out soonest.
    // Ordering is taken from the ladder rather than from BEE_PUBLISHERS so writing the config
    // top-down cannot silently invert it.
    const pool = BeePublisherPool.perRung(
      [spec('1080p', 1663), spec('720p', 1653), spec('480p', 1643), spec('360p', 1633)],
      RUNG_ORDER,
      ANY_TIMEOUT_MS,
    );

    assert.equal(pool.coordinator().rung, '360p');
    assert.equal(pool.coordinator().url, 'http://localhost:1633');
  });

  it('refuses a ladder rung with no node', () => {
    // Left to a fallback, that rung would quietly spend a batch sized for a different bitrate.
    assert.throws(
      () => BeePublisherPool.perRung([spec('360p', 1633), spec('1080p', 1663)], RUNG_ORDER, ANY_TIMEOUT_MS),
      /no node for rung\(s\) 480p, 720p/,
    );
  });

  it('refuses a node named for a rung the ladder does not have', () => {
    // A typo that would otherwise sit unused until someone wondered why a rung never appeared.
    const withStray = [
      spec('360p', 1633),
      spec('480p', 1643),
      spec('720p', 1653),
      spec('1080p', 1663),
      { rung: '2160p', url: 'http://localhost:1673', stamp: '5'.repeat(64) },
    ];

    assert.throws(() => BeePublisherPool.perRung(withStray, RUNG_ORDER, ANY_TIMEOUT_MS), /names rung\(s\) 2160p/);
  });

  // What `ChequebookGate` enumerates at startup. Taken from the pool rather than rebuilt from the
  // config, so a rung added to BEE_PUBLISHERS is checked for funding without anyone remembering to
  // widen a second list.
  it('lists every node in ladder order, so a startup check reaches all of them', () => {
    const pool = BeePublisherPool.perRung(
      [spec('1080p', 1663), spec('720p', 1653), spec('480p', 1643), spec('360p', 1633)],
      RUNG_ORDER,
      ANY_TIMEOUT_MS,
    );

    assert.deepEqual(
      pool.nodes().map((publisher) => publisher.rung),
      RUNG_ORDER,
    );
    assert.deepEqual(
      pool.nodes().map((publisher) => publisher.url),
      ['http://localhost:1633', 'http://localhost:1643', 'http://localhost:1653', 'http://localhost:1663'],
    );
  });

  it('falls back to the coordinator for a rung the ladder lost, rather than stranding it', () => {
    // A stream recovered from disk keeps the rung name it was publishing under. If ABR_LADDER was
    // reconfigured while it was down, dropping it would strand a ladder whose siblings are still
    // live — so it continues through the coordinator, loudly.
    const pool = BeePublisherPool.perRung(
      [spec('360p', 1633), spec('480p', 1643), spec('720p', 1653), spec('1080p', 1663)],
      RUNG_ORDER,
      ANY_TIMEOUT_MS,
    );

    assert.equal(pool.forRung('1440p').rung, '360p');
  });
});

/**
 * ⛔⛔⛔ **A bee that answers nothing held a queue for ever.** Every pooled node was built as
 * `new Bee(url)` with no options, and bee-js hands axios `timeout: options?.timeout ?? 0`, which axios
 * reads as no timeout at all. A node that accepted the connection and then went silent therefore
 * never failed: the segment queue runs at concurrency 1, so one such call stopped that rung, and the
 * same call on the coordinator stopped the catalog for every stream on the stage. Nothing timed out,
 * nothing retried, and nothing in the logs said why the stage had gone quiet.
 *
 * Asserted against a real socket rather than a stub, because the defect lived entirely in what
 * bee-js passed to axios. A fake bee would have been bounded by the fake.
 */
describe('the request timeout every pooled node is built with', () => {
  const servers: http.Server[] = [];

  after(() => {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
  });

  /** A bee that completes the TCP handshake, takes the request, and never writes a byte back. */
  async function silentBee(): Promise<string> {
    const server = http.createServer(() => {});
    servers.push(server);
    server.listen(0, LOOPBACK_HOST);
    await once(server, 'listening');

    return `http://${LOOPBACK_HOST}:${(server.address() as AddressInfo).port}`;
  }

  const BOUND_MS = 300;

  /**
   * Exactly what the pool used to build, since `new Bee(url)` reaches axios as `timeout: 0` and axios
   * reads 0 as no timeout. The control arm dials a server as silent as the subject's and must still be
   * waiting when the case ends.
   */
  const UNBOUNDED_MS = 0;

  /**
   * How long a case waits before calling an upload stuck.
   *
   * A case about a bound needs a bound of its own. Awaiting an unbounded request would hang the
   * runner rather than fail it, and a run that never ends is not a red test.
   */
  const GIVE_UP_MS = 1_500;

  const STILL_IN_FLIGHT = Symbol('still in flight');

  /** What `work` failed with, `null` if it succeeded, or {@link STILL_IN_FLIGHT} if it did neither. */
  async function outcomeWithin(work: Promise<unknown>, ms: number): Promise<unknown> {
    let expire: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<symbol>((resolve) => {
      expire = setTimeout(() => resolve(STILL_IN_FLIGHT), ms);
    });

    try {
      return await Promise.race([
        work.then(
          () => null,
          (error: unknown) => error,
        ),
        giveUp,
      ]);
    } finally {
      clearTimeout(expire);
    }
  }

  const upload = (pool: BeePublisherPool) => pool.coordinator().bee.uploadData(BATCH['360p'], new Uint8Array([0x2a]));

  it('fails an upload to a node that never answers, and the control shows the node never does', async () => {
    const [bounded, unbounded] = await Promise.all([
      silentBee().then(async (url) =>
        outcomeWithin(upload(BeePublisherPool.single(url, BATCH['360p'], BOUND_MS)), GIVE_UP_MS),
      ),
      silentBee().then(async (url) =>
        outcomeWithin(upload(BeePublisherPool.single(url, BATCH['360p'], UNBOUNDED_MS)), GIVE_UP_MS),
      ),
    ]);

    // The control first: without it a node that answered would pass this case for the wrong reason.
    assert.equal(unbounded, STILL_IN_FLIGHT, 'the server answered, so nothing here was ever black-holed');

    assert.notEqual(
      bounded,
      STILL_IN_FLIGHT,
      `an upload through a pool built with a ${BOUND_MS}ms timeout was still in flight after ${GIVE_UP_MS}ms`,
    );
    assert.match(getErrorMessage(bounded), /timeout/i, 'the upload failed, but not on its own deadline');
  });

  it('carries the same timeout on every node of a split deployment, not only the coordinator', async () => {
    const urls = await Promise.all(RUNG_ORDER.map(() => silentBee()));
    const pool = BeePublisherPool.perRung(
      RUNG_ORDER.map((rung, index) => ({ rung, url: urls[index], stamp: BATCH[rung as keyof typeof BATCH] })),
      RUNG_ORDER,
      BOUND_MS,
    );

    const outcomes = await Promise.all(
      RUNG_ORDER.map((rung) =>
        outcomeWithin(pool.forRung(rung).bee.uploadData(pool.forRung(rung).stamp, new Uint8Array([0x2a])), GIVE_UP_MS),
      ),
    );

    for (const [index, outcome] of outcomes.entries()) {
      assert.notEqual(outcome, STILL_IN_FLIGHT, `${RUNG_ORDER[index]} is publishing through an unbounded client`);
      assert.match(getErrorMessage(outcome), /timeout/i, `${RUNG_ORDER[index]} failed, but not on its own deadline`);
    }
  });
});

/**
 * ⛔⛔⛔ **Which node a rung publishes through was invisible from outside the process.** Nothing on the
 * wire told a stage with one Bee node per rung apart from a stage routing all four rungs through one,
 * so a deployment that had never been split read identically to a split one in every measurement
 * anyone took. That is not hypothetical: on 2026-08-31 eleven live arms were attributed to viewer
 * behaviour while the single shared node was the constraint, and the only record that the split had
 * never happened was a note somebody had to remember to read.
 *
 * A reading that names a decision has to come from where the decision is made, so the pool says it.
 *
 * This is exposed on an unauthenticated endpoint, and the two ways that could leak are both pinned
 * below: a bee URL may be configured with credentials in its userinfo, and a batch id is the whole of
 * what authorises paying for a rung, so it is truncated to enough to tell two apart.
 */
describe('BeePublisherPool.routing', () => {
  it('names the node and batch behind every rung, in ladder order', () => {
    const pool = BeePublisherPool.perRung(
      [spec('1080p', 1663), spec('480p', 1643), spec('360p', 1633), spec('720p', 1653)],
      RUNG_ORDER,
      ANY_TIMEOUT_MS,
    );

    assert.deepEqual(pool.routing(), [
      { rung: '360p', url: 'http://localhost:1633', batch: '11111111…' },
      { rung: '480p', url: 'http://localhost:1643', batch: '22222222…' },
      { rung: '720p', url: 'http://localhost:1653', batch: '33333333…' },
      { rung: '1080p', url: 'http://localhost:1663', batch: '44444444…' },
    ]);
  });

  /**
   * The shape that must stay distinguishable from the one above, because the whole point of reading
   * this is telling the two apart. `all` is what {@link SINGLE_PUBLISHER} means: not a rung, every
   * rung.
   */
  it('describes a single-node deployment as the one route it is', () => {
    const pool = BeePublisherPool.single('http://localhost:1633', BATCH['360p'], ANY_TIMEOUT_MS);

    assert.deepEqual(pool.routing(), [{ rung: SINGLE_PUBLISHER, url: 'http://localhost:1633', batch: '11111111…' }]);
  });

  it('never hands out a whole batch id', () => {
    const routes = BeePublisherPool.perRung(
      [spec('360p', 1633), spec('480p', 1643), spec('720p', 1653), spec('1080p', 1663)],
      RUNG_ORDER,
      ANY_TIMEOUT_MS,
    ).routing();

    for (const route of routes) {
      assert.equal(route.batch.length, 9, `${route.rung} batch should be 8 characters and an ellipsis`);
      assert.ok(!Object.values(BATCH).includes(route.batch), `${route.rung} handed out a full batch id`);
    }
  });

  it('strips credentials a bee URL was configured with', () => {
    const pool = BeePublisherPool.perRung(
      [
        { rung: '360p', url: 'http://operator:hunter2@localhost:1633', stamp: BATCH['360p'] },
        spec('480p', 1643),
        spec('720p', 1653),
        spec('1080p', 1663),
      ],
      RUNG_ORDER,
      ANY_TIMEOUT_MS,
    );

    const [lowest] = pool.routing();
    assert.equal(lowest.url, 'http://localhost:1633/');
    assert.ok(!lowest.url.includes('hunter2'));
    assert.ok(!lowest.url.includes('operator'));
  });

  /** Userinfo is one of two places a credential hides in a URL. The redactor already knows the other. */
  it('redacts a secret carried in the query string', () => {
    const pool = BeePublisherPool.perRung(
      [
        { rung: '360p', url: 'http://localhost:1633/?token=hunter2', stamp: BATCH['360p'] },
        spec('480p', 1643),
        spec('720p', 1653),
        spec('1080p', 1663),
      ],
      RUNG_ORDER,
      ANY_TIMEOUT_MS,
    );

    const [lowest] = pool.routing();
    assert.ok(!lowest.url.includes('hunter2'), `query secret survived redaction: ${lowest.url}`);
  });
});
