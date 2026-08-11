/**
 * Hands a sweep plan and the sweep harness to a browser page over loopback, so an in-browser sitting
 * is two lines pasted into the console instead of forty kilobytes of references.
 *
 * ⭐ THE PAGE RUNS THE COMMITTED HARNESS. Pasting the sweep in meant the file that ran was a copy,
 * and a copy can drift from the file in git without anyone noticing. Fetching `/sweep.js` from here
 * and eval'ing it means the sitting and the repository cannot disagree about what was measured.
 *
 * ⚠️ THE CROSS-ORIGIN PART ONLY WORKS ON LOOPBACK. weeb-3 is served over HTTPS from a public origin,
 * and an HTTPS page may not fetch plain HTTP. `http://127.0.0.1` is the exception: browsers treat
 * loopback as a potentially trustworthy origin, so it is exempt from mixed-content blocking. Serve
 * this from anywhere else, even the same machine's LAN address, and the page's fetch is blocked.
 *
 * Usage:
 *   node deploy/scripts/serve-sweep-plan.mjs <plan.json> [port]
 *
 * Then in the page's console:
 *   fetch('http://127.0.0.1:8899/plan.json').then((r) => r.json()).then((p) => Object.assign(window, {
 *     __concRefs: p.refs, __concCanaries: p.canaries,
 *     __concArms: p.arms, __concRounds: p.rounds, __concBlock: p.block,
 *   }));
 *   fetch('http://127.0.0.1:8899/sweep.js').then((r) => r.text()).then(eval);
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

export const PLAN_ROUTE = '/plan.json';
export const SWEEP_ROUTE = '/sweep.js';

const DEFAULT_PORT = 8899;
const DEFAULT_SWEEP = fileURLToPath(new URL('./in-browser-concurrency-sweep.js', import.meta.url));
/** Loopback only. A LAN bind would both expose the plan and be blocked by the page anyway. */
const HOST = '127.0.0.1';

/**
 * @param {{ planPath: string, sweepPath?: string }} paths
 * @returns {import('node:http').Server} not yet listening
 */
export function createPlanServer({ planPath, sweepPath = DEFAULT_SWEEP }) {
  const routes = {
    [PLAN_ROUTE]: { type: 'application/json', path: planPath },
    [SWEEP_ROUTE]: { type: 'text/javascript', path: sweepPath },
  };

  return createServer((request, response) => {
    // Present on every path, including the failures: without it the page reports an opaque network
    // error and the operator debugs their fetch rather than their URL.
    const headers = { 'access-control-allow-origin': '*' };
    const route = routes[request.url.split('?')[0]];
    if (!route) {
      response.writeHead(404, headers);
      return response.end('no such route');
    }
    let body;
    try {
      // Re-read per request so editing the harness does not need the server restarted mid-sitting.
      body = readFileSync(route.path);
    } catch (error) {
      response.writeHead(500, headers);
      return response.end(`cannot read ${route.path}: ${error.message}`);
    }
    response.writeHead(200, { ...headers, 'content-type': route.type });
    response.end(body);
  });
}

if (process.argv[1] && process.argv[1].endsWith('serve-sweep-plan.mjs')) {
  const [planPath, port = DEFAULT_PORT] = process.argv.slice(2);
  if (!planPath) {
    console.error('usage: node deploy/scripts/serve-sweep-plan.mjs <plan.json> [port]');
    process.exit(1);
  }
  createPlanServer({ planPath }).listen(Number(port), HOST, () => {
    console.log(`serving ${PLAN_ROUTE} and ${SWEEP_ROUTE} on http://${HOST}:${port}`);
  });
}
