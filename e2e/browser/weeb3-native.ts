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
 * Usage, against a broadcast that already exists:
 *   WEEB3_NATIVE_OWNER=<owner> WEEB3_NATIVE_TOPIC=<rawTopic> pnpm browser:weeb3-native
 */

import { execFileSync } from 'node:child_process';
import { type Page } from 'playwright-core';

import { judgeRun } from '../src/browser/instrument.js';
import { type RequestRecord } from '../src/browser/network.js';
import { envNumber, requireEnv, runIdFrom, thinRequestLog, writeRunArtifacts } from '../src/browser/runFiles.js';
import { installTimerProbe, launchViewer, readInstrument, recordRequests, VIEWPORT } from '../src/browser/viewer.js';

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
 * Set `WEEB3_NATIVE_METRICS_SSH` to the host running the nodes, or `ALLOW_NO_NODE_METRICS=1` to say
 * out loud that this run has no node-side evidence.
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Sample {
  atMs: number;
  currentTime: number;
  bufferedEnd: number | null;
  readyState: number;
  paused: boolean;
  peers: number | null;
}

/** What weeb-3's own log says about each segment it tried. Its wording, not ours. */
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
      readyState: v ? v.readyState : 0,
      paused: v ? v.paused : true,
      peers: peers ? Number(peers[1]) : null,
    };
  });
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

async function main(): Promise<void> {
  const owner = requireEnv('WEEB3_NATIVE_OWNER');
  const topic = requireEnv('WEEB3_NATIVE_TOPIC');
  const pageUrl = process.env.WEEB3_NATIVE_PAGE ?? DEFAULT_PAGE;
  const bootSeconds = envNumber('WEEB3_NATIVE_BOOT_S', 180);
  const watchSeconds = envNumber('WEEB3_NATIVE_WATCH_S', 180);
  /** Where to put the playhead before counting. Negative counts back from the end. 0 is the start. */
  const startAtSeconds = envNumber('WEEB3_NATIVE_START_S', 0);

  const metricsHost = process.env.WEEB3_NATIVE_METRICS_SSH ?? '';
  const metricsRoot = process.env.WEEB3_NATIVE_METRICS_DIR ?? '/home/solarpunk/node-metrics-weeb3native';
  if (metricsHost === '' && process.env.ALLOW_NO_NODE_METRICS !== '1') {
    throw new Error(
      'refusing to run without node metrics. Set WEEB3_NATIVE_METRICS_SSH=<host> to bracket the run ' +
        'with the bee nodes own counters, or ALLOW_NO_NODE_METRICS=1 to record that this run has no ' +
        'node-side evidence for its gateway-less claim.',
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
  console.log(`weeb3-native: boot budget ${bootSeconds}s, counted window ${watchSeconds}s`);

  if (metricsHost !== '') {
    bracketNodeMetrics(metricsHost, metricsDir, 'before');
  }

  const browser = await launchViewer();
  const requests: RequestRecord[] = [];
  let exitCode = 0;

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await installTimerProbe(page);
    await installStallCounter(page);
    recordRequests(page, requests);

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

    // ⛔⛔⛔ weeb-3 opens a finished broadcast AT ITS LIVE EDGE, which is the end of the recording.
    // The first run of this driver counted 180s in which the playhead sat on the final frame and
    // reported realtimeRatio 0.068, which reads as a delivery failure and is nothing of the kind.
    // Seek back so there is media ahead of the playhead, then count.
    await page.evaluate((startAt: number) => {
      const v = document.querySelector('video');
      if (!v) {
        return;
      }
      if (Number.isFinite(v.duration) && v.duration > 0) {
        v.currentTime = startAt >= 0 ? startAt : Math.max(0, v.duration + startAt);
      }
      void v.play();
    }, startAtSeconds);
    await sleep(SAMPLE_INTERVAL_MS);

    const samples: Sample[] = [];
    const countedFrom = Date.now();
    while (Date.now() - countedFrom < watchSeconds * 1_000) {
      samples.push(await readSample(page));
      await sleep(SAMPLE_INTERVAL_MS);
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

    const stalls = await page.evaluate(() => (window as unknown as { __stalls?: number }).__stalls ?? 0);
    const tally = await readSegmentTally(page);
    const instrument = judgeRun([await readInstrument(page)]);
    const offShell = offShellTraffic(requests);
    const gatewayLess = Object.keys(offShell.servedBytes).length === 0;

    // A window whose playhead reached the end measured the recording running out, not delivery.
    const endedAt = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { ended: v.ended, currentTime: v.currentTime, duration: v.duration } : null;
    });
    const exhausted =
      endedAt !== null && Number.isFinite(endedAt.duration) && endedAt.duration - endedAt.currentTime < 2;

    const report = {
      measuredAt,
      watchUrl,
      owner,
      topic,
      countedSeconds: Number(wallSpent.toFixed(1)),
      realtimeRatio: Number(realtimeRatio.toFixed(4)),
      steadyRealtimeRatio: Number(steadyRatio.toFixed(4)),
      startupSeconds: Number(startupSeconds.toFixed(1)),
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
      exhausted,
      endedAt,
      totalRequests: requests.length,
      instrumentSound: instrument.sound,
      instrumentFailures: instrument.failures,
      samples,
    };

    let nodeMetricsDiff = 'not collected, ALLOW_NO_NODE_METRICS=1';
    if (metricsHost !== '') {
      bracketNodeMetrics(metricsHost, metricsDir, 'after');
      nodeMetricsDiff = diffNodeMetrics(metricsHost, metricsDir);
      console.log(nodeMetricsDiff);
    }
    Object.assign(report, { nodeMetricsDiff });

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
      `| segments done / failed | **${tally.done} / ${tally.failed}** |`,
      `| mean segment | ${tally.meanMB ?? '?'} MB, ${tally.meanDurationS ?? '?'}s |`,
      `| resolutions seen | ${tally.resolutions.join(', ') || 'not reported'} |`,
      `| peers at end | ${last.peers ?? '?'} |`,
      `| requests, all hosts | ${requests.length} |`,
      `| off-shell contact | ${JSON.stringify(offShell.contacted)} (served bytes: ${JSON.stringify(
        offShell.servedBytes,
      )}) |`,
      `| playhead exhausted the recording | ${exhausted ? '⛔ **yes, the ratio is void**' : 'no'} |`,
      ``,
      `## What the bee nodes themselves recorded over the same window`,
      ``,
      '```',
      nodeMetricsDiff.trimEnd(),
      '```',
      ``,
      `⚠️ The visibility sensor passes by construction here, because Playwright forces a visible page.`,
      `Instrument verdict: ${instrument.sound ? 'sound' : instrument.failures.join('; ')}`,
      ``,
    ].join('\n');

    const written = await writeRunArtifacts('weeb3-native', runId, {
      markdown,
      run: report,
      requests: thinRequestLog(requests),
    });
    console.log(`weeb3-native: wrote ${written}`);

    console.log(
      `weeb3-native: realtimeRatio ${report.realtimeRatio}, stalls ${stalls}, buffer ${report.meanBufferAheadS}s`,
    );
    console.log(`weeb3-native: segments done ${tally.done}, failed ${tally.failed}, mean ${tally.meanMB ?? '?'} MB`);
    console.log(`weeb3-native: ${requests.length} requests, off-shell hosts ${JSON.stringify(offShell)}`);

    if (!gatewayLess) {
      console.error(
        `weeb3-native: ⛔ REFUSED. The page contacted ${JSON.stringify(offShell)}. This is not a gateway-less arm.`,
      );
      exitCode = 1;
    }
  } finally {
    await browser.close();
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
