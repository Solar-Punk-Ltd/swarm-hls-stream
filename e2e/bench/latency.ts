/**
 * `pnpm bench:latency` — measure glass-to-glass latency against a deployed stack, and write the
 * report a later sprint is compared against. This is LAT-1.
 *
 * Runs in this order for a reason: everything that can fail for free fails first. The instrument
 * checks itself locally, then the gateway is proved reachable, then the deployment's log level is
 * read — and only then does a publish begin and postage start being spent.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { requireGatewayReachable } from '../src/bench/gateway.js';
import { renderReport } from '../src/bench/report.js';
import { measureLatency } from '../src/bench/run.js';
import { checkInstrumentLocally } from '../src/bench/selfCheck.js';
import { DEFAULT_KNOBS, type PublishKnobs } from '../src/bench/wallclockPublisher.js';
import { containerName, loadConfig, ROOT_DIR } from '../src/config.js';
import { makeHost, uploaderHealth } from '../src/harness/host.js';
import { effectiveLogLevel, logLevelProblem } from '../src/logLevel.js';

const DEFAULT_SAMPLES = 5;
/**
 * How often the bench asks the feed for a new manifest.
 *
 * Two seconds rather than the client's own cadence, because this measures how quickly a segment
 * *could* be seen. A slower poll would add its own wait to the propagation hop and report it as the
 * network's. What a real viewer's poll adds on top is a separate, known quantity.
 */
const DEFAULT_POLL_MS = 2_000;

const REPORT_DIR = join(ROOT_DIR, 'docs', 'bench');

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

function knobsFromEnv(): PublishKnobs {
  return {
    fps: envNumber('BENCH_FPS', DEFAULT_KNOBS.fps),
    gopSeconds: envNumber('BENCH_GOP_SECONDS', DEFAULT_KNOBS.gopSeconds),
    videoBitrateKbps: envNumber('BENCH_BITRATE_KBPS', DEFAULT_KNOBS.videoBitrateKbps),
    size: process.env.BENCH_SIZE ?? DEFAULT_KNOBS.size,
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const knobs = knobsFromEnv();
  const samples = envNumber('BENCH_SAMPLES', DEFAULT_SAMPLES);
  const gatewayUrl = process.env.BENCH_GATEWAY_URL ?? `http://${cfg.publicHost}:${cfg.ports.beeGatewayApi}`;

  console.log(`bench: engine ${cfg.engine}, profile ${cfg.profile}, gateway ${gatewayUrl}`);
  console.log(
    `bench: publishing ${knobs.size} @ ${knobs.fps}fps, ${knobs.videoBitrateKbps}kbps, ${knobs.gopSeconds}s GOP`,
  );

  console.log('bench: checking the instrument locally, which spends nothing...');
  const check = await checkInstrumentLocally(knobs);
  console.log(
    `bench: instrument ok. ${check.segmentsProbed} segments, first frame stamped ` +
      `${Math.round(check.startupDelayMs)}ms after spawn, capture instants ${check.captureOffsetsMs.join('/')}ms ` +
      // The spans the new contiguity check accepted. Without them a pass leaves no trace, so an
      // operator cannot tell the check ran, let alone what it ran against.
      `apart, media spans ${check.mediaSpansMs.map((ms) => Math.round(ms)).join('/')}ms`,
  );

  await requireGatewayReachable(gatewayUrl);
  console.log('bench: viewer gateway reachable from this machine');

  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const level = effectiveLogLevel((await host.containerEnv(uploader)).LOG_LEVEL);
  const problem = logLevelProblem(level);
  if (problem) {
    throw new Error(problem);
  }
  const health = await uploaderHealth(host, cfg);
  console.log(`bench: uploader ${health.status}, ${health.activeStreams} active stream(s), LOG_LEVEL=${level}`);

  const run = await measureLatency({ cfg, host, gatewayUrl, knobs, samples, pollIntervalMs: DEFAULT_POLL_MS });
  const report = renderReport(run);

  await mkdir(REPORT_DIR, { recursive: true });
  const stem = join(REPORT_DIR, `latency-${run.measuredAt.replace(/[:.]/g, '-')}`);
  await writeFile(`${stem}.md`, `${report}\n`);
  await writeFile(`${stem}.json`, `${JSON.stringify(run, null, 2)}\n`);

  console.log(`\n${report}\n`);
  console.log(`bench: written to ${stem}.md and ${stem}.json`);
}

main().catch((error: unknown) => {
  console.error(`\nbench failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
