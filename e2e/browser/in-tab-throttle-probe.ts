/**
 * `pnpm browser:in-tab-throttle-probe` — why a capped in-tab node delivers nothing.
 *
 * ## The question
 *
 * V2 caps a watching viewer's download at the bitrate of the rung below the one they ride. On the
 * in-tab profile it is red in five sittings out of five, and the red is not the player's: capped at
 * 2800 kbps, which carries a 220 KB segment in 0.63 s, the node in the tab could not deliver one in
 * twenty seconds, and served the next one in 2.5 s the moment the cap lifted. That is a collapse of
 * more than thirty times, not an overhead.
 *
 * ⛔ The owner ruled on 2026-09-02 that the answer is **not** a gateway fallback of any kind. The fix
 * lives in the in-tab retrieval path itself, and this probe is the measurement that has to come
 * before any such fix, because the mechanism has so far only been reasoned about.
 *
 * ## What this run costs
 *
 * **0 BZZ.** An ultra-light node's retrievals are free to the node, the recording is already
 * published, and the gateway serves two manifests. No broadcast, and the spend ledger is untouched.
 * The cost bracket is taken anyway, on every node, because the rule is every service metric either
 * side of every measurement, and here the bracket is what **proves** the gateway served no segment.
 *
 * ## ⛔ This driver computes nothing
 *
 * It sequences, and every figure comes out of `src/browser/inTabProbe.ts` and
 * `src/browser/webSocketTraffic.ts`, where `node --test` can reach them.
 * `deploy/scripts/in-browser-concurrency-sweep.js` records the reason: every in-browser throughput
 * figure this project retracted before 2026-08-11 was retracted for the arithmetic applied
 * afterwards rather than for a mistimed fetch.
 *
 * ⛔ Nothing here is asserted. This is a measurement, not a suite.
 *
 * Usage, on the deployment host:
 *   deploy/scripts/browser-on-host.sh --script browser:in-tab-throttle-probe
 *
 * @see `docs/bench/in-tab-throttle-probe-prediction-2026-09-02.md`, written before this existed.
 */

import { Topic } from '@ethersphere/bee-js';
import { type Page } from 'playwright-core';

import { prewarmByteSource, retrieveThroughInTabNode } from '../src/browser/fetchBackendSweep.js';
import {
  buildRetrievalRow,
  describeRetrieval,
  h0Check,
  type IdleWindow,
  judgeRoundDegraded,
  type ProbeArm,
  probeArmOrder,
  renderInTabProbeReport,
  type RetrievalOutcome,
  type RetrievalRow,
  summarizeIdleWindow,
} from '../src/browser/inTabProbe.js';
import { judgeCost, readResources } from '../src/browser/resources.js';
import { envNumber, requireEnv, runIdFrom, writeRunArtifacts } from '../src/browser/runFiles.js';
import {
  makeRefPool,
  manifestRefusal,
  type ParsedRungManifest,
  parseRungManifest,
  type RefPool,
  type RungName,
  spacedRefs,
} from '../src/browser/rungManifest.js';
import { squeezeDownload, type ThrottleHandle } from '../src/browser/throttle.js';
import { launchViewer, VIEWPORT } from '../src/browser/viewer.js';
import { recordWebSocketTraffic, thinFrames, type WebSocketTraffic } from '../src/browser/webSocketTraffic.js';
import { type E2EConfig, loadConfig } from '../src/config.js';
import { type Host, makeHost } from '../src/harness/host.js';

/**
 * Sitting five's recording, still resolvable through the gateway on 2026-09-02.
 *
 * ⚠️ A feed is addressed by the **hashed** topic, so `PROBE_TOPIC_360_HEX` and its sibling take the
 * 64-character output of `Topic.fromString(raw).toHex()`. The defaults below are the raw session
 * topics and are hashed here rather than written out already hashed, which is what every other feed
 * reader in this harness does and what keeps a hand-copied digest from ever naming the wrong
 * recording.
 */
const DEFAULT_OWNER = '8d8a30ff4cbcf8ad0e0773547686295f8157feb0';
const RAW_TOPIC_360 = '8949d4e4-d705-4829-8bce-9484a3390885';
const RAW_TOPIC_1080 = '6e01b80f-47ef-41fa-9449-a64e2478cf6f';

const OWNER_HEX_LENGTH = 40;
const TOPIC_HEX_LENGTH = 64;
const HEX_ONLY = /^[0-9a-f]+$/;

/** The client publishes its switch from a mount effect, so the handle appears a tick after the app. */
const FETCH_BACKEND_HANDLE = '__swarmFetchBackendSwitch';
const HANDLE_TIMEOUT_MS = 30_000;
const HANDLE_POLL_MS = 250;

/** The wasm is 4.5 MB and the dialling takes several seconds. A host slower than this cannot run one. */
const PREWARM_TIMEOUT_MS = 120_000;

/** A feed head read can take seconds on a busy gateway, and a manifest is one of them. */
const MANIFEST_TIMEOUT_S = 30;

/** Part C: two references started together, twice. Sitting five had up to three overlapping. */
const PART_C_ROUNDS = 2;
const PART_C_CONCURRENCY = 2;

/** Part B asks the 360p rung for a canary, a capped row and a free row per round. */
const REFS_PER_360P_ROUND = 3;
const REFS_PER_1080P_ROUND = 2;

const RUNGS: readonly RungName[] = ['360p', '1080p'];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A hex setting, refused rather than accepted when it is not hex.
 *
 * ⛔ Two reasons, and both matter. A topic or owner that is not the one it claims resolves to a
 * different recording or to nothing, and the run would quietly measure that instead. And the value
 * is interpolated into a curl command run over ssh on the deployment host, where anything but hex
 * has no business at all.
 */
function requireHex(name: string, value: string, length: number): string {
  if (value.length !== length || !HEX_ONLY.test(value)) {
    throw new Error(
      `${name} must be ${length} lowercase hex characters and is ${JSON.stringify(value)}. An address ` +
        'that is not the one it claims resolves to a different recording, and the run would measure that.',
    );
  }
  return value;
}

/** The hashed topic an override names, or the hash of this probe's own raw session topic. */
function topicHexEnv(name: string, rawTopic: string): string {
  const override = process.env[name];
  return override ? requireHex(name, override, TOPIC_HEX_LENGTH) : Topic.fromString(rawTopic).toHex();
}

/**
 * A rung's playlist, read through the gateway exactly as the client reads it.
 *
 * ⚠️ `GET /feeds/{owner}/{topic}` answers with the m3u8 itself rather than a JSON envelope.
 */
async function readRung(
  host: Host,
  cfg: E2EConfig,
  rung: RungName,
  owner: string,
  topicHex: string,
): Promise<ParsedRungManifest> {
  const text = await host.localText(cfg.ports.beeGatewayApi, `/feeds/${owner}/${topicHex}`, MANIFEST_TIMEOUT_S);
  return parseRungManifest(rung, topicHex, text);
}

/** Wait for the client to publish its switch, exactly as `browser:fetch-backend-check` does. */
async function waitForSwitch(page: Page): Promise<void> {
  const deadline = Date.now() + HANDLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const published = await page.evaluate(
      (handle: string) => (globalThis as unknown as Record<string, unknown>)[handle] !== undefined,
      FETCH_BACKEND_HANDLE,
    );
    if (published) {
      return;
    }
    await sleep(HANDLE_POLL_MS);
  }
  throw new Error(
    'the deployed client publishes no byte-source switch. It must be built with VITE_EXPOSE_PLAYER ' +
      'for this probe to drive its in-tab retrieval path, and without it every row would be empty.',
  );
}

interface SettledRetrieval {
  startedAtMs: number;
  settledAtMs: number | null;
  outcome: RetrievalOutcome;
  byteLength: number | null;
  elapsedMs: number | null;
}

/**
 * One retrieval, raced against the budget.
 *
 * ⛔⛔ A budget miss stops the **harness** waiting and stops nothing else. weeb-3 offers no cancel:
 * its exported call takes none, and an attempt that outlives ten seconds is detached rather than
 * cancelled so the peer is still paid when its chunk arrives. That is deliberate here, because the
 * bytes still crossing the link are the finding. A rejection handler goes on the promise this may
 * walk away from, or closing the browser at the end turns an abandoned retrieval into an unhandled
 * rejection that kills the process after the measurement is already done.
 */
async function retrieveWithBudget(page: Page, ref: string, budgetMs: number): Promise<SettledRetrieval> {
  const startedAtMs = Date.now();
  const inFlight = retrieveThroughInTabNode(page, ref);
  inFlight.catch(() => undefined);

  let budgetTimer: NodeJS.Timeout | undefined;
  const budget = new Promise<null>((resolve) => {
    budgetTimer = setTimeout(() => resolve(null), budgetMs);
  });

  try {
    const settled = await Promise.race([inFlight, budget]);
    if (settled === null) {
      return { startedAtMs, settledAtMs: null, outcome: 'budget', byteLength: null, elapsedMs: null };
    }

    const settledAtMs = Date.now();
    if (settled.failure !== null) {
      return { startedAtMs, settledAtMs, outcome: 'rejected', byteLength: null, elapsedMs: settledAtMs - startedAtMs };
    }
    return {
      startedAtMs,
      settledAtMs,
      outcome: 'resolved',
      byteLength: settled.byteLength,
      // The client's own measurement where it gave one, so the figure is the one inside the product.
      elapsedMs: settled.elapsedMs ?? settledAtMs - startedAtMs,
    };
  } finally {
    clearTimeout(budgetTimer);
  }
}

async function main(): Promise<void> {
  const clientUrl = requireEnv('BROWSER_CLIENT_URL');
  const owner = requireHex('PROBE_OWNER', process.env.PROBE_OWNER || DEFAULT_OWNER, OWNER_HEX_LENGTH);
  const topics: Record<RungName, string> = {
    '360p': topicHexEnv('PROBE_TOPIC_360_HEX', RAW_TOPIC_360),
    '1080p': topicHexEnv('PROBE_TOPIC_1080_HEX', RAW_TOPIC_1080),
  };
  const capKbps = envNumber('PROBE_CAP_KBPS', 2_800);
  const lowCapKbps = envNumber('PROBE_LOW_CAP_KBPS', 700);
  const idleMs = envNumber('PROBE_IDLE_SECONDS', 60) * 1_000;
  const rounds = envNumber('PROBE_RETRIEVALS_PER_ARM', 3);
  const budgetMs = envNumber('PROBE_BUDGET_SECONDS', 90) * 1_000;
  const tailMs = envNumber('PROBE_TAIL_SECONDS', 10) * 1_000;

  const cfg = loadConfig();
  const host = makeHost(cfg);
  const measuredAt = new Date().toISOString();
  const runId = runIdFrom(measuredAt);
  const resourcesBefore = await readResources(host, cfg);

  const parsed: Record<RungName, ParsedRungManifest> = {
    '360p': await readRung(host, cfg, '360p', owner, topics['360p']),
    '1080p': await readRung(host, cfg, '1080p', owner, topics['1080p']),
  };
  const needed: Record<RungName, number> = {
    '360p': rounds * REFS_PER_360P_ROUND + PART_C_ROUNDS * PART_C_CONCURRENCY,
    '1080p': rounds * REFS_PER_1080P_ROUND,
  };

  // ⛔ Before the browser opens. A run that discovered mid-sitting that it was out of fresh
  // references would either repeat one, which is a cache hit dressed as a retrieval, or abandon the
  // arms it had not reached, and either way its artifact is already half written.
  for (const rung of RUNGS) {
    const refusal = manifestRefusal(parsed[rung], needed[rung]);
    if (refusal !== null) {
      throw new Error(refusal);
    }
  }

  const pools: Record<RungName, RefPool> = {
    '360p': makeRefPool(spacedRefs(parsed['360p'].refs, needed['360p']), '360p'),
    '1080p': makeRefPool(spacedRefs(parsed['1080p'].refs, needed['1080p']), '1080p'),
  };

  const browser = await launchViewer();
  const chromeVersion = `Chrome ${browser.version()}`;
  const traffic: WebSocketTraffic = { connections: [], frames: [] };
  const idleWindows: IdleWindow[] = [];
  const retrievals: RetrievalRow[] = [];
  let joinedInMs = 0;

  console.log(`probe: ${chromeVersion}, ${parsed['360p'].manifest.segmentCount} segments on 360p, 0 BZZ`);

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    // Before the navigation. A recorder attached afterwards misses the sockets the node opened while
    // the harness was still opening the page, and those are the ones the join is made of.
    recordWebSocketTraffic(page, traffic);
    // The client root rather than a watch url: the switch is published by the app provider, so this
    // needs the page to mount and needs no broadcast to exist at all.
    await page.goto(clientUrl, { waitUntil: 'domcontentloaded' });
    await waitForSwitch(page);

    const joinStartedAtMs = Date.now();
    const failure = await Promise.race([
      prewarmByteSource(page),
      sleep(PREWARM_TIMEOUT_MS).then(() => `the node did not reach the network within ${PREWARM_TIMEOUT_MS}ms`),
    ]);
    if (failure !== null) {
      throw new Error(`no in-tab node booted, so nothing below would be a reading of one: ${failure}`);
    }
    joinedInMs = Date.now() - joinStartedAtMs;
    console.log(`probe: the node joined in ${joinedInMs}ms`);

    /** Hold the link at a cap for a window, and record what arrived while nothing was asked for. */
    const idleFor = async (label: string, kbpsCap: number | null): Promise<void> => {
      const throttle = kbpsCap === null ? undefined : await squeezeDownload(page, kbpsCap);
      const startedAtMs = Date.now();
      try {
        await sleep(idleMs);
      } finally {
        idleWindows.push(summarizeIdleWindow({ label, kbpsCap, startedAtMs, endedAtMs: Date.now() }, traffic));
        await throttle?.release().catch((error) => console.error('could not lift the cap:', error));
      }
    };

    console.log(`probe: Part A, three idle windows of ${idleMs / 1_000}s`);
    await idleFor('unthrottled', null);
    await idleFor(`capped at ${capKbps} kbps`, capKbps);
    await idleFor(`capped at ${lowCapKbps} kbps`, lowCapKbps);
    for (const window of idleWindows) {
      console.log(`  ${window.label}: ${Math.round(window.inBytesPerSecondMean)} B/s inbound`);
    }

    /** One retrieval end to end: cap, ask, wait out the tail, count, lift. */
    const runRetrieval = async (plan: {
      arm: ProbeArm;
      kbpsCap: number | null;
      ref: string;
      roundIndex: number;
      roundDegraded: boolean;
    }): Promise<RetrievalRow> => {
      let throttle: ThrottleHandle | undefined;
      try {
        throttle = plan.kbpsCap === null ? undefined : await squeezeDownload(page, plan.kbpsCap);
        const settled = await retrieveWithBudget(page, plan.ref, budgetMs);
        await sleep(tailMs);
        return buildRetrievalRow({ ...plan, ...settled, budgetMs, tailMs }, traffic);
      } finally {
        await throttle?.release().catch((error) => console.error('could not lift the cap:', error));
      }
    };

    console.log(`probe: Part B, ${rounds} rounds of a canary and four arms`);
    for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
      const provisional = await runRetrieval({
        arm: 'canary',
        kbpsCap: null,
        ref: pools['360p'].take(),
        roundIndex,
        roundDegraded: false,
      });
      const roundDegraded = judgeRoundDegraded(provisional, budgetMs);
      retrievals.push({ ...provisional, roundDegraded });
      console.log(`  round ${roundIndex} canary: ${describeRetrieval(provisional)}${roundDegraded ? ' ⛔' : ''}`);

      for (const step of probeArmOrder(roundIndex)) {
        const row = await runRetrieval({
          arm: step.arm,
          kbpsCap: step.capped ? capKbps : null,
          ref: pools[step.arm].take(),
          roundIndex,
          roundDegraded,
        });
        retrievals.push(row);
        console.log(`  round ${roundIndex} ${step.arm} ${step.capped ? 'capped' : 'free'}: ${describeRetrieval(row)}`);
      }
    }

    console.log(`probe: Part C, ${PART_C_ROUNDS} pairs started together under the ${capKbps} kbps cap`);
    for (let roundIndex = 0; roundIndex < PART_C_ROUNDS; roundIndex += 1) {
      const refs = Array.from({ length: PART_C_CONCURRENCY }, () => pools['360p'].take());
      const throttle = await squeezeDownload(page, capKbps);
      try {
        const settled = await Promise.all(refs.map((ref) => retrieveWithBudget(page, ref, budgetMs)));
        // One tail after the last of them settles covers every one of their own tail windows.
        await sleep(tailMs);
        settled.forEach((row, index) => {
          const built = buildRetrievalRow(
            {
              ...row,
              arm: 'pair',
              kbpsCap: capKbps,
              ref: refs[index],
              roundIndex,
              roundDegraded: false,
              budgetMs,
              tailMs,
            },
            traffic,
          );
          retrievals.push(built);
          console.log(`  pair ${roundIndex}.${index}: ${describeRetrieval(built)}`);
        });
      } finally {
        await throttle.release().catch((error) => console.error('could not lift the cap:', error));
      }
    }
  } finally {
    await browser.close();
  }

  // ⛔ Zero segment bytes on purpose. The gateway served two manifests and nothing else, and this
  // bracket is what proves that rather than what assumes it.
  const cost = judgeCost(resourcesBefore, await readResources(host, cfg), 0);

  const run = {
    measuredAt,
    clientUrl,
    chromeVersion,
    owner,
    manifests: [parsed['360p'].manifest, parsed['1080p'].manifest],
    joinedInMs,
    budgetMs,
    tailMs,
    capKbps,
    lowCapKbps,
    idleWindows,
    retrievals,
    cost,
  };

  const stem = await writeRunArtifacts('in-tab-throttle-probe', runId, {
    markdown: renderInTabProbeReport(run),
    run,
    requests: thinFrames(traffic.frames),
  });

  const lowIdle = idleWindows.find((window) => window.kbpsCap === lowCapKbps);
  const missed = retrievals.filter((row) => row.outcome === 'budget').length;
  const degraded = retrievals.filter((row) => row.roundDegraded).length;

  console.log(`\nprobe: wrote ${stem}.md`);
  console.log('probe: observations, none of them asserted');
  console.log(`  ${lowIdle === undefined ? 'H0 was not checked, no low-capped idle window' : h0Check(lowIdle)}`);
  console.log(`  ${missed} of ${retrievals.length} rows did not complete inside their budget`);
  console.log(`  ${degraded} rows come from a degraded round and are in no ratio`);
  cost.warnings.forEach((warning) => console.log(`  ⚠️ ${warning}`));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
