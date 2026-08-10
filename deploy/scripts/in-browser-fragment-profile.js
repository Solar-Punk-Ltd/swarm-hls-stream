/* eslint-env browser */
/**
 * Fragment-profile sweep for an in-browser Swarm node (weeb-3). Answers in-browser question 5: does a
 * browser node prefer larger fragments, and by how much.
 *
 * The premise being tested is that the ~790ms service-time floor is paid PER REQUEST rather than per
 * byte, so a fragment holding four times the bytes should cost far less than four times the time.
 *
 * ⭐ IT COSTS NOTHING AND NEEDS NO BROADCAST. Every reference comes from the archived sweep of
 * 2026-08-03, which walked GOP 0.25 through 4 in one sitting: same uploader, same postage batch, same
 * day. Re-reading already-paid-for uploads is what makes the size arms comparable at all, and a fresh
 * recording per arm would confound fragment size with upload age.
 *
 * ⛔ SIZES ARE INTERLEAVED ROUND-ROBIN, NEVER RUN AS BLOCKS. Peer tables drift and a laddered sweep
 * maps that drift onto the size axis.
 *
 * ⛔⛔ THE CANARY IS NOT OPTIONAL, AND IT IS WHY THIS FILE EXISTS IN THIS FORM. The first sitting ran
 * without one: rounds 0-2 were clean (small fragments 12/12, 3.5MB 0/3), then the node decayed from 154
 * peers to 72 and began timing out on 230KB fragments too. Without a canary those late failures are
 * indistinguishable from a size effect, and they would have made the size story unfalsifiable. Each
 * round now begins with a cold small reference. **A round whose canary misses its budget is degraded
 * and every measurement in it is discarded**, because at that point the run is measuring node health.
 *
 * ⚠️ `RETRIEVAL_BUDGET_MS` IS A BOUND THIS SCRIPT IMPOSES, so a result at the bound is reported as
 * "did not complete in time" and never as a measured duration. 30s is chosen because a live viewer
 * waiting 30s for a sub-second fragment has already failed, so the bound is operationally meaningful
 * rather than arbitrary. The first sitting used weeb-3's own 240s ceiling and spent four minutes per
 * stuck fetch to learn nothing more than this bound learns in thirty seconds.
 *
 * HOW TO RUN
 *   1. Open https://lat-murmeldjur.github.io/weeb-3/ in Chrome and wait for the peer count to STOP
 *      MOVING. Buildup is not monotonic, so waiting for a target hangs.
 *   2. Set window.__q5refs to { "<gopSeconds>": [ref, ...] } and window.__q5canaries to [ref, ...]
 *      holding one small cold reference per round.
 *   3. Paste this file. Results land on window.__q5.
 */
(() => {
  const RETRIEVAL_BUDGET_MS = 30000;
  const WARM_CONTROL_N = 12;

  const refsByGop = window.__q5refs;
  const canaries = window.__q5canaries || [];
  if (!refsByGop || !Object.keys(refsByGop).length) {
    throw new Error('window.__q5refs is not set. Assign { "<gop>": [ref, ...] } before running.');
  }
  if (!canaries.length) {
    throw new Error('window.__q5canaries is not set. Without a canary a decaying node reads as a size effect.');
  }

  const P = (window.__q5 = { rows: [], marks: [], degradedRounds: [], state: 'running' });

  function peers() {
    const body = document.body.innerText || '';
    const connected = body.match(/Connected:\s*(\d+)/);
    const connecting = body.match(/Connecting:\s*(\d+)/);
    return [connected ? +connected[1] : -1, connecting ? +connecting[1] : -1];
  }

  function scrape() {
    P.marks.push([Math.round(performance.now()), ...peers()]);
  }

  /** Round-robin so anything drifting during the run is shared by every size rather than landing on one. */
  function interleave(groups) {
    const keys = Object.keys(groups).sort((a, b) => Number(a) - Number(b));
    const longest = Math.max(...keys.map((k) => groups[k].length));
    const rounds = [];
    for (let i = 0; i < longest; i++) {
      rounds.push(keys.filter((k) => i < groups[k].length).map((k) => ({ gop: Number(k), ref: groups[k][i] })));
    }
    return rounds;
  }

  async function one({ gop, ref }, arm, round, index) {
    const controller = new AbortController();
    const cutOff = setTimeout(() => controller.abort(), RETRIEVAL_BUDGET_MS);
    const startedAt = performance.now();
    let status = 0;
    let bytes = 0;
    let overBudget = false;
    try {
      const response = await fetch(`/weeb-3/hls/bytes/${ref}`, { cache: 'no-store', signal: controller.signal });
      status = response.status;
      bytes = (await response.arrayBuffer()).byteLength;
    } catch {
      overBudget = true;
    } finally {
      clearTimeout(cutOff);
    }
    const ms = Math.round(performance.now() - startedAt);
    const row = [index, arm, round, gop, ref.slice(0, 10), ms, bytes, status, overBudget ? 'over-budget' : ''];
    P.rows.push(row);
    return { ok: !overBudget && status === 200 && bytes > 0, ms, bytes };
  }

  const median = (values) => {
    if (!values.length) {
      return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  function summarise() {
    const healthy = P.rows.filter((r) => r[1] === 'main' && !P.degradedRounds.includes(r[2]));
    const buckets = {};
    for (const row of healthy) {
      (buckets[row[3]] = buckets[row[3]] || []).push(row);
    }
    const perBucket = Object.keys(buckets)
      .sort((a, b) => Number(a) - Number(b))
      .map((gop) => {
        const rows = buckets[gop];
        const done = rows.filter((r) => r[7] === 200 && r[6] > 0);
        const ms = median(done.map((r) => r[5]));
        const bytes = median(done.map((r) => r[6]));
        return {
          gop: Number(gop),
          inBudget: `${done.length}/${rows.length}`,
          medianKB: Math.round(bytes / 1024),
          medianMs: ms,
          kbPerS: ms ? Math.round(bytes / 1024 / (ms / 1000)) : 0,
        };
      });
    const warm = P.rows.filter((r) => r[1] === 'warm' && r[7] === 200);
    return {
      perBucket,
      warmControlMs: median(warm.map((r) => r[5])),
      roundsRun: P.marks.length,
      degradedRounds: P.degradedRounds,
      peersFirst: P.marks[0],
      peersLast: P.marks[P.marks.length - 1],
      budgetMs: RETRIEVAL_BUDGET_MS,
    };
  }

  (async () => {
    try {
      const rounds = interleave(refsByGop);
      P.total = rounds.reduce((sum, r) => sum + r.length, 0);
      for (let round = 0; round < rounds.length; round++) {
        scrape();
        const canary = canaries[round % canaries.length];
        const health = await one({ gop: -1, ref: canary }, 'canary', round, -1000 - round);
        if (!health.ok) {
          P.degradedRounds.push(round);
        }
        for (let i = 0; i < rounds[round].length; i++) {
          await one(rounds[round][i], 'main', round, round * 100 + i);
        }
      }
      // A warm re-read must come back far faster than the cold one, or the run measured plumbing and
      // every number above it is void. It is the null control, not a nicety.
      const warmFrom = P.rows.filter((r) => r[1] === 'main' && r[7] === 200).slice(-WARM_CONTROL_N);
      for (let i = 0; i < warmFrom.length; i++) {
        await one(
          { gop: warmFrom[i][3], ref: refsByGop[warmFrom[i][3]].find((x) => x.startsWith(warmFrom[i][4])) },
          'warm',
          -1,
          -1 - i,
        );
      }
      scrape();
      P.summary = summarise();
      P.state = 'done';
    } catch (error) {
      P.state = 'error: ' + String(error).slice(0, 200);
    }
  })();

  return 'started';
})();
