import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parsePublishers, readPublishers } from '../src/lib/publishers.js';

const BATCH_360 = '1'.repeat(64);
const BATCH_720 = '3'.repeat(64);

const TWO_RUNGS = `360p@http://localhost:1633<${BATCH_360}> 720p@http://localhost:1653<${BATCH_720}>`;

describe('parsePublishers', () => {
  it('reads rung, url and batch for each node', () => {
    assert.deepEqual(parsePublishers(TWO_RUNGS), [
      { rung: '360p', url: 'http://localhost:1633', stamp: BATCH_360 },
      { rung: '720p', url: 'http://localhost:1653', stamp: BATCH_720 },
    ]);
  });

  it('treats unset or blank as an unsplit deployment', () => {
    assert.deepEqual(parsePublishers(undefined), []);
    assert.deepEqual(parsePublishers(''), []);
    assert.deepEqual(parsePublishers('   \n '), []);
  });

  it('keeps a url that carries a port and a path', () => {
    const [parsed] = parsePublishers(`720p@https://bee.example:1633/api<${BATCH_720}>`);

    assert.equal(parsed.url, 'https://bee.example:1633/api');
    assert.equal(parsed.stamp, BATCH_720);
  });

  it('skips an entry it cannot read and returns the rest', () => {
    // Deliberately unlike the uploader's parser, which refuses to start on this. Here the job is to
    // reach nodes for funding and diagnosis, and hiding three healthy nodes because the fourth entry
    // has a typo would defeat the point of the command.
    const withJunk = `360p@http://localhost:1633<${BATCH_360}> nonsense 720p@http://localhost:1653<${BATCH_720}>`;

    assert.deepEqual(
      parsePublishers(withJunk).map((p) => p.rung),
      ['360p', '720p'],
    );
  });

  it('still reads the older # form, so an existing config keeps resolving', () => {
    assert.deepEqual(parsePublishers(`360p@http://localhost:1633#${BATCH_360}`), [
      { rung: '360p', url: 'http://localhost:1633', stamp: BATCH_360 },
    ]);
  });

  it('does not invent a rung out of an entry with no batch', () => {
    assert.deepEqual(parsePublishers('360p@http://localhost:1633'), []);
    assert.deepEqual(parsePublishers('@http://localhost:1633<abc>'), []);
  });

  it('rejects an empty batch rather than storing an empty stamp', () => {
    // The uploader's parseEntry refuses this with `open >= close - 1`, and this parser now matches.
    // Accepting `rung@url<>` used to store `stamp: ''`, which read downstream as "no batch
    // configured" and silenced stamp-check's warning that a node is not holding the batch it should.
    assert.deepEqual(parsePublishers('360p@http://localhost:1633<>'), []);
    assert.deepEqual(parsePublishers('360p@http://localhost:1633#'), []);
  });
});

describe('readPublishers duplicate rungs', () => {
  const TWICE = `720p@http://localhost:1633<${BATCH_360}> 720p@http://localhost:1653<${BATCH_720}>`;

  it('names a rung that appears more than once', () => {
    assert.deepEqual(readPublishers(TWICE).duplicated, ['720p']);
  });

  it('still returns every node, because reaching them is what this parser is for', () => {
    // The spend path refuses a duplicate rung outright, in resolveSpendTarget: choosing which of two
    // nodes to buy a batch on is not a guess worth making. Listing is the opposite case. Both nodes
    // exist, both may be holding stamps, and hiding one of them is how a batch fills unnoticed.
    assert.deepEqual(
      readPublishers(TWICE).parsed.map((p) => p.url),
      ['http://localhost:1633', 'http://localhost:1653'],
    );
  });

  it('reports nothing when every rung is distinct', () => {
    assert.deepEqual(readPublishers(TWO_RUNGS).duplicated, []);
    assert.deepEqual(readPublishers(undefined).duplicated, []);
  });

  it('names each repeated rung once however many nodes claim it', () => {
    const thrice = `720p@http://a:1633<${BATCH_360}> 720p@http://b:1633<${BATCH_720}> 720p@http://c:1633<${BATCH_360}>`;

    assert.deepEqual(readPublishers(thrice).duplicated, ['720p']);
  });
});
