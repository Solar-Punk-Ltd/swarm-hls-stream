/**
 * Per-segment service time for an in-browser Swarm node (weeb-3).
 *
 * Paste into the console of the weeb-3 APP SHELL (https://lat-murmeldjur.github.io/weeb-3/), not a
 * stream page. The app shell boots the node and connects it, but attaches no stream, so nothing is
 * prefetched. Measuring on a stream page instead mixes prefetch hits at 2-9ms into the sample and
 * makes the distribution look bimodal when it is not.
 *
 * Wait for "Connected: 200 / Connecting: 0" in the UI before starting, and note the count -- a run
 * begun mid-buildup measures the buildup.
 *
 * Arms, in order:
 *   warmup  50 fetches, reported not discarded, so the warming transition stays visible
 *   cold   500 fetches, the primary reading
 *   route   40 fetches alternating /hls/bytes/ and /bytes/, matched and cold
 *   warm    40 re-fetches of cold's last 40, immediately after -- if this is not far faster than
 *           cold, the run measured plumbing rather than retrieval and every number is void
 *   null    20 references that do not exist, which prices a miss
 */
(() => {
  const OWNER = '8d8a30ff4cbcf8ad0e0773547686295f8157feb0';
  const TOPIC = '7fd811aa6aedbced02d010f5e7987039e3a6033dc59bbce668b8515890ed5efd';
  const FIRST = 1010;

  const randRef = () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

  const P = (window.__probe = { rows: [], logs: new Map(), marks: [], state: 'running' });

  /** The log panel is a 256-line ring buffer, so it has to be drained during the run, not after. */
  function scrape() {
    const now = Math.round(performance.now());
    let maxL = 0;
    for (const el of document.querySelectorAll('div > *')) {
      if (el.children.length) continue;
      const m = /^\[\+(\d+)ms\]\s*(.*)$/.exec((el.textContent || '').trim());
      if (!m) continue;
      maxL = Math.max(maxL, +m[1]);
      const key = el.textContent.trim();
      if (!P.logs.has(key)) P.logs.set(key, [+m[1], m[2].slice(0, 140)]);
    }
    const body = document.body.innerText;
    const c = body.match(/Connected:\s*(\d+)/);
    const g = body.match(/Connecting:\s*(\d+)/);
    P.marks.push([now, maxL, c ? +c[1] : -1, g ? +g[1] : -1]);
  }

  async function one(ref, arm, route, i) {
    const url = route === 'plain' ? `/weeb-3/bytes/${ref}` : `/weeb-3/hls/bytes/${ref}`;
    const t0 = performance.now();
    let status = 0;
    let bytes = 0;
    let err = '';
    try {
      const r = await fetch(url, { cache: 'no-store' });
      status = r.status;
      bytes = (await r.arrayBuffer()).byteLength;
    } catch (e) {
      err = String(e).slice(0, 60);
    }
    P.rows.push([
      i,
      arm,
      route,
      ref.slice(0, 10),
      Math.round(t0),
      Math.round(performance.now() - t0),
      bytes,
      status,
      err,
    ]);
    if (P.rows.length % 20 === 0) scrape();
  }

  (async () => {
    try {
      const playlist = await (await fetch(`/weeb-3/feeds/${OWNER}/${TOPIC}`, { cache: 'no-store' })).text();
      const R = playlist.match(/[a-f0-9]{64}/g) || [];
      window.__refs = R;
      scrape();
      for (let i = FIRST; i < FIRST + 50; i++) await one(R[i], 'warmup', 'hls', i);
      for (let i = FIRST + 50; i < FIRST + 550; i++) await one(R[i], 'cold', 'hls', i);
      for (let i = FIRST + 550; i < FIRST + 590; i++) await one(R[i], 'route', i % 2 === 0 ? 'hls' : 'plain', i);
      for (let i = FIRST + 510; i < FIRST + 550; i++) await one(R[i], 'warm', 'hls', i);
      for (let i = 0; i < 20; i++) await one(randRef(), 'null', 'hls', -1 - i);
      scrape();
      P.state = 'done';
    } catch (e) {
      P.state = 'error: ' + String(e).slice(0, 200);
    }
  })();

  return 'started';
})();
