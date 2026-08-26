import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { NamedTarget, resolvePublisherTargets } from '../src/lib/config-reader.js';
import { selectNodes, selectPublisherByRung } from '../src/lib/nodes.js';

const BATCH_360 = '1'.repeat(64);
const BATCH_1080 = '4'.repeat(64);

afterEach(() => {
  delete process.env.BEE_PUBLISHERS;
});

describe('resolvePublisherTargets', () => {
  it('turns each publisher into a named node carrying its rung and batch', () => {
    process.env.BEE_PUBLISHERS = `360p@http://localhost:1633#${BATCH_360} 1080p@http://localhost:1663#${BATCH_1080}`;

    assert.deepEqual(resolvePublisherTargets(), [
      {
        name: 'bee-publisher-360p',
        rung: '360p',
        stamp: BATCH_360,
        target: { url: 'http://localhost:1633', host: 'localhost', port: 1633 },
      },
      {
        name: 'bee-publisher-1080p',
        rung: '1080p',
        stamp: BATCH_1080,
        target: { url: 'http://localhost:1663', host: 'localhost', port: 1663 },
      },
    ]);
  });

  it('carries the batch each node holds, which is what stamp-check compares against', () => {
    // A node can hold several batches and only one of them is the one the uploader spends. Without
    // this pairing, a healthy-looking batch that is not the configured one reads as fine and the
    // real one fills up unnoticed.
    process.env.BEE_PUBLISHERS = `360p@http://localhost:1633#${BATCH_360}`;

    assert.equal(resolvePublisherTargets()[0].stamp, BATCH_360);
  });

  it('resolves a compose service name, which is what the uploader container sees', () => {
    process.env.BEE_PUBLISHERS = `720p@http://bee-publisher-720p:1633#${BATCH_360}`;

    assert.deepEqual(resolvePublisherTargets()[0].target, {
      url: 'http://bee-publisher-720p:1633',
      host: 'bee-publisher-720p',
      port: 1633,
    });
  });
});

describe('selectNodes', () => {
  const nodes: NamedTarget[] = [
    {
      name: 'bee-publisher-360p',
      rung: '360p',
      stamp: BATCH_360,
      target: { url: 'http://a:1633', host: 'a', port: 1633 },
    },
    {
      name: 'bee-publisher-1080p',
      rung: '1080p',
      stamp: BATCH_1080,
      target: { url: 'http://b:1633', host: 'b', port: 1633 },
    },
  ];

  it('acts on every node when no override is given', () => {
    assert.equal(selectNodes(nodes, undefined).length, 2);
  });

  it('keeps the matched node’s rung and batch rather than going anonymous', () => {
    // So `stamp-check --url` still knows which of that node's batches is the configured one.
    const selected = selectNodes(nodes, 'http://b:1633');

    assert.equal(selected.length, 1);
    assert.equal(selected[0].rung, '1080p');
    assert.equal(selected[0].stamp, BATCH_1080);
  });

  it('still reaches a node the config does not know about', () => {
    const selected = selectNodes(nodes, 'http://elsewhere:1633');

    assert.equal(selected.length, 1);
    assert.equal(selected[0].rung, undefined);
    assert.equal(selected[0].target?.url, 'http://elsewhere:1633');
  });
});

describe('selectPublisherByRung', () => {
  const nodes: NamedTarget[] = [
    {
      name: 'bee-publisher-360p',
      rung: '360p',
      stamp: BATCH_360,
      target: { url: 'http://a:1633', host: 'a', port: 1633 },
    },
    {
      name: 'bee-publisher-1080p',
      rung: '1080p',
      stamp: BATCH_1080,
      target: { url: 'http://b:1633', host: 'b', port: 1633 },
    },
  ];

  it('returns the node that publishes the named rung', () => {
    const publisher = selectPublisherByRung(nodes, '1080p');

    assert.equal(publisher.rung, '1080p');
    assert.equal(publisher.target?.url, 'http://b:1633');
  });

  it('rejects a rung that is not configured, and says which are', () => {
    // Falling back to some default node would buy the batch somewhere that cannot spend it. Nothing
    // fails at that point — it fails later, as a rung that stops publishing while a perfectly
    // healthy batch sits on the wrong node.
    assert.throws(() => selectPublisherByRung(nodes, '720p'), /No node configured for rung "720p"/);
    assert.throws(() => selectPublisherByRung(nodes, '720p'), /Configured rungs: 360p, 1080p/);
  });

  it('rejects nonsense rather than treating it as a rung', () => {
    assert.throws(() => selectPublisherByRung(nodes, 'banana'), /No node configured for rung "banana"/);
    assert.throws(() => selectPublisherByRung(nodes, '360'), /No node configured for rung "360"/);
    assert.throws(() => selectPublisherByRung(nodes, '360P'), /No node configured for rung "360P"/);
  });

  it('asks for the rung when it was left off, listing the valid ones', () => {
    assert.throws(() => selectPublisherByRung(nodes, undefined), /Which rung\?.*Configured rungs: 360p, 1080p/s);
    assert.throws(() => selectPublisherByRung(nodes, ''), /Which rung\?/);
  });

  it('refuses a duplicate rung rather than spending on the first of two', () => {
    // The uploader's parser refuses this before it starts. Here the spend selection refuses it, so a
    // copy-pasted BEE_PUBLISHERS entry cannot quietly buy on whichever node was listed first.
    const twoFor360: NamedTarget[] = [
      { name: 'bee-publisher-360p', rung: '360p', stamp: BATCH_360, target: { url: 'http://a:1633', host: 'a', port: 1633 } },
      { name: 'bee-publisher-360p', rung: '360p', stamp: BATCH_1080, target: { url: 'http://b:1633', host: 'b', port: 1633 } },
    ];

    assert.throws(() => selectPublisherByRung(twoFor360, '360p'), /2 nodes for rung "360p"/);
  });

  it('says so plainly when nothing has been split yet', () => {
    // The unsplit deployment has one node and no rungs, so there is nothing to select and no
    // sensible guess to make.
    const unsplit: NamedTarget[] = [
      { name: 'bee-uploader', stamp: BATCH_360, target: { url: 'http://a:1633', host: 'a', port: 1633 } },
    ];

    assert.throws(() => selectPublisherByRung(unsplit, '360p'), /BEE_PUBLISHERS is not set/);
    assert.throws(() => selectPublisherByRung([], '360p'), /BEE_PUBLISHERS is not set/);
  });
});
