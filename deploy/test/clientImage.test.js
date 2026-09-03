import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const dockerfile = readFileSync(resolve(ROOT, 'deploy/Dockerfile.client'), 'utf8');
const nginxTemplate = readFileSync(resolve(ROOT, 'deploy/client-nginx.conf.template'), 'utf8');
const compose = readFileSync(resolve(ROOT, 'deploy/docker-compose.yml'), 'utf8');

/**
 * The build args `deploy.sh` mints from git and this image turns into `/build-stamp.json`.
 *
 * Written out rather than derived from either file, so the three places that have to agree cannot be
 * brought into agreement by a test that reads one of them: the Dockerfile declaring them, the compose
 * service passing them, and this list.
 */
const STAMP_ARGS = [
  'CLIENT_BUILD_CLIENT_TREE',
  'CLIENT_BUILD_SHARED_TREE',
  'CLIENT_BUILD_HEAD',
  'CLIENT_BUILD_DIRTY',
  'CLIENT_BUILD_AT',
];

/** Where the stamp has to land for the runtime stage's existing COPY to carry it into the site. */
const STAMP_IN_DIST = '/app/packages/client/dist/build-stamp.json';

/**
 * The body of one `location <prefix> { ... }` block.
 *
 * Throws rather than answering with nothing, because an assertion about a block that is not there
 * would otherwise pass on the empty string, which is the shape of a check that reports green while
 * looking at no configuration at all.
 */
function locationBlock(prefix) {
  const start = nginxTemplate.indexOf(`location ${prefix} {`);
  assert.notEqual(start, -1, `client-nginx.conf.template has no location ${prefix} block`);

  return nginxTemplate.slice(start, nginxTemplate.indexOf('}', start));
}

/**
 * The client image against the runtime weeb-3 needs it to serve.
 *
 * From 0.0.341001 the in-tab node lives entirely in a SharedWorker that the package loads from
 * `/weeb-3/worker.js` on the page's own origin, so what this image serves under that prefix decides
 * whether a viewer gets a node at all. Nothing else checks it: CI never builds this image, and the
 * client's own tests build the bundle without ever asking how it is served.
 */
describe('client image serving the weeb-3 shared worker runtime', () => {
  /**
   * ⛔ The SPA fallback is the failure this exists to prevent, and it is silent. `try_files $uri $uri/
   * /index.html` answers a missing `worker.js` with the app's own HTML, at 200, so the browser rejects
   * the script on its MIME type long after `new SharedWorker(...)` has already stopped answering. That
   * is what "SharedWorker request timed out" was, measured on the stage on 2026-09-02.
   */
  it('serves the runtime off the filesystem rather than through the SPA fallback', () => {
    assert.match(locationBlock('/weeb-3/'), /try_files\s+\$uri\s+=404;/);
  });

  it('never hands the index out under that prefix, whatever else the block grows', () => {
    assert.doesNotMatch(locationBlock('/weeb-3/'), /index\.html/);
  });

  // The control. Without it the two cases above pass just as well on a template that stopped serving
  // the app at all, which is a broken client rather than a correctly served worker.
  it('still falls back to the index for the app own routes', () => {
    assert.match(locationBlock('/'), /try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/);
  });

  /**
   * Why there is no `types {}` block: read out of this image on 2026-09-02, `/etc/nginx/mime.types`
   * already maps `application/wasm wasm;` and `application/javascript js;`. The glue calls
   * `WebAssembly.instantiateStreaming`, which refuses anything but `application/wasm` and falls back
   * to a slower path with a console warning, so a base image that stopped mapping it would cost
   * performance silently. This pin is what says the reading still applies.
   */
  it('pins the nginx image whose mime.types was read for application/wasm', () => {
    assert.match(dockerfile, /^FROM nginx:1\.27-alpine$/m);
  });

  /**
   * The runtime is copied out of node_modules by the client's `prebuild`, so it exists only inside
   * `dist/`. Nothing in the image would notice its absence, and the nginx block above would turn it
   * into a clean 404 rather than an error naming a cause.
   */
  it('ships the built site whole, which is where the copied runtime rides in', () => {
    assert.match(dockerfile, /COPY --from=build \/app\/packages\/client\/dist \/usr\/share\/nginx\/html/);
  });
});

/**
 * The client image recording which sources it was built from, served as `/build-stamp.json`.
 *
 * ⛔ The failure this exists for is the client-side twin of the 2026-09-01 uploader sitting.
 * `bench-on-host.sh` syncs the harness checkout to the host on every run and never rebuilds the
 * client image, so the harness can be new while the served client is weeks old. The browser harness
 * parses the served client's console lines, the fetch backend it publishes on `globalThis` and the
 * weeb-3 worker it serves, and nothing noticed the two disagreeing. The stamp is what the
 * `client-shape` e2e preflight reads to refuse that before a broadcast starts.
 */
describe('client image stamping the sources it was built from', () => {
  it('declares every build-stamp arg, so compose has somewhere to pass them', () => {
    for (const arg of STAMP_ARGS) {
      assert.match(dockerfile, new RegExp(`^ARG ${arg}=`, 'm'), `Dockerfile.client declares no ${arg}`);
    }
  });

  /**
   * ⛔ Order is the whole property. `pnpm build` writes `dist/` from scratch, so a stamp written
   * before it is deleted by it and the served client carries no stamp at all, which the gate reads
   * as a client predating the stamp and refuses for the wrong reason.
   */
  it('writes the stamp after the build that creates the directory it lands in', () => {
    const built = dockerfile.indexOf('pnpm --filter @swarm-hls-stream/client build');
    const stamped = dockerfile.indexOf(STAMP_IN_DIST);

    assert.notEqual(stamped, -1, `Dockerfile.client never writes ${STAMP_IN_DIST}`);
    assert.ok(stamped > built, 'the stamp is written before the build that would delete it');
  });

  /**
   * ⚠️ A JSON boolean rather than a quoted string, because the gate refuses on `dirty: true` and a
   * `"0"` would be truthy on the way in. The `%s` here is fed `true` or `false` by the shell.
   */
  it('writes dirty as a JSON boolean, which is what the gate reads it as', () => {
    assert.match(dockerfile, /"dirty":%s/, 'dirty is not substituted unquoted');
    assert.doesNotMatch(dockerfile, /"dirty":"%s"/, 'dirty is written as a string');
  });

  /**
   * The two Vite knobs decide what the bundle actually does, and neither is visible in a tree hash:
   * one deployment's `weeb3` build and another's gateway build come from the same sources. A viewer
   * arm reporting the wrong byte source has been paid for once already.
   */
  it('records the fetch backend and the player flag the bundle was built with', () => {
    assert.match(dockerfile, /"fetchBackend":"%s"/);
    assert.match(dockerfile, /"exposePlayer":"%s"/);
    assert.match(dockerfile, /\$VITE_BROWSER_FETCH_BACKEND/);
    assert.match(dockerfile, /\$VITE_EXPOSE_PLAYER/);
  });

  it('passes every build-stamp arg from the compose service into the build', () => {
    for (const arg of STAMP_ARGS) {
      assert.match(compose, new RegExp(`^\\s+${arg}: \\$\\{${arg}`, 'm'), `docker-compose.yml passes no ${arg}`);
    }
  });

  /**
   * An image built by a deploy script that knows nothing about these args must still build, or a
   * checkout older than this one cannot deploy at all. The gate then refuses on the empty
   * `clientTree`, which is the outcome that asks for a redeploy rather than blocking one.
   */
  it('defaults every arg, so an older deploy script still builds the image', () => {
    for (const arg of STAMP_ARGS) {
      assert.doesNotMatch(dockerfile, new RegExp(`^ARG ${arg}$`, 'm'), `${arg} has no default`);
    }
  });

  /**
   * How the stamp reaches a viewer, and the reason the nginx template needed no change: the app's
   * own location tries the real file first and only falls back to the index for a route that is not
   * one. A template that stopped doing that would answer the gate with the app's HTML at 200.
   */
  it('serves the stamp off the filesystem rather than as the app index', () => {
    assert.match(locationBlock('/'), /try_files\s+\$uri\s/);
  });
});
