import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BEE_SERVICE_BY_RUNG, nodesBehind, type PublisherRoute, publisherServices } from '../src/harness/publishers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The port a bridge deployment publishes its one bee-uploader on, as `_lib.sh` allocates it. */
const DEPLOY_PORT = 10075;

const route = (rung: string, url: string, batch = 'abcdef12…'): PublisherRoute => ({ rung, url, batch });

/**
 * ⛔ Turning what `/health` says about publisher routing into somewhere the suite can actually read a
 * chequebook and a stamp.
 *
 * The URL on the routing is the one the **uploader** dials, and the suite dials from the deployment
 * host, so the two only coincide when the nodes run on the host network. A split deployment does run
 * that way, and its urls carry the real host port. An unsplit one usually does not: `bee-uploader` is
 * a compose service name that resolves inside the container network and nowhere else, and its host
 * port is a separate thing the deploy publishes.
 *
 * So one case is read off the url, the other is the deploy's own port, and anything that is neither
 * is refused. A preflight that guessed a port would report a healthy chequebook it had never read.
 */
describe('nodesBehind', () => {
  it('reads one node per distinct url, keeping every rung it carries', () => {
    const nodes = nodesBehind(
      [
        route('360p', 'http://127.0.0.1:10075'),
        route('480p', 'http://127.0.0.1:11071'),
        route('720p', 'http://127.0.0.1:11071'),
        route('1080p', 'http://127.0.0.1:11075'),
      ],
      DEPLOY_PORT,
    );

    assert.deepEqual(
      nodes.map((node) => ({ rungs: node.rungs, port: node.port })),
      [
        { rungs: ['360p'], port: 10075 },
        { rungs: ['480p', '720p'], port: 11071 },
        { rungs: ['1080p'], port: 11075 },
      ],
    );
  });

  /**
   * ⛔ One node, however it was spelled. Grouping on the raw url string would read these as two, and
   * then the funding preflight reads one chequebook twice while `judgeCost` counts that node's spend
   * twice against the run's bytes once, which is a cost figure too high rather than merely repeated.
   */
  it('reads one node when two rungs name it with a trailing slash and with userinfo', () => {
    const nodes = nodesBehind(
      [
        route('360p', 'http://127.0.0.1:10075'),
        route('480p', 'http://127.0.0.1:10075/'),
        route('720p', 'http://operator@127.0.0.1:10075'),
      ],
      DEPLOY_PORT,
    );

    assert.equal(nodes.length, 1);
    assert.deepEqual(nodes[0].rungs, ['360p', '480p', '720p']);
    assert.equal(nodes[0].port, 10075);
  });

  /**
   * ⛔⛔ One node spends one batch, and everything downstream is built on that. `readStageStamps`
   * polls a node's configured batch once per node, and `readArmedStage` judges a drained rung's
   * depth and fill on the batch of whichever node carries it. A second batch on the same host was
   * silently dropped by the grouping, so the rung that named it was judged on its neighbour's
   * postage: a fresh depth 17 drain batch could read as the depth 24 batch beside it, and an armed
   * stage would be refused as unarmed after the arming was paid for.
   *
   * Reachable only from a hand-written `BEE_PUBLISHERS` such as `360p@http://n:1633<A>
   * 480p@http://n:1633<B>`, which the uploader accepts, and never from what
   * `deploy/scripts/bee-publishers.sh` writes.
   */
  it('keeps one node when two rungs on it spend the same batch', () => {
    const nodes = nodesBehind(
      [route('480p', 'http://127.0.0.1:11071', 'aaaaaaaa…'), route('720p', 'http://127.0.0.1:11071', 'aaaaaaaa…')],
      DEPLOY_PORT,
    );

    assert.equal(nodes.length, 1);
    assert.deepEqual(nodes[0].rungs, ['480p', '720p']);
    assert.equal(nodes[0].batch, 'aaaaaaaa…');
  });

  /**
   * ⛔ Refused rather than split into two nodes. A chequebook and a wallet belong to the node and not
   * to the batch, so two entries for one host would have the funding preflight read one chequebook
   * twice, `judgeCost` count that node's spend twice against the run's bytes once, and
   * `publisherServices` name two containers where the deployment runs one.
   */
  it('refuses one node configured with two batches, naming both of them', () => {
    assert.throws(
      () =>
        nodesBehind(
          [route('480p', 'http://127.0.0.1:11071', 'aaaaaaaa…'), route('720p', 'http://127.0.0.1:11071', 'bbbbbbbb…')],
          DEPLOY_PORT,
        ),
      (error: Error) => {
        assert.match(error.message, /aaaaaaaa…/, 'the refusal has to name the batch already read');
        assert.match(error.message, /bbbbbbbb…/, 'and the batch that disagrees with it');
        assert.match(error.message, /480p/);
        assert.match(error.message, /720p/);
        return true;
      },
    );
  });

  /** Two hosts with a batch each is the split stage, and nothing about it is ambiguous. */
  it('keeps a batch per node when two hosts name two batches', () => {
    const nodes = nodesBehind(
      [route('480p', 'http://127.0.0.1:11071', 'aaaaaaaa…'), route('720p', 'http://127.0.0.1:11073', 'bbbbbbbb…')],
      DEPLOY_PORT,
    );

    assert.deepEqual(
      nodes.map((node) => ({ rungs: node.rungs, port: node.port, batch: node.batch })),
      [
        { rungs: ['480p'], port: 11071, batch: 'aaaaaaaa…' },
        { rungs: ['720p'], port: 11073, batch: 'bbbbbbbb…' },
      ],
    );
  });

  it('takes the host port from a loopback url, which is what a split deployment configures', () => {
    const nodes = nodesBehind([route('360p', 'http://localhost:11073')], DEPLOY_PORT);

    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].port, 11073);
  });

  /** One node named by its compose service, which is every deployment that has not been split. */
  it('falls back to the deploy port for the single node of an unsplit deployment', () => {
    const nodes = nodesBehind([route('all', 'http://bee-uploader:1633')], DEPLOY_PORT);

    assert.deepEqual(
      nodes.map((node) => ({ rungs: node.rungs, port: node.port })),
      [{ rungs: ['all'], port: DEPLOY_PORT }],
    );
  });

  /**
   * The fallback works because one node has one published port. With several there is no such
   * mapping, and inventing one would have the suite read a chequebook belonging to a different node
   * than the one it names.
   */
  it('refuses to guess when several nodes are named by container rather than by host port', () => {
    assert.throws(
      () =>
        nodesBehind(
          [route('360p', 'http://bee-uploader:1633'), route('1080p', 'http://bee-uploader-1080p:1633')],
          DEPLOY_PORT,
        ),
      /cannot be reached from the deployment host/,
    );
  });

  it('refuses a loopback url with no port rather than assuming bee’s default', () => {
    assert.throws(() => nodesBehind([route('360p', 'http://127.0.0.1')], DEPLOY_PORT), /names no port/);
  });

  /**
   * ⛔ The case the whole file turns on. An uploader built before the routing existed answers
   * `/health` without the field, and `undefined` must read as "this deployment cannot tell me",
   * never as "this deployment has no publishers". The second one passes every check below it.
   */
  it('refuses an absent routing rather than reporting a deployment with no nodes', () => {
    assert.throws(() => nodesBehind(undefined, DEPLOY_PORT), /did not report its publisher routing/);
    assert.throws(() => nodesBehind([], DEPLOY_PORT), /did not report its publisher routing/);
  });

  it('refuses a url it cannot parse rather than skipping the node', () => {
    assert.throws(() => nodesBehind([route('360p', 'not a url')], DEPLOY_PORT), /is not a url/);
  });
});

/**
 * The map that says which container carries which rung, and the deploy script that must agree.
 *
 * ⛔⛔⛔ Both halves matter and they fail differently. A map missing a rung means a fault cannot reach
 * that rung's node, which is how `scenarios/bee-outage-short` came to PASS while testing nothing on a
 * four-node stage. A map naming a container the deployment does not have means a fault silently does
 * nothing, which is indistinguishable from one the product survived.
 */
describe('which Bee service carries which rung', () => {
  it('names a service for every rung the deploy script knows', () => {
    const script = readFileSync(join(ROOT, 'deploy', 'scripts', 'bee-publishers.sh'), 'utf8');
    const declared = [...script.matchAll(/^\s*"([0-9]+p):BEE_[A-Z0-9_]+"/gm)].map((m) => m[1]);

    assert.notEqual(declared.length, 0, 'the deploy script no longer declares its rungs the same way');
    assert.deepEqual([...declared].sort(), Object.keys(BEE_SERVICE_BY_RUNG).sort());
  });

  it('names a service the compose file actually defines, for every rung', () => {
    const compose = readFileSync(join(ROOT, 'deploy', 'docker-compose.yml'), 'utf8');

    for (const service of Object.values(BEE_SERVICE_BY_RUNG)) {
      assert.match(compose, new RegExp(`^  ${service}:`, 'm'), `compose defines no service ${service}`);
    }
  });

  it('lists every service a routing would need taken down', () => {
    const nodes = nodesBehind(
      [
        { rung: '360p', url: 'http://127.0.0.1:10075', batch: 'aa…' },
        { rung: '480p', url: 'http://127.0.0.1:11071', batch: 'bb…' },
        { rung: '720p', url: 'http://127.0.0.1:11073', batch: 'cc…' },
        { rung: '1080p', url: 'http://127.0.0.1:11075', batch: 'dd…' },
      ],
      10075,
    );

    assert.deepEqual(publisherServices(nodes), [
      'bee-uploader',
      'bee-uploader-480p',
      'bee-uploader-720p',
      'bee-uploader-1080p',
    ]);
  });

  /** One node carrying everything is the unsplit stage, and its rung name is not a rung. */
  it('maps the single-node stage to the shared service', () => {
    const nodes = nodesBehind([{ rung: 'all', url: 'http://127.0.0.1:10075', batch: 'aa…' }], 10075);

    assert.deepEqual(publisherServices(nodes), ['bee-uploader']);
  });

  /** Two rungs on one node is one container, and faulting it twice would be a second outage. */
  it('names a shared node once however many rungs ride it', () => {
    const nodes = nodesBehind(
      [
        { rung: '360p', url: 'http://127.0.0.1:10075', batch: 'aa…' },
        { rung: '480p', url: 'http://127.0.0.1:10075', batch: 'aa…' },
      ],
      10075,
    );

    assert.deepEqual(publisherServices(nodes), ['bee-uploader']);
  });

  it('refuses a rung it has no service for, rather than faulting the ones it knows', () => {
    const nodes = nodesBehind([{ rung: '4k', url: 'http://127.0.0.1:11079', batch: 'ee…' }], 10075);

    assert.throws(() => publisherServices(nodes), /no Bee service/);
  });

  it('refuses an empty routing rather than answering with an empty fault', () => {
    assert.throws(() => publisherServices([]), /establishes nothing/);
  });
});
