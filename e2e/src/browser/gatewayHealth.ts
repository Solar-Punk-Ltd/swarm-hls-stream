/**
 * What the gateway node itself was doing while a viewer watched it.
 *
 * ## Why this exists
 *
 * `docs/bench/the-fourteen-minute-collapse-2026-08-07.md` located a read-path slowdown to the second
 * and to the layer, and closed on the one thing it could not answer: **what slowed the node.** Every
 * figure in that report was measured at the browser, and a browser can see that answers got slower
 * without seeing why. The recommendation it ended on was to instrument rather than to buy a repro,
 * since one occurrence in fifteen runs costs around 11 BZZ to catch again and nothing to catch on a
 * run that was going to happen anyway. This is that instrument.
 *
 * ## What it samples, and why these three
 *
 * Each answers a hypothesis the browser data cannot separate:
 *
 * - **`/health` service time.** That endpoint touches no chunks, so a slow one is a slow node where a
 *   slow `/bytes/` could be a slow node, a slow peer or a slow disk. This is the sharpest single
 *   signal available for the price of one request.
 * - **The host's load average.** Separates a busy node from a busy box. The deployment shares a host
 *   with five other compose projects, so a neighbour is a live hypothesis and an untestable one today.
 * - **Connected peers and reachability.** Retrieval goes through peers, and losing them is a way for
 *   retrieval to get slower with the node itself perfectly healthy.
 *
 * ⚠️ **Deliberately not `/metrics`.** Parsing a Prometheus dump is version-coupled work with no
 * hypothesis behind it yet. If a captured occurrence is not explained by the three above, that dump
 * is the next thing to reach for and this is where it would go.
 *
 * ## Nothing here may end a run
 *
 * A bench run costs BZZ and the browser measurement is what it is for. Every failure, from an ssh
 * drop to output that is not the expected shape, becomes a sample that says the node did not answer.
 * That is an observation rather than an error, and it is the observation a total outage would produce.
 */

import { type E2EConfig } from '../config.js';
import { type Host } from '../harness/host.js';

import { PLUR_PER_BZZ } from './resources.js';

/** How often to sample. Fine enough to place a step inside the minute it happened, coarse enough that
 *  the ssh round trips are a rounding error against a twenty-minute run. */
export const DEFAULT_GATEWAY_SAMPLE_INTERVAL_MS = 5_000;

/** How long the remote curls may take before the sample counts as unanswered. */
const CURL_TIMEOUT_S = 5;

/** Service time above which the node is slow enough that a viewer would feel it. */
const SLOW_SERVICE_MS = 250;

/** Step in per-minute median service time worth naming. Below this is ordinary run-to-run variation. */
const SERVICE_STEP_WORTH_NAMING = 2;

/** Share of the starting peer count below which the node has lost the peers it retrieves through. */
const PEER_LOSS_SHARE = 0.5;

/**
 * How deep a peer's debt must be, against the deepest one the node holds, to count as pinned.
 *
 * Self-calibrating on purpose. Bee reports `thresholdreceived` and `thresholdgiven` as null on this
 * deployment, so the ceiling cannot be read off the node and assuming a default would make every
 * reading a statement about the assumption. What a ceiling looks like from below is peers *clustered*
 * at a common depth, and that shape is visible without knowing where the ceiling is.
 */
const PINNED_SHARE_OF_DEEPEST_DEBT = 0.9;

/**
 * Spendable balance below which the gateway is about to stop paying for reads.
 *
 * Not zero, because zero is the state to be warned *before* reaching. At the 0.123 BZZ per thirty
 * minutes of 720p measured on this deployment, this is roughly two hours of warning.
 */
const CHEQUEBOOK_FLOOR_BZZ = 0.5;

const MS_PER_MINUTE = 60_000;

/**
 * What the node owes the peers it retrieves through, reduced to the shape of the distribution.
 *
 * A negative balance is data taken and not yet paid for. A node that cannot settle accumulates those
 * until each peer stops serving it, so the signature of a starved node is not one deep debt but many
 * peers at a **common** depth: the ceiling, seen from below.
 */
export interface PeerAccounting {
  /** Peers bee holds a balance for. Larger than the connected count, since a balance outlives a link. */
  peers: number;
  /** Peers this node owes, having taken more than it has given. */
  inDebt: number;
  /** The largest single debt in PLUR, always at or below zero. Zero means the node owes nobody. */
  deepestDebtPlur: number;
  /** How many peers sit within {@link PINNED_SHARE_OF_DEEPEST_DEBT} of that deepest debt. */
  pinnedPeers: number;
}

export interface GatewaySample {
  atMs: number;
  /** Whether bee answered `/health` with a 200. False covers every failure, including ssh. */
  answered: boolean;
  /** What the request took **on the host**, so the figure carries no ssh latency. Null if unknown. */
  serviceMs: number | null;
  connectedPeers: number | null;
  neighbourhoodSize: number | null;
  isReachable: boolean | null;
  /** A node still warming up is slow for a reason that is neither a fault nor worth chasing. */
  isWarmingUp: boolean | null;
  /** The host's own one-minute load average, which is about the box rather than about bee. */
  hostLoad1: number | null;
  /**
   * What the node has left to pay for reads with, in BZZ.
   *
   * ⛔ Added after this module shipped, because checking the deployment before its first proving run
   * found this at **0.0000007 BZZ** against a 14.7 BZZ chequebook, all of it committed to outstanding
   * cheques. Every other signal here was healthy: `/health` in 1.1ms, 134 peers, reachability Public.
   * A gateway in that state cannot issue cheques and is throttled by its peers to the free tier, which
   * is a read path slowing down for a reason no amount of node health would show.
   */
  chequebookAvailableBzz: number | null;
  /**
   * ⭐ The one mechanism the rest of this file cannot see, and the term Phase 0.6 closed on.
   *
   * An unfunded gateway moved segments 2 to 4x slower than a funded one and was 24% faster on one
   * night than another for no measured reason. Everything else here was **identical** across both
   * arms: 134 peers, a 135-node neighbourhood, `/health` in 1ms, host load overlapping and moving the
   * wrong way. Retrieval is paid for per peer, so what the node owes them is where a difference that
   * large can hide while every health signal stays green. Null when the read failed, which is a
   * different statement from a node that owes nobody anything.
   */
  accounting: PeerAccounting | null;
}

export interface GatewayMinute {
  minute: number;
  samples: number;
  /** Median rather than mean, so one slow sample does not carry a minute. */
  medianServiceMs: number | null;
  unanswered: number;
  /** The lowest count seen in the minute, since losing peers is what matters and regaining them hides it. */
  connectedPeers: number | null;
  maxHostLoad1: number | null;
  /** The lowest seen in the minute, since running out is what matters and a top-up would hide it. */
  chequebookAvailableBzz: number | null;
  /** The most peers owed at once in the minute. */
  peersInDebt: number | null;
  /** The deepest debt reached in the minute, since a debt settled inside it was still reached. */
  deepestDebtPlur: number | null;
  /** The most peers seen pinned against that depth at once. */
  pinnedPeers: number | null;
}

export interface GatewayHealth {
  minutes: GatewayMinute[];
  /** Slowest minute's median over the fastest minute's, or null when no minute has a median. */
  serviceStepRatio: number | null;
  /** Which minute held the slowest median, so it can be lined up against the browser's own table. */
  slowestMinute: number | null;
  unanswered: number;
  warnings: string[];
}

/**
 * Reduce bee's balance list to four figures **on the host**, before it crosses the wire.
 *
 * ⚠️ `/balances` is 45 kB on this deployment because it carries all 323 peers, against `/status`'s 351
 * bytes. Shipped whole at one sample every five seconds that is around 11 MB over a twenty-minute run,
 * moved across the host the run is measuring, which is the `/topology` mistake this module already
 * carries a warning about. Reduced here it is under forty bytes and the 45 kB never leaves localhost.
 * Measured on the node itself: `/balances` answers in 8-9ms against `/health`'s 1.1ms, so at this
 * cadence the instrument occupies the node for under two parts in a thousand.
 *
 * Emits nothing at all when there are no balances to read, so a refused endpoint reads as a failed
 * sample rather than as a node that owes nobody anything.
 */
function balancesReduction(): string {
  return [
    `grep -o '"balance":"-\\{0,1\\}[0-9]\\{1,\\}"'`,
    `tr -dc '0-9\\n-'`,
    `awk '{n++; v[n]=$1+0; if(n==1||v[n]<m) m=v[n]; if(v[n]<0) d++} ` +
      `END{if(n==0) exit; if(m>0) m=0; p=0; ` +
      `if(m<0){t=m*${PINNED_SHARE_OF_DEEPEST_DEBT}; for(i=1;i<=n;i++) if(v[i]<=t) p++} ` +
      `print n, d+0, m, p}'`,
  ].join(' | ');
}

/**
 * The one remote command a sample costs, emitting five lines.
 *
 * Line-oriented rather than assembled into JSON on the host: quoting a JSON document through a shell
 * through ssh is how a sampler starts reporting its own escaping. Both JSON documents have their
 * newlines stripped so the lines stay aligned, and the status document goes last so that anything it
 * emits beyond one line cannot displace a field.
 *
 * ⚠️ `/status` rather than `/topology`, which was the first version and was measured at **390 kB a
 * sample** because it carries every peer's metrics. At one sample every five seconds that is around
 * 94 MB over a twenty-minute run, moved across the same host the run is measuring. `/status` is 351
 * bytes and names the same things more directly. An instrument that perturbs its subject is the
 * failure this whole file exists downstream of.
 *
 * `|| true` on each, because a curl that fails must still leave the later lines in place. A sample
 * that lost only its host load is worth more than one that lost everything.
 */
function sampleCommand(gatewayPort: number): string {
  const bee = `http://localhost:${gatewayPort}`;
  return [
    `curl -s -o /dev/null -m ${CURL_TIMEOUT_S} -w '%{time_total} %{http_code}' ${bee}/health || true`,
    `echo`,
    `cut -d' ' -f1 /proc/loadavg 2>/dev/null || true`,
    `curl -s -m ${CURL_TIMEOUT_S} ${bee}/chequebook/balance 2>/dev/null | tr -d '\\n' || true`,
    `echo`,
    `curl -s -m ${CURL_TIMEOUT_S} ${bee}/balances 2>/dev/null | ${balancesReduction()} | tr -d '\\n' || true`,
    `echo`,
    `curl -s -m ${CURL_TIMEOUT_S} ${bee}/status 2>/dev/null | tr -d '\\n' || true`,
  ].join('; ');
}

const UNANSWERED = {
  answered: false,
  serviceMs: null,
  connectedPeers: null,
  neighbourhoodSize: null,
  isReachable: null,
  isWarmingUp: null,
  hostLoad1: null,
  chequebookAvailableBzz: null,
  accounting: null,
} as const;

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOrNull(text: string | undefined): number | null {
  if (text === undefined || text.trim() === '') {
    return null;
  }
  return finiteOrNull(Number(text));
}

interface NodeStatus {
  connectedPeers?: unknown;
  neighborhoodSize?: unknown;
  isReachable?: unknown;
  isWarmingUp?: unknown;
}

function parseJsonLine(line: string | undefined): NodeStatus {
  if (line === undefined || line.trim() === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? (parsed as NodeStatus) : {};
  } catch {
    // A node too busy to serve `/status` is exactly the case being measured, and its reverse proxy
    // answering with HTML is one shape that takes. Losing the peer counts does not cost the timing.
    return {};
  }
}

/**
 * The four figures {@link balancesReduction} printed, or null when it printed anything else.
 *
 * Null rather than zeroes for every failure shape, because `/balances` is reached on the same port as
 * `/chequebook/balance`, which answers **405** on an ultra-light node. Four zeroes there would read as
 * a node that owes nobody, which is the precise opposite of the state this exists to catch.
 */
function parseAccounting(line: string | undefined): PeerAccounting | null {
  const figures = (line ?? '').trim().split(/\s+/).map(numberOrNull);
  if (figures.length !== 4 || figures.some((figure) => figure === null)) {
    return null;
  }
  const [peers, inDebt, deepestDebtPlur, pinnedPeers] = figures as number[];
  return { peers, inDebt, deepestDebtPlur, pinnedPeers };
}

/** Read one sample out of what {@link sampleCommand} printed. Never throws. */
export function parseGatewaySample(stdout: string, atMs: number): GatewaySample {
  const [timing = '', load = '', chequebook = '', accounting = '', ...rest] = stdout.split('\n');
  const [seconds, status] = timing.trim().split(/\s+/);
  const serviceMs = numberOrNull(seconds);

  if (serviceMs === null || status !== '200') {
    // The timing survives a refusal, because a node refusing quickly and a node refusing slowly are
    // different faults. It does not survive output that was never a timing at all.
    return { ...UNANSWERED, atMs, serviceMs: serviceMs === null ? null : Math.round(serviceMs * 1_000) };
  }

  const nodeStatus = parseJsonLine(rest.join(''));
  return {
    atMs,
    answered: true,
    serviceMs: Math.round(serviceMs * 1_000),
    connectedPeers: finiteOrNull(nodeStatus.connectedPeers),
    neighbourhoodSize: finiteOrNull(nodeStatus.neighborhoodSize),
    isReachable: typeof nodeStatus.isReachable === 'boolean' ? nodeStatus.isReachable : null,
    isWarmingUp: typeof nodeStatus.isWarmingUp === 'boolean' ? nodeStatus.isWarmingUp : null,
    hostLoad1: numberOrNull(load),
    chequebookAvailableBzz: availableBzz(chequebook),
    accounting: parseAccounting(accounting),
  };
}

/**
 * Spendable balance in BZZ, from what bee quotes in PLUR.
 *
 * A string rather than a number in bee's own reply, because the values overflow what a double holds
 * exactly. Read through `Number` here deliberately: the question this answers is whether the node can
 * still pay, and the ~0.0000007 BZZ that prompted this reading is not a figure precision changes.
 */
function availableBzz(line: string): number | null {
  const balance = parseJsonLine(line) as { availableBalance?: unknown };
  if (typeof balance.availableBalance !== 'string') {
    return null;
  }
  return finiteOrNull(Number(balance.availableBalance) / PLUR_PER_BZZ);
}

/** How a sample reaches the host. Injected so the loop above it is testable without one. */
export type GatewayReader = () => Promise<string>;

export function gatewayReader(host: Host, cfg: E2EConfig): GatewayReader {
  return async () => (await host.run(sampleCommand(cfg.ports.beeGatewayApi))).stdout;
}

/** One sample, with every failure recorded rather than raised. */
export async function sampleGatewayWith(read: GatewayReader, atMs: number): Promise<GatewaySample> {
  try {
    return parseGatewaySample(await read(), atMs);
  } catch {
    return { ...UNANSWERED, atMs };
  }
}

export interface GatewaySampling {
  /** Stop sampling and hand back everything collected. Safe to call more than once. */
  stop: () => Promise<GatewaySample[]>;
}

export interface GatewaySamplingOptions {
  read: GatewayReader;
  intervalMs?: number;
  now?: () => number;
}

/**
 * Sample the gateway until stopped, alongside whatever else the run is doing.
 *
 * Its own loop rather than a hook inside the browser sampler, because the two have different
 * failure modes and different cadences, and a node-side reading that a browser stall could suppress
 * would be blind in exactly the situation it exists for.
 */
export function startGatewaySampling(options: GatewaySamplingOptions): GatewaySampling {
  const { read, intervalMs = DEFAULT_GATEWAY_SAMPLE_INTERVAL_MS, now = Date.now } = options;
  const samples: GatewaySample[] = [];
  let running = true;
  let wake: (() => void) | null = null;

  /**
   * The gap between samples, cut short the moment sampling stops.
   *
   * Two properties, both learned the hard way. **Cancellable**, so `stop` returns promptly instead of
   * sitting out the rest of an interval while the report waits on it. And **unreferenced**, so a
   * sampler that somehow fails to stop cannot hold the process open: a loop that outlives its run is
   * a bug, and a bug that hangs is strictly worse than one that is reported, because a hung run says
   * nothing at all about anything.
   */
  const sleep = (): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      timer.unref?.();
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const loop = (async () => {
    while (running) {
      try {
        samples.push(await sampleGatewayWith(read, now()));
      } catch {
        // Belt as well as braces. `sampleGatewayWith` swallows everything today, and if that ever
        // stops being true the rejection would travel out of this loop into `stop`, which is awaited
        // while the report is being assembled. The run would then be lost to its own instrument.
        samples.push({ ...UNANSWERED, atMs: now() });
      }
      if (!running) {
        break;
      }
      await sleep();
    }
  })();

  return {
    stop: async () => {
      running = false;
      wake?.();
      // Awaited rather than abandoned, so a sample already in flight lands before the report is
      // rendered and nothing writes into the array after the run has been serialised. Bounded by the
      // sample interval plus the remote curl timeout, both of which are seconds.
      await loop;
      return samples;
    },
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function minuteOf(samples: GatewaySample[], minute: number): GatewayMinute {
  const answered = samples.filter((sample) => sample.answered);
  const peers = answered.map((sample) => sample.connectedPeers).filter((value): value is number => value !== null);
  const loads = samples.map((sample) => sample.hostLoad1).filter((value): value is number => value !== null);
  const balances = samples
    .map((sample) => sample.chequebookAvailableBzz)
    .filter((value): value is number => value !== null);
  const accounting = samples
    .map((sample) => sample.accounting)
    .filter((value): value is PeerAccounting => value !== null);

  // The worst of the minute rather than its last, in every accounting column: a node that spent a
  // minute pinned against its ceiling and settled in the final sample of it was pinned for that
  // minute, and the browser table this is read beside reports the minute a buffer fell in.
  const owed = accounting.map((a) => a.inDebt);
  const debts = accounting.map((a) => a.deepestDebtPlur);
  const pinned = accounting.map((a) => a.pinnedPeers);

  return {
    minute,
    samples: samples.length,
    medianServiceMs: median(answered.map((sample) => sample.serviceMs).filter((ms): ms is number => ms !== null)),
    unanswered: samples.length - answered.length,
    connectedPeers: peers.length > 0 ? Math.min(...peers) : null,
    maxHostLoad1: loads.length > 0 ? Math.max(...loads) : null,
    chequebookAvailableBzz: balances.length > 0 ? Math.min(...balances) : null,
    peersInDebt: owed.length > 0 ? Math.max(...owed) : null,
    deepestDebtPlur: debts.length > 0 ? Math.min(...debts) : null,
    pinnedPeers: pinned.length > 0 ? Math.max(...pinned) : null,
  };
}

/**
 * What the node did, per minute of the run.
 *
 * Per minute rather than as one figure, and in the same unit the browser report already uses, because
 * the question this answers is always "what was the node doing when the viewer's buffer fell". A pair
 * of tables that line up answers that. A pair of averages does not.
 */
export function summarizeGateway(samples: GatewaySample[]): GatewayHealth {
  if (samples.length === 0) {
    return {
      minutes: [],
      serviceStepRatio: null,
      slowestMinute: null,
      unanswered: 0,
      warnings: ['no gateway samples were collected, so this run says nothing about the node'],
    };
  }

  const startMs = samples[0].atMs;
  const byMinute = new Map<number, GatewaySample[]>();
  for (const sample of samples) {
    const minute = Math.floor((sample.atMs - startMs) / MS_PER_MINUTE);
    byMinute.set(minute, [...(byMinute.get(minute) ?? []), sample]);
  }

  const minutes = [...byMinute.entries()]
    .sort(([a], [b]) => a - b)
    .map(([minute, inMinute]) => minuteOf(inMinute, minute));

  const withMedian = minutes.filter(
    (m): m is GatewayMinute & { medianServiceMs: number } => m.medianServiceMs !== null,
  );
  const slowest = withMedian.reduce<(GatewayMinute & { medianServiceMs: number }) | null>(
    (worst, m) => (worst === null || m.medianServiceMs > worst.medianServiceMs ? m : worst),
    null,
  );
  const fastest = withMedian.reduce<number | null>(
    (best, m) => (best === null || m.medianServiceMs < best ? m.medianServiceMs : best),
    null,
  );

  const serviceStepRatio =
    slowest !== null && fastest !== null && fastest > 0 ? slowest.medianServiceMs / fastest : null;
  const unanswered = minutes.reduce((total, m) => total + m.unanswered, 0);

  return {
    minutes,
    serviceStepRatio,
    slowestMinute: slowest?.minute ?? null,
    unanswered,
    warnings: warningsFor(minutes, slowest, serviceStepRatio, unanswered),
  };
}

function warningsFor(
  minutes: GatewayMinute[],
  slowest: (GatewayMinute & { medianServiceMs: number }) | null,
  serviceStepRatio: number | null,
  unanswered: number,
): string[] {
  const warnings: string[] = [];

  if (slowest !== null && serviceStepRatio !== null && serviceStepRatio >= SERVICE_STEP_WORTH_NAMING) {
    warnings.push(
      `the node's own service time stepped ${serviceStepRatio.toFixed(2)}x during the run, worst in minute ` +
        `${slowest.minute} at ${slowest.medianServiceMs}ms. /health touches no chunks, so this is the node ` +
        'rather than the retrieval path',
    );
  }
  if (slowest !== null && slowest.medianServiceMs >= SLOW_SERVICE_MS) {
    warnings.push(
      `the node took ${slowest.medianServiceMs}ms to answer /health in minute ${slowest.minute}, which is slow ` +
        'enough that a viewer would feel it on every request behind it',
    );
  }
  if (unanswered > 0) {
    warnings.push(`the node did not answer ${unanswered} of ${minutes.reduce((n, m) => n + m.samples, 0)} samples`);
  }

  const lowestBalance = minutes
    .map((m) => m.chequebookAvailableBzz)
    .filter((value): value is number => value !== null)
    .reduce<number | null>((lowest, bzz) => (lowest === null || bzz < lowest ? bzz : lowest), null);
  if (lowestBalance !== null && lowestBalance < CHEQUEBOOK_FLOOR_BZZ) {
    warnings.push(
      `the gateway had ${lowestBalance.toFixed(4)} BZZ left to pay for reads with, against a floor of ` +
        `${CHEQUEBOOK_FLOOR_BZZ}. A node that cannot issue cheques is throttled by its peers to the free tier, ` +
        'which slows the read path with every other signal here still healthy',
    );
  }

  // ⛔ Not a threshold on how pinned is too pinned. No sitting has measured what an unfunded gateway's
  // debt distribution looks like yet, so any number here would be a guess dressed as a gate. What is
  // worth catching before then is the instrument reporting nothing at all: `/balances` shares a port
  // with `/chequebook/balance`, which answers 405 on an ultra-light node, and a column of dashes reads
  // like a node with nothing to report rather than a node that was never successfully asked.
  if (minutes.every((m) => m.deepestDebtPlur === null)) {
    warnings.push(
      'no sample carried peer accounting, so this run says nothing about whether the node was starved of ' +
        'credit. /balances is reached on the same port as the chequebook, which answers 405 on an ultra-light node',
    );
  }

  const peerCounts = minutes.map((m) => m.connectedPeers).filter((value): value is number => value !== null);
  if (peerCounts.length > 1 && Math.min(...peerCounts) < peerCounts[0] * PEER_LOSS_SHARE) {
    warnings.push(
      `connected peers fell from ${peerCounts[0]} to ${Math.min(...peerCounts)} during the run, which is a way for ` +
        'retrieval to slow down with the node itself healthy',
    );
  }

  return warnings;
}

/** The gateway's own table, in the minutes the browser report already uses so the two line up. */
export function gatewaySection(health: GatewayHealth): string[] {
  const lines = ['## What the gateway node was doing', ''];

  if (health.minutes.length === 0) {
    return [...lines, ...health.warnings.map((warning) => `⚠️ ${warning}`)];
  }

  lines.push(
    '| minute | samples | median /health | unanswered | peers | host load | BZZ to spend | owed | deepest debt | pinned |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...health.minutes.map(
      (m) =>
        [
          `| ${m.minute}`,
          m.samples,
          m.medianServiceMs === null ? '—' : `${m.medianServiceMs}ms`,
          m.unanswered,
          m.connectedPeers ?? '—',
          m.maxHostLoad1?.toFixed(2) ?? '—',
          m.chequebookAvailableBzz?.toFixed(4) ?? '—',
          m.peersInDebt ?? '—',
          m.deepestDebtPlur ?? '—',
          m.pinnedPeers ?? '—',
        ].join(' | ') + ' |',
    ),
    '',
  );

  if (health.warnings.length === 0) {
    lines.push('✅ The node answered every sample at a steady service time, so it did not cause anything here.');
  } else {
    lines.push(...health.warnings.map((warning) => `⚠️ ${warning}`));
  }

  return [...lines, ''];
}
