/**
 * `pnpm browser:weeb3-native` — watch OUR broadcast in weeb-3's OWN page, with no gateway anywhere.
 *
 * ## Why this exists, and why it did not for five days
 *
 * Every "in-tab node" figure this project has published came from a **hybrid** client: segment bytes
 * from weeb-3, feed and manifest still from a bee gateway. That split was never authorised, and the
 * owner had asked, two days before it was built, to measure weeb-3's own setup as it is. See
 * `docs/bench/abel-gateway-less-live-2026-08-16.md`.
 *
 * ⭐ The thing that makes this cheap was in our own uploader the whole time: `streamRawTopic` is a
 * `crypto.randomUUID()`, and weeb-3's page route is `#/live/stream/<owner>/<uuid>`. Our identifiers
 * paste straight in. Proved 2026-08-16 by hand: weeb-3 derived a topic byte-identical to bee-js
 * `Topic.fromString`, resolved our feed frontier, and delivered our segments with no gateway.
 *
 * ## What this measures that the hand check could not
 *
 * The hand check ran in a tab whose pane was hidden, so `play()` resolved and the playhead never
 * moved. That is an instrument limit, not a result, and it is why no realtime ratio was published.
 * {@link launchViewer} runs headful with `--autoplay-policy=no-user-gesture-required`, which is the
 * whole difference.
 *
 * ⛔⛔ **The gate here is by HOST, from the request log, not by counting `/bytes/`.** A run is refused
 * if the page contacts anything outside the app shell. The failure this is built against is the one
 * this project has already made once: two arms that both fetched everything from one node while the
 * client honestly reported two sources.
 *
 * ⚠️ **The visibility sensor proves nothing here.** Playwright forces a visible page, so that check
 * passes by construction and is recorded rather than relied on.
 *
 * ## The squeeze mode, and what it is the control for
 *
 * `WEEB3_NATIVE_SQUEEZE_KBPS` turns one counted window into three: settle, capped, recovered. Our
 * own client, driving our own pinned weeb-3, could not keep a 360p recording moving once Chrome's
 * emulation capped the tab, and the owner has ruled that weeb-3 is not at fault and must not be
 * changed. Abel's published page is the same node inside a client we did not write, so the same
 * recording under the same cap is the first thing that can tell our harness apart from his node. See
 * `docs/bench/in-tab-throttle-probe-result-2026-09-02.md`.
 *
 * ⛔ Unset, the driver behaves exactly as it did before the mode existed. Nothing in the squeeze
 * phases asserts, refuses or gates on a ratio.
 *
 * ⛔⛔⛔ **THE SQUEEZE RUNS OF 2026-09-02 ARE VOID, AND FOR OUR REASONS.** His page runs the node in
 * a SharedWorker exactly as our client does, so the cap went on a page session the node's sockets do
 * not belong to and the recorder listened on the same one. "1.000x under the cap" was a reading of
 * an unconstrained link taken by an instrument that could not see it. The cap and the recorder now
 * attach to every worker target, and two checks refuse a run: anything crossing the wire faster than
 * the cap allows, and a phase that gained media while the recorder counted nothing. ⛔ Both are ONE
 * SIDED, because his page publishes no handle a known-size payload could be timed through, so unlike
 * `browser:vod` this run cannot PROVE its cap landed. It rules out those two failures and no more,
 * and the report says exactly that. See `src/browser/capProof.ts`.
 *
 * Usage, against a recording that already exists:
 *   WEEB3_NATIVE_OWNER=<owner> WEEB3_NATIVE_TOPIC=<rawTopic> pnpm browser:weeb3-native
 *
 * Usage, squeezing the tab's download mid-watch against a finished recording:
 *   WEEB3_NATIVE_SQUEEZE_KBPS=2800 WEEB3_NATIVE_OWNER=<owner> WEEB3_NATIVE_TOPIC=<rawTopic> \
 *     pnpm browser:weeb3-native
 *
 * Usage, against a broadcast that is still running:
 *   WEEB3_NATIVE_LIVE=1 WEEB3_NATIVE_BROADCAST_START_MS=<unix ms the publisher started> \
 *     WEEB3_NATIVE_OWNER=<owner> WEEB3_NATIVE_TOPIC=<rawTopic> pnpm browser:weeb3-native
 */

import { execFileSync } from 'node:child_process';
import { type Page } from 'playwright-core';

import { judgeRun } from '../src/browser/instrument.js';
import {
  behindProductionS,
  edgeGrowthS,
  edgeLagSummary,
  type EdgeSample,
  isExhausted,
} from '../src/browser/liveEdge.js';
import {
  judgeNativeSqueeze,
  judgeNativeSqueezeInstrument,
  nativeSqueezeConsoleLine,
  nativeSqueezeInstrumentLine,
  type NativeSqueezeResult,
  type NativeSqueezeStartup,
  type PhaseWindow,
  playheadHasMoved,
  playheadNeverMovedRefusal,
  renderNativeSqueezeSection,
  shortRecordingRefusal,
} from '../src/browser/nativeSqueeze.js';
import { type RequestRecord } from '../src/browser/network.js';
import { costSection, judgeCost, readResources, type ResourceCost } from '../src/browser/resources.js';
import {
  envFiniteNumber,
  envNumber,
  envNumberOrNull,
  requireEnv,
  runIdFrom,
  thinRequestLog,
  writeRunArtifacts,
} from '../src/browser/runFiles.js';
import { squeezeDownload } from '../src/browser/throttle.js';
import {
  installTimerProbe,
  launchViewerWatchingWorkers,
  readInstrument,
  recordRequests,
  VIEWPORT,
} from '../src/browser/viewer.js';
import { recordWebSocketTraffic, thinFrames, type WebSocketTraffic } from '../src/browser/webSocketTraffic.js';
import { type WorkerTargetWatch } from '../src/browser/workerTargets.js';
import { loadConfig } from '../src/config.js';
import { makeHost } from '../src/harness/host.js';

/** weeb-3's published deployment. Overridable so a pinned build can be measured against this one. */
const DEFAULT_PAGE = 'https://lat-murmeldjur.github.io/weeb-3/';

/**
 * The only origins a gateway-less run may contact.
 *
 * ⛔ Everything else is the arm failing open. weeb-3 serves the feed and the segments from the node
 * through a service worker at its own scope, so a request leaving for any other host means bytes
 * came from somewhere this run does not control and cannot price.
 */
const APP_SHELL_HOSTS = new Set(['lat-murmeldjur.github.io', 'cdn.jsdelivr.net', 'weeb-3-secure.github.io']);

const SAMPLE_INTERVAL_MS = 1_000;

/**
 * How long the squeeze mode watches before capping anything.
 *
 * The baseline the capped phase is read against. weeb-3 boots its node, joins, seeks and fills a
 * buffer, and a cap applied during any of that would be measuring the join. The window opens only
 * once his playhead is actually moving, which is what {@link DEFAULT_START_WAIT_SECONDS} bounds.
 */
const DEFAULT_SETTLE_SECONDS = 45;

/**
 * How long a squeeze run waits for weeb-3's own player to move its playhead before refusing.
 *
 * ⛔⛔ Generous rather than tight, and deliberately so. His player took 26.1 s on 2026-08-16, and the
 * two failure costs are not symmetric: waiting too long only makes a refusal slower, while waiting
 * too little opens the settle window on a stationary playhead and files his startup as the uncapped
 * baseline a cap is judged against. That is the run of 2026-09-02 17:57, which read 0.087, 0.000 and
 * 0.000 across three phases of one startup.
 */
const DEFAULT_START_WAIT_SECONDS = 90;

/** How long the link stays capped. Long enough for the node to have to live under it. */
const DEFAULT_SQUEEZE_SECONDS = 60;

/** How long to keep watching after the cap comes off, which is where a recovery would show. */
const DEFAULT_RECOVER_SECONDS = 60;

/**
 * Bracket the run with the bee nodes' own counters, or refuse to run.
 *
 * ⛔⛔⛔ **This is a gate and not a reminder.** The first three runs of this driver published
 * "gateway-less" on the strength of the browser's own request log and nothing else, which is the
 * shape of a defect this project has already paid for: a sitting once reported two byte sources while
 * both arms fetched every segment from one node, and the client's readback was honest throughout.
 * The nodes were keeping a complete account the whole time and nothing read it.
 *
 * ⭐ The corroboration is worth having even when the answer is boring. The first bracketed run
 * returned `retrieval requests 0` on the gateway across 843 seconds, which is the claim proved from
 * the other side of the wire.
 *
 * Set `WEEB3_NATIVE_METRICS_SSH` to the host running the nodes, `WEEB3_NATIVE_HARNESS_BRACKET=1` to
 * read the same counters through the harness instead of over ssh (see {@link openHarnessBracket}),
 * or `ALLOW_NO_NODE_METRICS=1` to say out loud that this run has no node-side evidence.
 */
function bracketNodeMetrics(host: string, dir: string, phase: 'before' | 'after'): void {
  execFileSync(
    'ssh',
    [
      host,
      `mkdir -p ${dir} && cd ~/swarm-hls-bench && bash deploy/scripts/node-metrics.sh snapshot ${dir}/${phase}.json weeb3-native-${phase}`,
    ],
    { stdio: 'inherit' },
  );
}

function diffNodeMetrics(host: string, dir: string): string {
  return execFileSync(
    'ssh',
    [host, `cd ~/swarm-hls-bench && bash deploy/scripts/node-metrics.sh diff ${dir}/before.json ${dir}/after.json`],
    { encoding: 'utf8' },
  );
}

/**
 * What our gateway is expected to have delivered, which on a gateway-less arm is nothing.
 *
 * ⭐ Named rather than a bare zero at the call site. A per-megabyte figure divided by a numerator
 * that is zero by design reads very differently from one divided by a numerator nobody counted, and
 * this project has already published a cost whose denominator had quietly shrunk to one node.
 */
const NO_SEGMENT_BYTES_FROM_OUR_GATEWAY = 0;

/**
 * Read the deployment's own postage and chequebook counters either side of the run.
 *
 * ⭐ The way that works from inside the browser container on the deployment host, which has no ssh
 * out and therefore cannot satisfy {@link bracketNodeMetrics}. It reads exactly what `quality.ts`
 * reads, off the routing the uploader reports, so every node the stage publishes through is counted
 * rather than whichever one a port happened to name.
 *
 * ⭐ Zero segment bytes are the expectation, not a gap. weeb-3's page pulls its feed, its manifests
 * and its segments from the node in the tab, so a gateway that spent nothing over the window is the
 * gateway-less claim proved from the nodes' side. The browser's own request log makes the same claim
 * from the tab's side, and this project has already paid for believing only that half.
 *
 * @returns The way to close the bracket, which reads the counters again and diffs them.
 */
async function openHarnessBracket(): Promise<() => Promise<ResourceCost>> {
  const cfg = loadConfig();
  const host = makeHost(cfg);
  const before = await readResources(host, cfg);

  return async (): Promise<ResourceCost> =>
    judgeCost(before, await readResources(host, cfg), NO_SEGMENT_BYTES_FROM_OUR_GATEWAY);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Sample extends EdgeSample {
  readyState: number;
  paused: boolean;
  peers: number | null;
  /**
   * The page's stall counter at this instant, polled only in squeeze mode.
   *
   * ⛔ Optional so a plain run's artifact is unchanged: a field never set is absent from the json
   * rather than present and null. A squeeze needs the counter per sample because a phase is judged
   * on the stalls it ADDED, and the single end-of-run reading below cannot be split three ways.
   */
  stalls?: number;
}

/**
 * What weeb-3's own log says about each segment it tried. Its wording, not ours.
 *
 * ⛔⛔ **A ROLLING WINDOW, NOT A TOTAL, AND IT MUST NEVER BE QUOTED AS THROUGHPUT.** Measured across
 * eight arms on 2026-08-16: it reads about 24 in every one, whatever the window length, because the
 * page's log panel keeps roughly that many entries. 24 segments at 0.5s is twelve seconds of media
 * against arms of 660 seconds. It is useful for the failed count and for the mean segment size, and
 * for nothing that has a denominator.
 */
interface SegmentTally {
  done: number;
  failed: number;
  running: number;
  meanMB: number | null;
  meanDurationS: number | null;
  resolutions: string[];
}

async function installStallCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __stalls?: number };
    w.__stalls = 0;
    document.addEventListener(
      'waiting',
      () => {
        w.__stalls = (w.__stalls ?? 0) + 1;
      },
      true,
    );
  });
}

async function readSample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const v = document.querySelector('video');
    const peers = /Connected: (\d+)/.exec(document.body.innerText);
    return {
      atMs: Date.now(),
      currentTime: v ? v.currentTime : 0,
      bufferedEnd: v && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : null,
      seekableEnd: v && v.seekable.length ? v.seekable.end(v.seekable.length - 1) : null,
      duration: v && Number.isFinite(v.duration) ? v.duration : null,
      readyState: v ? v.readyState : 0,
      paused: v ? v.paused : true,
      peers: peers ? Number(peers[1]) : null,
    };
  });
}

async function readStalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __stalls?: number }).__stalls ?? 0);
}

/**
 * The same poll, with the stall counter alongside.
 *
 * ⛔ Two evaluates rather than one, so {@link readSample} and therefore a plain run's artifact are
 * untouched. At a sample a second the gap between them cannot matter, and the alternative was
 * changing what every run before this one recorded.
 */
async function readSqueezeSample(page: Page): Promise<Sample> {
  const sample = await readSample(page);

  return { ...sample, stalls: await readStalls(page) };
}

/**
 * Tally weeb-3's own segment log.
 *
 * ⛔ Parsed here rather than inside `page.evaluate`, because tsx compiles named inner functions with
 * an esbuild `__name` helper that does not exist in the page and throws on first call. Keeping the
 * parsing in Node also makes it testable, which a closure shipped into someone else's page is not.
 *
 * @param text `document.body.innerText` of weeb-3's page, log panel open.
 */
export function tallySegments(text: string): SegmentTally {
  const states = [...text.matchAll(/hls-segment\s+\w+\s+\[(\w+)\]/g)].map((m) => m[1]);
  const sized = [...text.matchAll(/size ([\d.]+) MB, duration ([\d.]+) s(?:, resolution (\S+))?/g)].map((m) => ({
    mb: Number(m[1]),
    dur: Number(m[2]),
    res: m[3] ?? null,
  }));
  const total = sized.length;
  return {
    done: states.filter((s) => s === 'done').length,
    failed: states.filter((s) => s === 'failed').length,
    running: states.filter((s) => s === 'running').length,
    meanMB: total ? Number((sized.reduce((a, x) => a + x.mb, 0) / total).toFixed(3)) : null,
    meanDurationS: total ? Number((sized.reduce((a, x) => a + x.dur, 0) / total).toFixed(3)) : null,
    resolutions: [...new Set(sized.map((x) => x.res).filter((r): r is string => r !== null))],
  };
}

async function readSegmentTally(page: Page): Promise<SegmentTally> {
  return tallySegments(await page.evaluate(() => document.body.innerText));
}

/**
 * Off-shell hosts, split by whether they actually delivered anything.
 *
 * ⛔ The gate fails on **bytes**, not on contact. The first run of this driver refused itself over two
 * requests to `docs.libp2p.io` for `libp2p_color_symbol.svg`, which failed and returned 0 bytes. A
 * logo is not a content path, and a gate that cannot tell the difference gets switched off by the
 * next person who hits it. ⭐ Contact is still reported, because a host that appears here at all is
 * something nobody predicted.
 */
export function offShellTraffic(records: readonly RequestRecord[]): {
  contacted: Record<string, number>;
  servedBytes: Record<string, number>;
} {
  const contacted: Record<string, number> = {};
  const servedBytes: Record<string, number> = {};
  for (const r of records) {
    let host: string;
    try {
      host = new URL(r.url).host;
    } catch {
      continue;
    }
    if (APP_SHELL_HOSTS.has(host)) {
      continue;
    }
    contacted[host] = (contacted[host] ?? 0) + 1;
    if (r.bytes > 0) {
      servedBytes[host] = (servedBytes[host] ?? 0) + r.bytes;
    }
  }
  return { contacted, servedBytes };
}

/** How long each of the squeeze mode's three windows runs for, and what the middle one caps at. */
interface SqueezePlan {
  kbps: number;
  startWaitMs: number;
  settleMs: number;
  squeezeMs: number;
  recoverMs: number;
}

/**
 * Poll for a stretch, and hand back the window that stretch covered.
 *
 * The window comes off the same clock the cap is applied on, so a phase boundary and a treatment
 * moment are comparable without either being derived from the other.
 */
async function sampleWindow(page: Page, forMs: number, into: Sample[]): Promise<PhaseWindow> {
  const fromMs = Date.now();
  while (Date.now() - fromMs < forMs) {
    into.push(await readSqueezeSample(page));
    await sleep(SAMPLE_INTERVAL_MS);
  }

  return { fromMs, toMs: Date.now() };
}

/**
 * Poll until weeb-3's own player moves its playhead past where the seek left it, or run out of time.
 *
 * ⛔⛔⛔ **The boot wait is not this.** That one ends at `readyState >= 2`, which his page reaches tens
 * of seconds before its player moves anything: 26.1 s on 2026-08-16. A settle window opened at the
 * earlier moment measures his startup and then stands in as the uncapped baseline the capped phase is
 * judged against, and the artifact has no field in which to say so. The run of 2026-09-02 17:57 read
 * 0.087 uncapped, then 0.000 and 0.000, with 0 segments done: one startup, measured three times.
 *
 * @returns The polls of the wait, first at the seek and last once the playhead had moved.
 * @throws When the playhead never moves, because nothing measurable follows a player that never ran.
 */
async function waitForHisPlayheadToMove(page: Page, budgetMs: number): Promise<Sample[]> {
  const seeked = await readSqueezeSample(page);
  const polls: Sample[] = [seeked];

  while (Date.now() - seeked.atMs < budgetMs) {
    await sleep(SAMPLE_INTERVAL_MS);
    const poll = await readSqueezeSample(page);
    polls.push(poll);
    if (playheadHasMoved(seeked, poll)) {
      return polls;
    }
  }

  throw new Error(playheadNeverMovedRefusal((Date.now() - seeked.atMs) / 1_000, polls[polls.length - 1].peers));
}

/** Media between the playhead and the end of the recording, read at one poll, or null if unknowable. */
function mediaAheadOfThePlayhead(poll: Sample): number | null {
  return poll.duration === null ? null : poll.duration - poll.currentTime;
}

/**
 * Wait for his player to start, settle, cap the tab's download, let it go, and hand back the phases.
 *
 * ⛔⛔ The release is in a `finally`. A squeeze stretch that threw would otherwise leave the cap on
 * through the recovery window, and the artifact would then carry a recovery phase that had nothing
 * to recover from while reading exactly like one that failed to recover.
 */
async function watchThroughASqueeze(
  page: Page,
  into: Sample[],
  plan: SqueezePlan,
  traffic: WebSocketTraffic,
  workers: WorkerTargetWatch,
): Promise<NativeSqueezeResult> {
  console.log(`weeb3-native: waiting up to ${plan.startWaitMs / 1_000}s for his playhead to move`);
  const waited = await waitForHisPlayheadToMove(page, plan.startWaitMs);
  const settleOpensAt = waited[waited.length - 1];
  const startup: NativeSqueezeStartup = {
    startedMovingAfterS: Number(((settleOpensAt.atMs - waited[0].atMs) / 1_000).toFixed(1)),
    waitBudgetS: plan.startWaitMs / 1_000,
    samples: waited,
  };
  console.log(
    `weeb3-native: his player started moving ${startup.startedMovingAfterS}s after media was ready, ` +
      'the settle window opens now',
  );

  // ⛔⛔ Refused HERE and not off the recording's length before the seek. His page opens a broadcast
  // at its live edge, which on a finished recording is the end of it, so a 600s recording read before
  // the seek says 600 and has nothing ahead of the playhead. Read at the moment the settle opens, the
  // reading already carries the seek and however long his player took to start.
  const refusal = shortRecordingRefusal(mediaAheadOfThePlayhead(settleOpensAt), {
    settleS: plan.settleMs / 1_000,
    squeezeS: plan.squeezeMs / 1_000,
    recoverS: plan.recoverMs / 1_000,
  });
  if (refusal !== null) {
    throw new Error(refusal);
  }

  console.log(`weeb3-native: settling ${plan.settleMs / 1_000}s before the squeeze`);
  const before = await sampleWindow(page, plan.settleMs, into);

  console.log(`weeb3-native: capping the tab at ${plan.kbps} kbps`);
  const throttle = await squeezeDownload(page, plan.kbps, workers);
  const appliedAtMs = Date.now();
  let liftedAtMs = appliedAtMs;
  let during: PhaseWindow;

  try {
    during = await sampleWindow(page, plan.squeezeMs, into);
  } finally {
    await throttle.release().catch((error) => console.error('could not lift the cap:', error));
    liftedAtMs = Date.now();
    console.log(`weeb3-native: cap lifted, watching ${plan.recoverMs / 1_000}s for the climb back`);
  }

  const after = await sampleWindow(page, plan.recoverMs, into);

  return judgeNativeSqueeze(
    into,
    { before, during, after, appliedAtMs, liftedAtMs, kbps: plan.kbps },
    traffic,
    startup,
  );
}

async function main(): Promise<void> {
  const owner = requireEnv('WEEB3_NATIVE_OWNER');
  const topic = requireEnv('WEEB3_NATIVE_TOPIC');
  const pageUrl = process.env.WEEB3_NATIVE_PAGE ?? DEFAULT_PAGE;
  const bootSeconds = envNumber('WEEB3_NATIVE_BOOT_S', 180);
  const watchSeconds = envNumber('WEEB3_NATIVE_WATCH_S', 180);
  /** Where to put the playhead before counting. Negative counts back from the end. 0 is the start. */
  const startAtSeconds = envFiniteNumber('WEEB3_NATIVE_START_S', 0);
  /**
   * What to cap the tab's download at mid-watch, or null for the single counted window.
   *
   * ⛔ Absent rather than zero, and the whole squeeze mode hangs off it. A default cap would put
   * every existing arm under a treatment nobody asked for, and the corpus of runs this driver has
   * already produced would stop being comparable with the ones after it.
   */
  const squeezeKbps = envNumberOrNull('WEEB3_NATIVE_SQUEEZE_KBPS');
  const squeezePlan: SqueezePlan | null =
    squeezeKbps === null
      ? null
      : {
          kbps: squeezeKbps,
          startWaitMs: envNumber('WEEB3_NATIVE_START_WAIT_S', DEFAULT_START_WAIT_SECONDS) * 1_000,
          settleMs: envNumber('WEEB3_NATIVE_SETTLE_S', DEFAULT_SETTLE_SECONDS) * 1_000,
          squeezeMs: envNumber('WEEB3_NATIVE_SQUEEZE_S', DEFAULT_SQUEEZE_SECONDS) * 1_000,
          recoverMs: envNumber('WEEB3_NATIVE_RECOVER_S', DEFAULT_RECOVER_SECONDS) * 1_000,
        };
  /** A live arm holds the edge weeb-3 opened at. A recording arm seeks back to have media ahead. */
  const isLive = process.env.WEEB3_NATIVE_LIVE === '1';
  /** Unix ms the publisher started, which is the only clock that ranks a live arm honestly. */
  const broadcastStartMs = envNumberOrNull('WEEB3_NATIVE_BROADCAST_START_MS');

  const metricsHost = process.env.WEEB3_NATIVE_METRICS_SSH ?? '';
  const metricsRoot = process.env.WEEB3_NATIVE_METRICS_DIR ?? '/home/solarpunk/node-metrics-weeb3native';
  // ⭐ A caller that brackets the arm itself names itself here, and the name is written into the
  // artefact. Without it an arms wrapper would have to pass ALLOW_NO_NODE_METRICS=1, and the run
  // would then carry "this run has no node-side evidence" while its wrapper was holding exactly that
  // evidence one directory up. A gate that can only be satisfied by lying about it teaches lying.
  const metricsBracketedBy = process.env.WEEB3_NATIVE_METRICS_BRACKETED_BY ?? '';
  /** Read the counters through the harness rather than over ssh. See {@link openHarnessBracket}. */
  const bracketedHere = process.env.WEEB3_NATIVE_HARNESS_BRACKET === '1';
  if (metricsHost === '' && metricsBracketedBy === '' && !bracketedHere && process.env.ALLOW_NO_NODE_METRICS !== '1') {
    throw new Error(
      'refusing to run without node metrics. Set WEEB3_NATIVE_METRICS_SSH=<host> to bracket the run ' +
        'with the bee nodes own counters over ssh, WEEB3_NATIVE_HARNESS_BRACKET=1 to read the same ' +
        'counters through the harness, which is what works from inside the browser container on the ' +
        'deployment host, WEEB3_NATIVE_METRICS_BRACKETED_BY=<caller> if the caller already brackets ' +
        'this arm, or ALLOW_NO_NODE_METRICS=1 to record that this run has no node-side evidence for ' +
        'its gateway-less claim.',
    );
  }

  // ⛔⛔ A LIVE ARM WITH NO PUBLISHER CLOCK CANNOT BE RANKED, ONLY DESCRIBED. Its own appended-edge
  // distance shrinks when retrieval slows, because the edge falls back with it, so the arm that
  // struggles most is the one that looks closest to live. Refusing is cheaper than publishing that.
  if (isLive && broadcastStartMs === null && process.env.ALLOW_NO_PRODUCTION_CLOCK !== '1') {
    throw new Error(
      'refusing a live arm with no publisher clock. Set WEEB3_NATIVE_BROADCAST_START_MS=<unix ms the ' +
        'publisher started> so the lag is read from outside the viewer, or ALLOW_NO_PRODUCTION_CLOCK=1 to ' +
        'record that this arm can only report its own appended-edge distance.',
    );
  }

  const watchUrl = `${pageUrl.replace(/\/$/, '')}/#/live/stream/${owner}/${topic}`;
  const measuredAt = new Date().toISOString();
  const runId = runIdFrom(measuredAt);
  // ⛔⛔ Per run, never shared. A shared bracket directory let a later FAILED run overwrite the
  // before-snapshot of an earlier good one, destroying the node-side evidence for a result that had
  // already been reported. An unpaired bracket is a defect, and so is a bracket a rerun can eat.
  const metricsDir = `${metricsRoot}/${runId}`;

  console.log(`weeb3-native: ${watchUrl}`);
  console.log(
    squeezePlan === null
      ? `weeb3-native: boot budget ${bootSeconds}s, counted window ${watchSeconds}s`
      : `weeb3-native: boot budget ${bootSeconds}s, up to ${squeezePlan.startWaitMs / 1_000}s for his ` +
          `playhead to move, then ${squeezePlan.settleMs / 1_000}s settle, ${squeezePlan.squeezeMs / 1_000}s ` +
          `at ${squeezePlan.kbps} kbps, ${squeezePlan.recoverMs / 1_000}s recover`,
  );

  if (metricsHost !== '') {
    bracketNodeMetrics(metricsHost, metricsDir, 'before');
  }
  const closeHarnessBracket = bracketedHere ? await openHarnessBracket() : null;

  // ⛔⛔⛔ Before the browser, because the worker-target watch appends into it. weeb-3's own page runs
  // the node in a SharedWorker exactly as our client does, so the "1.000x under the cap" reading of
  // 2026-09-02 was taken with the cap on the page and the recorder on the page, and the node's own
  // sockets were neither capped nor counted.
  const traffic: WebSocketTraffic = { connections: [], frames: [] };
  const { browser, workers } = await launchViewerWatchingWorkers(traffic);
  const requests: RequestRecord[] = [];
  let exitCode = 0;

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await installTimerProbe(page);
    await installStallCounter(page);
    recordRequests(page, requests);
    // Before the navigation, for the reason `recordRequests` is: a recorder attached afterwards
    // misses the sockets the node opened while the harness was still opening the page, and those
    // are the ones the join is made of.
    recordWebSocketTraffic(page, traffic);

    await page.goto(watchUrl, { waitUntil: 'domcontentloaded' });

    // ⛔ The boot is the node dialling and the wasm downloading, and counting it as playback would
    // report the join. Wait for real decodable media rather than for a wall-clock guess.
    const bootDeadline = Date.now() + bootSeconds * 1_000;
    let booted = false;
    while (Date.now() < bootDeadline) {
      const s = await readSample(page);
      if (s.readyState >= 2) {
        booted = true;
        console.log(
          `weeb3-native: media ready after ${Math.round(
            (Date.now() - (bootDeadline - bootSeconds * 1_000)) / 1_000,
          )}s, peers ${s.peers ?? '?'}`,
        );
        break;
      }
      await sleep(SAMPLE_INTERVAL_MS);
    }
    if (!booted) {
      throw new Error(`no decodable media within ${bootSeconds}s. This is a delivery failure, not a playback one.`);
    }

    // ⛔⛔⛔ weeb-3 opens a broadcast AT ITS LIVE EDGE. On a FINISHED one that edge is the end of the
    // recording: the first run of this driver counted 180s in which the playhead sat on the final
    // frame and reported realtimeRatio 0.068, which reads as a delivery failure and is nothing of
    // the kind. A recording arm therefore seeks back so there is media ahead of the playhead.
    //
    // ⛔⛔ A LIVE ARM MUST NOT SEEK. The edge is the entire question there, and seeking away from it
    // would measure catch-up playback through a buffer the broadcast has already filled, which is
    // the easiest thing in this harness to mistake for a live result.
    await page.evaluate(
      ({ startAt, live }: { startAt: number; live: boolean }) => {
        const v = document.querySelector('video');
        if (!v) {
          return;
        }
        if (!live && Number.isFinite(v.duration) && v.duration > 0) {
          v.currentTime = startAt >= 0 ? startAt : Math.max(0, v.duration + startAt);
        }
        void v.play();
      },
      { startAt: startAtSeconds, live: isLive },
    );
    await sleep(SAMPLE_INTERVAL_MS);

    const samples: Sample[] = [];
    let squeeze: NativeSqueezeResult | null = null;
    if (squeezePlan === null) {
      const countedFrom = Date.now();
      while (Date.now() - countedFrom < watchSeconds * 1_000) {
        samples.push(await readSample(page));
        await sleep(SAMPLE_INTERVAL_MS);
      }
    } else {
      // ⭐ The three windows are ONE counted stretch as far as everything below is concerned. The
      // whole-run ratio, the edge readings and the exhaustion check all still apply, and they read
      // across the treatment on purpose: a run whose recording ran out mid-squeeze must void itself
      // by the same rule as any other, and the per-phase figures sit beside them rather than
      // instead of them.
      squeeze = await watchThroughASqueeze(page, samples, squeezePlan, traffic, workers);
    }

    const first = samples[0];
    const last = samples[samples.length - 1];
    const mediaGained = last.currentTime - first.currentTime;
    const wallSpent = (last.atMs - first.atMs) / 1_000;
    const realtimeRatio = wallSpent > 0 ? mediaGained / wallSpent : 0;

    // ⛔ Counting from the first sample counts the startup, and this project already knows better:
    // a byte-source arm that starts scoring at `ready()` measures the join. The first run of this
    // driver reported 0.8947 for a session that ran at 1.002 once moving, because 25 seconds of
    // stationary playhead sat inside the window. Both are reported, and the steady one is the answer.
    const movedAt = samples.findIndex((s2, i) => i > 0 && s2.currentTime > samples[0].currentTime + 0.05);
    const steady = movedAt > 0 ? samples.slice(movedAt) : samples;
    const steadyWall = (steady[steady.length - 1].atMs - steady[0].atMs) / 1_000;
    const steadyRatio =
      steadyWall > 0 ? (steady[steady.length - 1].currentTime - steady[0].currentTime) / steadyWall : 0;
    const startupSeconds = movedAt > 0 ? (samples[movedAt].atMs - first.atMs) / 1_000 : 0;

    const stalls = await readStalls(page);
    const tally = await readSegmentTally(page);
    const instrument = judgeRun([await readInstrument(page)]);
    const offShell = offShellTraffic(requests);
    const gatewayLess = Object.keys(offShell.servedBytes).length === 0;

    // A window whose playhead reached the end measured the media running out, not the delivery of it.
    // ⛔⛔⛔ Judged from the SERIES rather than from a snapshot: `duration - currentTime < 2` read
    // once is the failure state on a recording and the HEALTHY state on live. See {@link isExhausted}.
    const endedAt = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { ended: v.ended, currentTime: v.currentTime, duration: v.duration } : null;
    });
    const exhausted = isExhausted(samples);
    const edgeLag = edgeLagSummary(samples);
    const edgeGrew = edgeGrowthS(samples);
    // ⛔⛔ READ OFF THE STEADY SLICE, FOR THE REASON THE RATIO ABOVE IS. A playhead that has not
    // started moving still accumulates wall clock, so every second of startup lands in this column
    // as a second of falling behind production, and the drift would then report the join. The ratio
    // beside it already learned that lesson and this was written without it.
    const behindProductionStartS = broadcastStartMs === null ? null : behindProductionS(steady[0], broadcastStartMs);
    const behindProductionEndS =
      broadcastStartMs === null ? null : behindProductionS(steady[steady.length - 1], broadcastStartMs);

    const report = {
      measuredAt,
      watchUrl,
      owner,
      topic,
      countedSeconds: Number(wallSpent.toFixed(1)),
      realtimeRatio: Number(realtimeRatio.toFixed(4)),
      steadyRealtimeRatio: Number(steadyRatio.toFixed(4)),
      // ⛔ A squeeze run waits its startup out before the first phase opens, so `movedAt` above finds
      // a playhead that was already moving and reports about one second of startup. The wait's own
      // series is the honest figure, and two fields of one artifact must not disagree about it.
      startupSeconds: Number((squeeze === null ? startupSeconds : squeeze.startup.startedMovingAfterS).toFixed(1)),
      mediaGainedS: Number(mediaGained.toFixed(2)),
      stalls,
      segments: tally,
      peersAtEnd: last.peers,
      meanBufferAheadS: Number(
        (samples.reduce((a, s) => a + ((s.bufferedEnd ?? s.currentTime) - s.currentTime), 0) / samples.length).toFixed(
          2,
        ),
      ),
      gatewayLess,
      offShellContacted: offShell.contacted,
      offShellServedBytes: offShell.servedBytes,
      live: isLive,
      exhausted,
      edgeGrowthS: edgeGrew === null ? null : Number(edgeGrew.toFixed(2)),
      appendedEdgeLagMedianS: edgeLag.medianS === null ? null : Number(edgeLag.medianS.toFixed(2)),
      appendedEdgeLagMaxS: edgeLag.maxS === null ? null : Number(edgeLag.maxS.toFixed(2)),
      behindProductionStartS: behindProductionStartS === null ? null : Number(behindProductionStartS.toFixed(2)),
      behindProductionEndS: behindProductionEndS === null ? null : Number(behindProductionEndS.toFixed(2)),
      // ⭐ The signal, not either endpoint. A viewer that holds a live edge ends the window as far
      // behind production as it started it, whatever that distance happened to be.
      behindProductionDriftS:
        behindProductionStartS === null || behindProductionEndS === null
          ? null
          : Number((behindProductionEndS - behindProductionStartS).toFixed(2)),
      endedAt,
      totalRequests: requests.length,
      instrumentSound: instrument.sound,
      instrumentFailures: instrument.failures,
      samples,
    };

    // ⛔ Three ways to be satisfied and each says which one it was. The first version of this had
    // two branches, so a run bracketed through the harness would have carried "ALLOW_NO_NODE_
    // METRICS=1" in its own artifact while holding a full set of readings, and an artifact that
    // understates its own evidence gets quoted as weakly as it describes itself.
    let nodeMetricsDiff = 'not collected, ALLOW_NO_NODE_METRICS=1';
    if (metricsBracketedBy !== '') {
      nodeMetricsDiff = `not collected here: ${metricsBracketedBy} brackets this arm`;
    } else if (bracketedHere) {
      nodeMetricsDiff = 'not snapshotted over ssh: this run read the nodes itself, see the cost section below';
    }
    if (metricsHost !== '') {
      bracketNodeMetrics(metricsHost, metricsDir, 'after');
      nodeMetricsDiff = diffNodeMetrics(metricsHost, metricsDir);
      console.log(nodeMetricsDiff);
    }
    const cost = closeHarnessBracket === null ? null : await closeHarnessBracket();
    Object.assign(report, { nodeMetricsDiff });
    if (cost !== null) {
      Object.assign(report, { cost });
    }
    if (squeeze !== null) {
      Object.assign(report, { squeeze });
    }

    const markdown = [
      `# weeb-3's own page, our broadcast, no gateway`,
      ``,
      `**${measuredAt}.** \`${watchUrl}\``,
      ``,
      `| | |`,
      `| --- | ---: |`,
      `| gateway-less | ${
        gatewayLess ? '✅ **yes**, no off-shell host contacted' : `⛔ **NO**, ${JSON.stringify(offShell)}`
      } |`,
      `| realtimeRatio, whole window | ${report.realtimeRatio} over ${report.countedSeconds}s |`,
      `| **realtimeRatio, once moving** | **${report.steadyRealtimeRatio}** |`,
      `| startup before the playhead moved | ${report.startupSeconds}s |`,
      `| stalls | ${stalls} |`,
      `| mean buffer ahead | ${report.meanBufferAheadS}s |`,
      `| segments in the log panel, done / failed | ${tally.done} / ${tally.failed} |`,
      `| ⛔ that is a ROLLING WINDOW, not a total | ${(tally.done * (tally.meanDurationS ?? 0)).toFixed(
        0,
      )}s of media against a ${report.countedSeconds}s window |`,
      `| mean segment | ${tally.meanMB ?? '?'} MB, ${tally.meanDurationS ?? '?'}s |`,
      `| resolutions seen | ${tally.resolutions.join(', ') || 'not reported'} |`,
      `| peers at end | ${last.peers ?? '?'} |`,
      `| requests, all hosts | ${requests.length} |`,
      `| off-shell contact | ${JSON.stringify(offShell.contacted)} (served bytes: ${JSON.stringify(
        offShell.servedBytes,
      )}) |`,
      `| arm | ${
        isLive ? '**LIVE**, the edge was held, nothing was sought' : 'recording, sought to have media ahead'
      } |`,
      `| edge advanced across the window | ${edgeGrew === null ? 'no edge readings' : `${edgeGrew.toFixed(1)}s`} |`,
      `| distance from the **appended** edge, median | ${edgeLag.medianS?.toFixed(2) ?? '—'}s (max ${
        edgeLag.maxS?.toFixed(2) ?? '—'
      }s) |`,
      `| **behind production, start → end** | ${
        behindProductionStartS === null
          ? '⚠️ no publisher clock, this arm cannot be ranked'
          : `**${behindProductionStartS.toFixed(2)}s → ${behindProductionEndS?.toFixed(2) ?? '—'}s** ` +
            `(drift ${((behindProductionEndS ?? 0) - behindProductionStartS).toFixed(2)}s)`
      } |`,
      `| media ran out inside the window | ${exhausted ? '⛔ **yes, the ratio is void**' : 'no'} |`,
      ``,
      ...(squeeze === null ? [] : renderNativeSqueezeSection(squeeze)),
      `## What the bee nodes themselves recorded over the same window`,
      ``,
      '```',
      nodeMetricsDiff.trimEnd(),
      '```',
      ``,
      ...(cost === null ? [] : costSection(cost)),
      `⛔⛔ **The appended-edge distance is NOT hls.js's \`latency\` and cannot be compared with one.**`,
      `weeb-3's page exposes no player handle, so that figure is unreachable from outside it. An edge`,
      `only moves once a segment has been fetched and appended, so a SLOWER node reports a SMALLER`,
      `distance. Rank arms on the behind-production row, which is read off the publisher's clock.`,
      ``,
      `⚠️ The visibility sensor passes by construction here, because Playwright forces a visible page.`,
      `Instrument verdict: ${instrument.sound ? 'sound' : instrument.failures.join('; ')}`,
      ``,
    ].join('\n');

    const written = await writeRunArtifacts('weeb3-native', runId, {
      markdown,
      run: report,
      // ⭐ A squeeze run files the tab's WebSocket frames instead of its HTTP requests. The gate
      // above still reads every request, and the interesting log on a gateway-less arm is the one
      // transport that carried anything: the HTTP log is the app shell and a handful of misses.
      requests: squeeze === null ? thinRequestLog(requests) : thinFrames(traffic.frames),
    });
    console.log(`weeb3-native: wrote ${written}`);

    console.log(
      `weeb3-native: realtimeRatio ${report.realtimeRatio}, stalls ${stalls}, buffer ${report.meanBufferAheadS}s`,
    );
    console.log(`weeb3-native: segments done ${tally.done}, failed ${tally.failed}, mean ${tally.meanMB ?? '?'} MB`);
    console.log(`weeb3-native: ${requests.length} requests, off-shell hosts ${JSON.stringify(offShell)}`);
    // ⭐ Zero BZZ is the expectation on a gateway-less arm, so the interesting line here is a
    // warning: a batch filling or a chequebook draining means the stage spent on something, and
    // this run is meant to have spent on nothing.
    cost?.warnings.forEach((warning) => console.log(`  ⚠️ ${warning}`));

    if (squeeze !== null) {
      // ⛔ The instrument first and above the heading that says nothing after it is asserted. A
      // console that printed only a ratio is how the readings of 2026-09-02 came to be believed.
      console.log(`weeb3-native: ${nativeSqueezeInstrumentLine(squeeze)}`);
      console.log('weeb3-native: observations, none of them asserted');
      console.log(`weeb3-native: ${nativeSqueezeConsoleLine(squeeze)}`);
    }

    // ⛔⛔⛔ After the artifact is on disk, for the reason the gateway-less gate below is: a refused
    // run's artifact carries the reading that refused it. Neither check proves the cap landed, and
    // both rule out the failures that voided this driver's squeeze runs of 2026-09-02, a cap applied
    // to a page session the node's sockets do not belong to and a recorder listening on the same one.
    if (squeeze !== null) {
      const { capRefusal, recorderRefusal } = judgeNativeSqueezeInstrument(squeeze);
      const refusal = capRefusal ?? recorderRefusal;
      if (refusal !== null) {
        console.error(`weeb3-native: ⛔ REFUSED, no figure under the cap is a reading of a capped link: ${refusal}`);
        exitCode = 1;
      }
    }

    if (!gatewayLess) {
      console.error(
        `weeb3-native: ⛔ REFUSED. The page contacted ${JSON.stringify(offShell)}. This is not a gateway-less arm.`,
      );
      exitCode = 1;
    }
  } finally {
    await workers.close().catch((error) => console.error('could not close the worker CDP client:', error));
    await browser.close();
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
