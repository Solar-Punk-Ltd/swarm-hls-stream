import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const dockerfile = readFileSync(resolve(ROOT, 'deploy/Dockerfile.client'), 'utf8');
const nginxTemplate = readFileSync(resolve(ROOT, 'deploy/client-nginx.conf.template'), 'utf8');

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
