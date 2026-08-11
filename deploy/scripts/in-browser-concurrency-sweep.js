/* eslint-env browser */
/**
 * Concurrency sweep for an in-browser Swarm node (weeb-3). Collects the raw fetches that our only
 * previous throughput figures could not offer: that harness was never committed and retained aggregates
 * only, so neither of its arms can be re-derived, re-checked or extended. See task #65.
 *
 * ⭐⭐ THIS FILE ONLY COLLECTS. It deliberately computes no throughput at all. Every in-browser
 * throughput figure this project held before 2026-08-11 was retracted, and none of them for a mistimed
 * fetch: they were retracted for the arithmetic applied afterwards. That arithmetic now lives in
 * `deploy/scripts/concurrency-analysis.mjs` where `node --test` can reach it, and the summary here is a
 * health readout for deciding whether to keep going, never a result.
 *
 * ⭐ EVERY FETCH IS RETAINED AS ITS OWN ROW, with the start and end instants that make overlap
 * recoverable. `window.__conc.tsv()` emits them. Save that file, then:
 *   node deploy/scripts/concurrency-analysis.mjs docs/bench/in-browser-concurrency-sweep-<date>.tsv
 *
 * ⭐ REQUESTED CONCURRENCY IS A KNOB THIS SCRIPT TURNS, ACHIEVED CONCURRENCY IS A MEASUREMENT. They are
 * not the same number, which is why the rows carry instants rather than a worker count. Assuming they
 * were the same is how "203 KB/s at concurrency 3" got recorded as a fact about weeb-3 when it was a
 * fact about a harness offering ~72 chunks to a node that could take roughly 220 a second.
 *
 * ⛔⛔ SUSTAINED RETRIEVAL DEGRADES THE NODE AFTER 2-3 ROUNDS. Both fragment sittings watched it happen:
 * one fell from 154 peers to 72 and began timing out on references it had served minutes earlier. So
 * every round opens with a cold canary, and rows are pushed as they land rather than at the end. A
 * sitting abandoned half way still yields the rounds it finished, and `progress()` is what tells you
 * when to abandon it.
 *
 * ⛔ ARM ORDER ROTATES BY ROUND so drift over the sitting does not land on one arm. With more arms than
 * rounds the rotation cannot cover every position, so a monotonic decay is shared but not cancelled.
 *
 * ⚠️ REFERENCES ARE DISJOINT ACROSS ARMS, and the plan is built and checked before a single fetch goes
 * out. Two arms sharing a reference would let the second read the first's cached bytes, and the warm
 * control shows what that is worth: single-digit ms against a cold ~800ms.
 *
 * ⛔ ONE TAB. Every weeb-3 tab runs its own libp2p node dialing 160 bootnodes, and concurrent tabs
 * starve each other: measured on 2026-08-11, a second tab halved the newer node's peers and a third
 * left it at zero connected with no error shown. Check the peer count before believing any arm.
 *
 * HOW TO RUN
 *   1. Open https://lat-murmeldjur.github.io/weeb-3/ in Chrome, ALONE, and wait for the peer count to
 *      STOP MOVING. Buildup is not monotonic, so waiting for a target hangs.
 *   2. Write a plan file: {refs, canaries, arms, rounds, block}. It needs arms x rounds x block cold
 *      references, plus one cold canary per round that appears in neither list.
 *   3. node deploy/scripts/serve-sweep-plan.mjs <plan.json>
 *   4. In the page's console, load the plan and then this file. Fetching it rather than pasting it is
 *      what makes the sitting and the repository agree about what ran:
 *        fetch('http://127.0.0.1:8899/plan.json').then((r) => r.json()).then((p) => Object.assign(window, {
 *          __concRefs: p.refs, __concCanaries: p.canaries,
 *          __concArms: p.arms, __concRounds: p.rounds, __concBlock: p.block,
 *        }));
 *        fetch('http://127.0.0.1:8899/sweep.js').then((r) => r.text()).then(eval);
 *   5. Watch window.__conc.progress(). Save window.__conc.tsv() to docs/bench.
 */
(() => {
  const ARMS = window.__concArms || [1, 2, 3, 4, 8, 16];
  const ROUNDS = window.__concRounds || 3;
  const BLOCK = window.__concBlock || 20;
  const BUDGET_MS = window.__concBudgetMs || 30000;
  const WARM_N = 5;
  const SCHEDULING_PROBE_N = 12;
  /** A same-origin fetch of the page itself is tens of ms. A 1Hz clamped loop is about a thousand. */
  const SCHEDULING_CEILING_MS = 500;

  const refs = window.__concRefs;
  const canaries = window.__concCanaries || [];
  const needed = ARMS.length * ROUNDS * BLOCK;

  if (!Array.isArray(refs) || refs.length < needed) {
    throw new Error(`window.__concRefs needs ${needed} references for this plan, got ${refs ? refs.length : 0}`);
  }
  if (canaries.length < ROUNDS) {
    throw new Error(
      `window.__concCanaries needs ${ROUNDS}. Without one, a decaying node reads as a concurrency effect.`,
    );
  }
  if (new Set([...refs, ...canaries]).size !== refs.length + canaries.length) {
    throw new Error('references are not all distinct, so some arm would read bytes another arm already paid for');
  }
  const T0 = performance.now();
  const now = () => Math.round(performance.now() - T0);

  const P = (window.__conc = {
    rows: [],
    marks: [],
    degradedRounds: [],
    state: 'running',
    plan: { arms: ARMS, rounds: ROUNDS, block: BLOCK, budgetMs: BUDGET_MS },
  });

  function peers() {
    const body = document.body.innerText || '';
    const connected = body.match(/Connected:\s*(\d+)/);
    const connecting = body.match(/Connecting:\s*(\d+)/);
    return [connected ? +connected[1] : -1, connecting ? +connecting[1] : -1];
  }

  /**
   * Is this document's task queue serviced promptly enough to time a fetch?
   *
   * ⛔ DELIBERATELY NOT A VISIBILITY CHECK. Visibility is a proxy for "the clock is throttled", and for
   * a fetch-driven harness the proxy is wrong in both directions. Measured in an automated Chrome pane
   * on 2026-08-11: ten 100ms timers took 9,787ms, a 9.8x clamp, and `requestAnimationFrame` fired zero
   * frames in four seconds, while twelve sequential same-origin fetches in that same pane ran at a 42ms
   * median with not one quantised to the clamp. Chrome clamps timers in a hidden document; it does not
   * throttle network continuations. This file's only timer is the 30s abort, where a 1Hz granularity is
   * noise. So a visibility gate refuses an environment that measures correctly, and would wave through
   * a visible one that does not.
   *
   * The number is REPORTED as well as gated on, and lands in the TSV header, so a later reader can
   * judge the environment a sitting ran in rather than trusting that it passed.
   *
   * ⚠️ None of this transfers to `in-browser-sustain.js`. That one measures PLAYBACK, autoplay needs a
   * real user gesture, and media is suspended in a hidden document, so its refusal to run in an
   * automated pane is its null control and must stay. This harness never had that dependency.
   */
  async function schedulingProbe() {
    const durations = [];
    for (let i = 0; i < SCHEDULING_PROBE_N; i++) {
      const startedAt = performance.now();
      try {
        await fetch(`${location.pathname}?schedprobe=${i}`, { cache: 'no-store' });
      } catch {
        /* a refused probe still measures how long the loop took to come back */
      }
      durations.push(Math.round(performance.now() - startedAt));
    }
    // First iteration carries connection setup, so it is not evidence about scheduling.
    const settled = durations.slice(1).sort((a, b) => a - b);
    return { p50Ms: settled[Math.floor(settled.length / 2)], durations };
  }

  /**
   * Which references each arm reads in each round, fixed before anything is fetched so the disjointness
   * the arms depend on is checked rather than trusted to slice arithmetic.
   */
  function buildBlocks() {
    const blocks = [];
    for (let round = 0; round < ROUNDS; round++) {
      const order = ARMS.map((_, position) => ARMS[(position + round) % ARMS.length]);
      for (const concurrency of order) {
        const slot = round * ARMS.length + ARMS.indexOf(concurrency);
        blocks.push({ round, concurrency, refs: refs.slice(slot * BLOCK, slot * BLOCK + BLOCK) });
      }
    }
    const used = new Set(blocks.flatMap((block) => block.refs));
    if (used.size !== needed || blocks.some((block) => block.refs.length !== BLOCK)) {
      throw new Error(
        `plan is not disjoint: ${used.size} distinct references across ${blocks.length} blocks, wanted ${needed}`,
      );
    }
    return blocks;
  }

  /**
   * One fetch, retained whatever happens to it. `overBudget` means "did not finish inside the bound this
   * script imposes", never "failed", so a row sitting at the bound is not quotable as a duration.
   */
  async function one(ref, arm, round) {
    const controller = new AbortController();
    const cutOff = setTimeout(() => controller.abort(), BUDGET_MS);
    const startMs = now();
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
    const endMs = now();
    const row = { arm, round, ref: ref.slice(0, 10), startMs, endMs, ms: endMs - startMs, bytes, status, overBudget };
    P.rows.push(row);
    return row;
  }

  /** A worker pool rather than batched Promise.all: batching idles every finished worker until the slowest lands. */
  async function runBlock(blockRefs, concurrency, round) {
    let next = 0;
    const take = () => (next < blockRefs.length ? blockRefs[next++] : null);
    const startMs = now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let ref = take(); ref !== null; ref = take()) {
          await one(ref, concurrency, round);
        }
      }),
    );
    return { startMs, endMs: now() };
  }

  /** Enough to decide whether the node is still worth measuring. Not a result, and deliberately not one. */
  P.progress = () => ({
    state: P.state,
    fetches: P.rows.length,
    roundsStarted: new Set(P.rows.map((r) => r.round)).size,
    degradedRounds: P.degradedRounds,
    peersNow: peers(),
    lastCanaryMs: [...P.rows].reverse().find((r) => r.arm === 'canary')?.ms ?? null,
    overBudgetSoFar: P.rows.filter((r) => r.overBudget).length,
  });

  P.tsv = () => {
    const meta = [
      `# In-browser weeb-3 concurrency sweep. arms ${JSON.stringify(ARMS)}, rounds ${ROUNDS}, block ${BLOCK}.`,
      `# Retrieval budget ${BUDGET_MS}ms. A row at the bound is "did not complete", never a duration.`,
      `# Degraded rounds (canary missed), excluded by the analyser: ${JSON.stringify(P.degradedRounds)}`,
      `# Scheduling probe: same-origin fetch p50 ${P.scheduling ? P.scheduling.p50Ms : '?'}ms ` +
        `(ceiling ${SCHEDULING_CEILING_MS}ms), document ${document.visibilityState}. Judge the environment, do not assume it.`,
      ...P.marks.map(
        (m) =>
          `# round ${m.round} pos ${m.position} arm ${m.arm}: peers ${m.peersBefore.join('/')} -> ` +
          `${m.peersAfter.join('/')}, focused ${m.focused}`,
      ),
      '# Summarise with: node deploy/scripts/concurrency-analysis.mjs <this file>',
    ];
    const header = 'arm\tround\tref\tstartMs\tendMs\tms\tbytes\tstatus\toverBudget';
    const body = P.rows.map((r) =>
      [r.arm, r.round, r.ref, r.startMs, r.endMs, r.ms, r.bytes, r.status, r.overBudget ? 'over-budget' : ''].join(
        '\t',
      ),
    );
    return [...meta, header, ...body].join('\n');
  };

  (async () => {
    try {
      P.scheduling = await schedulingProbe();
      if (P.scheduling.p50Ms > SCHEDULING_CEILING_MS) {
        throw new Error(
          `Refusing to run: this document's loop returns from a same-origin fetch in ${P.scheduling.p50Ms}ms, ` +
            `over the ${SCHEDULING_CEILING_MS}ms ceiling. Every figure here divides by a wall clock this would inflate.`,
        );
      }
      const blocks = buildBlocks();
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const position = index % ARMS.length;
        if (position === 0) {
          const canary = await one(canaries[block.round], 'canary', block.round);
          if (canary.overBudget || canary.status !== 200 || !canary.bytes) {
            P.degradedRounds.push(block.round);
          }
        }
        const peersBefore = peers();
        const span = await runBlock(block.refs, block.concurrency, block.round);
        P.marks.push({
          round: block.round,
          position,
          arm: block.concurrency,
          ...span,
          peersBefore,
          peersAfter: peers(),
          focused: document.hasFocus(),
        });
      }
      // A warm re-read of references already fetched must come back far faster than the cold read, or
      // the sweep timed our own plumbing and every arm is void. Both directions are live: this control
      // has a value meaning "the run is invalid", which is the only kind worth running.
      const alreadyRead = P.rows
        .filter((r) => typeof r.arm === 'number' && r.status === 200 && r.bytes > 0)
        .slice(-WARM_N);
      for (const read of alreadyRead) {
        const full = refs.find((ref) => ref.startsWith(read.ref));
        if (full) {
          await one(full, 'warm', -1);
        }
      }
      P.state = 'done';
      console.log('[conc] done.', P.progress(), 'Save window.__conc.tsv() and run the analyser.');
    } catch (error) {
      P.state = 'error: ' + String(error).slice(0, 200);
      console.error('[conc]', error);
    }
  })();

  return `armed: ${ARMS.length} arms x ${ROUNDS} rounds x ${BLOCK} fetches. A scheduling probe runs first and refuses a throttled loop.`;
})();
