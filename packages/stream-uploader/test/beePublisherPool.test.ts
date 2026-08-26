import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BeePublisherPool, parsePublisherSpecs, SINGLE_PUBLISHER } from '../src/libs/BeePublisherPool.js';

const BATCH = {
  '360p': '1'.repeat(64),
  '480p': '2'.repeat(64),
  '720p': '3'.repeat(64),
  '1080p': '4'.repeat(64),
};

/** Ascending by height, which is what AbrLadder.rungs() hands over. */
const RUNG_ORDER = ['360p', '480p', '720p', '1080p'];

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
  const pool = BeePublisherPool.single('http://localhost:1633', BATCH['360p']);

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
    assert.throws(() => BeePublisherPool.single('http://localhost:1633', 'abc123'), /must be 64 hex characters/);
  });

  it('refuses a url that is not http or https', () => {
    assert.throws(() => BeePublisherPool.single('ftp://localhost:1633', BATCH['360p']), /must be http or https/);
  });
});

describe('BeePublisherPool.perRung', () => {
  it('routes each rung to its own node and batch', () => {
    const pool = BeePublisherPool.perRung(
      [spec('360p', 1633), spec('480p', 1643), spec('720p', 1653), spec('1080p', 1663)],
      RUNG_ORDER,
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
    );

    assert.equal(pool.coordinator().rung, '360p');
    assert.equal(pool.coordinator().url, 'http://localhost:1633');
  });

  it('refuses a ladder rung with no node', () => {
    // Left to a fallback, that rung would quietly spend a batch sized for a different bitrate.
    assert.throws(
      () => BeePublisherPool.perRung([spec('360p', 1633), spec('1080p', 1663)], RUNG_ORDER),
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

    assert.throws(() => BeePublisherPool.perRung(withStray, RUNG_ORDER), /names rung\(s\) 2160p/);
  });

  it('falls back to the coordinator for a rung the ladder lost, rather than stranding it', () => {
    // A stream recovered from disk keeps the rung name it was publishing under. If ABR_LADDER was
    // reconfigured while it was down, dropping it would strand a ladder whose siblings are still
    // live — so it continues through the coordinator, loudly.
    const pool = BeePublisherPool.perRung(
      [spec('360p', 1633), spec('480p', 1643), spec('720p', 1653), spec('1080p', 1663)],
      RUNG_ORDER,
    );

    assert.equal(pool.forRung('1440p').rung, '360p');
  });
});
