import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nodesBehind, type PublisherRoute } from '../src/harness/publishers.js';

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
