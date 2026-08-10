/**
 * How many of weeb-3's hard-coded entry points actually answer a WebSocket connection right now.
 *
 * ## The claim under test
 *
 * A browser Swarm node reaches the network over exactly one transport, `websocket_websys`, so it can
 * only ever talk to full nodes that terminate TLS WebSocket. weeb-3 ships that set as a literal: 319
 * mainnet multiaddrs, which resolve to FOUR machines, three of them in one /16. If the reachable
 * population is the binding constraint on a browser audience, then it is bounded by this list, and the
 * list is small and concentrated in a way no amount of client tuning changes.
 *
 * ## What this measures, and what it does not
 *
 * It measures **WSS reachability**: TCP connect, TLS handshake, WebSocket upgrade. That is the first
 * gate every browser peer must pass, and a node that fails it cannot become a peer by any route.
 *
 * ⛔ It does NOT measure libp2p acceptance, handshake success, or willingness to serve chunks. A node
 * that answers here may still refuse the Swarm handshake. So the reachable count is an **upper bound**
 * on the peer population available to a browser, not a measurement of what a browser achieves. Quote it
 * as a ceiling.
 *
 * ## Load
 *
 * One pass opens at most one connection per endpoint and closes it immediately. A single weeb-3 tab
 * picks 160 of these at random and connects on every page load, so a full pass is less traffic than two
 * ordinary users arriving.
 *
 * Usage: node wss-population-probe.mjs <multiaddr-file> [--json out.json]
 */

const CONCURRENCY = 20;
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * A libp2p.direct DNS name encodes the host's IPv4 address with dashes in its leftmost label, which is
 * the only place the underlying machine is visible. Without it every entry looks like a distinct host.
 */
function machineOf(dnsName) {
  const label = dnsName.split('.')[0];
  return /^\d+-\d+-\d+-\d+$/.test(label) ? label.replaceAll('-', '.') : dnsName;
}

function parseMultiaddr(addr) {
  const dns = addr.match(/\/dns4\/([^/]+)/)?.[1];
  const ip = addr.match(/\/ip4\/([^/]+)/)?.[1];
  const port = addr.match(/\/tcp\/(\d+)/)?.[1];
  const peer = addr.match(/\/p2p\/([A-Za-z0-9]+)/)?.[1];
  const sni = addr.match(/\/sni\/([^/]+)/)?.[1];
  const host = dns ?? sni;
  if (!host || !port) return null;
  return { url: `wss://${host}:${port}/`, host, port, peer, machine: machineOf(host), fallbackIp: ip };
}

function probe(target) {
  return new Promise((resolve) => {
    const started = performance.now();
    let ws;
    let settled = false;
    const finish = (outcome, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // A socket that never opened has nothing to close, and the probe's verdict is already decided.
      }
      resolve({ ...target, outcome, detail, ms: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => finish('timeout', `no answer in ${CONNECT_TIMEOUT_MS}ms`), CONNECT_TIMEOUT_MS);
    try {
      ws = new WebSocket(target.url);
    } catch (err) {
      return finish('error', String(err?.message ?? err));
    }
    ws.onopen = () => finish('open');
    ws.onerror = (ev) => finish('refused', String(ev?.message ?? 'connection failed'));
    ws.onclose = (ev) => finish(ev.code === 1000 ? 'open' : 'refused', `close ${ev.code}`);
  });
}

async function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node wss-population-probe.mjs <multiaddr-file> [--json out.json]');
    process.exit(2);
  }
  const jsonAt = rest.indexOf('--json');
  const jsonOut = jsonAt >= 0 ? rest[jsonAt + 1] : null;

  const { readFile, writeFile } = await import('node:fs/promises');
  const lines = (await readFile(file, 'utf8'))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const targets = lines.map(parseMultiaddr).filter(Boolean);
  console.log(`probing ${targets.length} endpoints across ${new Set(targets.map((t) => t.machine)).size} machines`);

  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
      while (next < targets.length) {
        const mine = targets[next++];
        results.push(await probe(mine));
        if (results.length % 40 === 0) console.log(`  ${results.length}/${targets.length}`);
      }
    }),
  );

  const byOutcome = new Map();
  for (const r of results) byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
  const open = results.filter((r) => r.outcome === 'open');

  console.log('\n=== outcomes ===');
  for (const [outcome, count] of [...byOutcome].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${outcome.padEnd(8)} ${String(count).padStart(4)}  ${((100 * count) / results.length).toFixed(1)}%`);
  }

  console.log('\n=== reachable endpoints per machine ===');
  const machines = new Map();
  for (const r of results) {
    const m = machines.get(r.machine) ?? { total: 0, open: 0 };
    m.total += 1;
    if (r.outcome === 'open') m.open += 1;
    machines.set(r.machine, m);
  }
  for (const [machine, m] of [...machines].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${machine.padEnd(18)} ${String(m.open).padStart(4)} of ${String(m.total).padStart(4)} answering`);
  }

  const times = open.map((r) => r.ms).sort((a, b) => a - b);
  if (times.length) {
    console.log(
      `\nconnect time across ${times.length} reachable: median ${times[Math.floor(times.length / 2)]}ms, ` +
        `p90 ${times[Math.floor(times.length * 0.9)]}ms, max ${times.at(-1)}ms`,
    );
  }

  console.log(
    `\n⭐ CEILING: ${open.length} of ${results.length} entry points answer, on ${
      [...machines].filter(([, m]) => m.open > 0).length
    } machines.`,
  );
  console.log('⛔ This is WSS reachability only. libp2p acceptance is not tested here, so treat it as an upper bound.');

  if (jsonOut) {
    await writeFile(jsonOut, JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
    console.log(`\nraw rows written to ${jsonOut}`);
  }
}

await main();
