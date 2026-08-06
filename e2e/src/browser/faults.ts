/**
 * The things that can go wrong under a viewer, and what a viewer is entitled to see when they do.
 *
 * ## Why this exists beside `suites/scenarios/`
 *
 * Six crash scenarios already run against this deployment and all six pass. Every one of them asks
 * the same kind of question: did the **uploader** do the right thing. Did it resume without a
 * spurious VOD, did it arm a discontinuity, did segment numbering stay contiguous. Those are the
 * right questions and they are answered from the uploader's log.
 *
 * None of them has a viewer. So the project can say that an eight second bee outage loses no
 * segments, and cannot say whether anybody watching noticed, how long their picture stopped, whether
 * it came back without a reload, or whether the client told them anything while it was stopped. That
 * last one is the whole reason `FeedStateOverlay` exists and nothing has ever seen it render.
 *
 * ## What a scenario is allowed to do
 *
 * Stop, kill or restart **one container of the profile under test**, and put it back. Nothing here
 * removes data, and every scenario restores what it touched even when the run fails, because the
 * deployment is shared with everything else this project measures.
 */

import { type Ports, type ServiceName, SERVICES } from '../config.js';

/**
 * How the fault is applied.
 *
 * `stop` is a clean shutdown, `kill` is SIGKILL, which is what a crash is, and `pause` freezes the
 * process without ending it. `pause` exists because a **short** outage cannot be built out of the
 * others: stopping a bee node and starting it again costs twenty to thirty seconds of its own
 * startup, so there is no way to ask what a five second outage looks like. Pause and unpause are
 * both instant, which makes the window the one the scenario asked for.
 */
export const FAULT_ACTIONS = ['stop', 'kill', 'restart', 'pause'] as const;
export type FaultAction = (typeof FAULT_ACTIONS)[number];

/**
 * What each action reads as in a sentence.
 *
 * A table rather than the `${action}ped` the report first used, which produced "killped" and
 * "restartped" in a document whose whole job is to be quoted.
 */
export const FAULT_PAST_TENSE: Record<FaultAction, string> = {
  stop: 'stopped',
  kill: 'killed',
  restart: 'restarted',
  pause: 'paused',
};

export interface FaultScenario {
  /** Selects the scenario on the command line, and names its report. */
  readonly name: string;
  /** The container the fault is applied to. */
  readonly service: ServiceName;
  readonly action: FaultAction;
  /**
   * How long the service stays down before it is brought back.
   *
   * For `restart` this is how long to watch before judging recovery, since docker brings the
   * container back itself and there is nothing to lift.
   */
  readonly downMs: number;
  /** What is being broken, in the words a report should use. */
  readonly breaks: string;
  /**
   * What a viewer should see. Written before the run rather than after it, so a scenario that
   * measures something other than what it claims to is visible as a disagreement rather than as a
   * paragraph written to fit whatever came out.
   */
  readonly expectation: string;
  /**
   * Whether the picture is expected to stop at all.
   *
   * Some faults should be invisible to a viewer, and for those the interesting result is a freeze
   * rather than the absence of one. A scenario with no expectation either way cannot fail.
   */
  readonly expectFreeze: boolean;
  /**
   * Whether playback is expected to start again at all.
   *
   * False for a fault that genuinely ends the broadcast, where a picture that never moves again is
   * the correct outcome and there is nothing left to resume. Without this the report called a
   * correct engine-restart run a failure, in the same words it uses for a viewer stranded on a
   * stream that is still being published. Those are opposite outcomes and had one verdict.
   *
   * What still has to be true when this is false is that the viewer was **told**: a broadcast that
   * ended and says so is a viewer who stops waiting, and one that ended in silence is not.
   */
  readonly expectRecovery: boolean;
  /**
   * How to tell the service is answering again, rather than merely existing again.
   *
   * ⚠️ **`docker start` returns long before the process inside works, and reading the two as one
   * moment made every recovery figure this project holds too large.** On 2026-08-06 the bee gateway
   * returned from `docker start` at t+79.1s, answered a 503 at t+80.3s, and did not serve a 200 until
   * **t+86.3s**. Charging those 7.2 seconds to the viewer set fix 0.8b a target of "under 3s" that no
   * client change could ever have reached.
   *
   * Absent for a fault with nothing to lift, which is `restart`.
   */
  readonly ready?: {
    readonly port: keyof Ports;
    readonly path: string;
    /**
     * Fields the answer must carry before the service counts as back.
     *
     * Without this the check passes on any parseable body, and a service that is starting answers
     * with one: bee's `/health` says `ok` about a second after `docker start` while the node still
     * cannot retrieve a chunk. What the endpoint means is the scenario's knowledge, not the runner's.
     */
    readonly is: Readonly<Record<string, string>>;
  };
}

/**
 * The gateway a viewer reads through, taken away and given back.
 *
 * The one fault whose blast radius is exactly the viewer: the uploader writes through its own bee
 * node and is provably unaffected, which `suites/scenarios/gateway-outage-viewer.test.ts` already
 * establishes from the upload side. So whatever happens to the picture here is the client's
 * behaviour and nothing else's, which makes it the cleanest scenario to measure first.
 */
const VIEWER_GATEWAY_OUTAGE: FaultScenario = {
  name: 'viewer-gateway-outage',
  service: SERVICES.beeGateway,
  action: 'stop',
  downMs: 20_000,
  breaks: 'the bee node a viewer reads segments and feed slots through',
  expectation:
    'The picture plays out whatever is buffered and then stops. The client should say so rather than ' +
    'leave a frozen frame unexplained, and should resume on its own once the gateway answers again, ' +
    'without a reload and without ending the broadcast.',
  expectFreeze: true,
  expectRecovery: true,
  ready: { port: 'beeGatewayApi', path: '/readiness', is: { status: 'ready' } },
};

/**
 * The uploader killed outright, which is the crash the recovery entry exists for.
 *
 * Segments stop being written while it is down, so the feed stops advancing. A viewer has a buffer
 * and should spend it before noticing, which is the interesting part: `LIVE_SYNC_DURATION_S` seconds
 * of runway against however long the process takes to come back.
 */
const UPLOADER_CRASH: FaultScenario = {
  name: 'uploader-crash',
  service: SERVICES.streamUploader,
  action: 'kill',
  downMs: 15_000,
  breaks: 'the process that writes segments and manifests into Swarm',
  expectation:
    'Nothing new reaches the feed while it is down, so the viewer spends their buffer and then waits. ' +
    'Once it is back the feed advances again and playback resumes, either at the live edge or by ' +
    'catching up to it.',
  expectFreeze: true,
  expectRecovery: true,
  ready: { port: 'uploaderApi', path: '/health', is: { status: 'ok' } },
};

/**
 * The ingest engine restarted under a live publisher.
 *
 * The publisher's connection dies with it, so this is the one scenario where the broadcast genuinely
 * ends and a new one begins. A viewer watching the old stream id has no more media coming, and what
 * they should be told is exactly the question: `stalled` is honest, a frozen frame saying `live` is
 * not.
 */
const ENGINE_RESTART: FaultScenario = {
  name: 'engine-restart',
  service: SERVICES.srs,
  action: 'restart',
  downMs: 30_000,
  breaks: 'the ingest engine, which takes the publisher connection with it',
  expectation:
    'The broadcast this viewer is watching ends. They should be told the feed has stopped advancing ' +
    'rather than left on a frozen picture that still claims to be live. Playback is NOT expected to ' +
    'resume: the publisher went with the engine and this broadcast is over.',
  expectFreeze: true,
  expectRecovery: false,
};

/**
 * The writer's bee node frozen for less time than the uploader's retry window.
 *
 * **The one scenario whose expected result is that nothing happens.** The uploader retries a failed
 * segment for fifteen seconds before giving up, so an outage shorter than that should back-pressure,
 * buffer in order and flush on recovery, losing nothing.
 * `suites/scenarios/bee-outage-short.test.ts` already establishes that from the upload side: indices
 * stay gapless and no discontinuity is armed. What has never been asked is whether it reaches a
 * viewer at all, and the answer should be no, because the feed keeps advancing once the flush lands
 * and the viewer has six seconds of buffer in front of it.
 *
 * A fault with `expectFreeze: false` is worth more than one without: a scenario that predicts nothing
 * cannot fail, and this one fails if a viewer notices.
 */
const WRITER_BEE_PAUSE: FaultScenario = {
  name: 'writer-bee-pause',
  service: SERVICES.beeUploader,
  action: 'pause',
  downMs: 8_000,
  breaks: 'the bee node the uploader writes segments and manifests through, briefly',
  expectation:
    'Nothing. The outage is shorter than the uploader retry window, so segments buffer and flush ' +
    'rather than being lost, and a viewer with six seconds of buffer should never see the picture ' +
    'stop or be told anything is wrong.',
  expectFreeze: false,
  expectRecovery: true,
  ready: { port: 'beeUploaderApi', path: '/readiness', is: { status: 'ready' } },
};

/**
 * The writer's bee node taken away for longer than the uploader can retry.
 *
 * ⭐ **The first time a viewer plays through a discontinuity.** Past the fifteen second window the
 * uploader gives up on the segment in flight and arms `#EXT-X-DISCONTINUITY` so the next good segment
 * declares that the timeline broke. `suites/scenarios/bee-outage-long.test.ts` proves the uploader
 * does this correctly and stops there. Whether hls.js then recovers the timeline, or stalls on a
 * discontinuity it was told about, is a different question and nothing has ever watched it.
 *
 * `stop` rather than `kill`: a SIGKILL risks the node's database, and this is the node that holds the
 * postage batch every measurement is paid for with. A clean shutdown fails uploads just as hard.
 */
const WRITER_BEE_OUTAGE: FaultScenario = {
  name: 'writer-bee-outage',
  service: SERVICES.beeUploader,
  action: 'stop',
  downMs: 20_000,
  breaks: 'the bee node the uploader writes through, for longer than it can retry',
  expectation:
    'The segment in flight is dropped and a discontinuity is armed, so the viewer meets a break in ' +
    'the timeline rather than a gap in the numbering. The picture should stop while nothing is ' +
    'being written and then resume across the discontinuity without a reload and without ending the ' +
    'broadcast.',
  expectFreeze: true,
  expectRecovery: true,
  ready: { port: 'beeUploaderApi', path: '/readiness', is: { status: 'ready' } },
};

export const FAULT_SCENARIOS: readonly FaultScenario[] = [
  VIEWER_GATEWAY_OUTAGE,
  UPLOADER_CRASH,
  ENGINE_RESTART,
  WRITER_BEE_PAUSE,
  WRITER_BEE_OUTAGE,
];

export function scenarioByName(name: string): FaultScenario {
  const scenario = FAULT_SCENARIOS.find((candidate) => candidate.name === name);
  if (!scenario) {
    const known = FAULT_SCENARIOS.map((candidate) => candidate.name).join(', ');
    throw new Error(`unknown crash scenario '${name}'. Known scenarios: ${known}`);
  }
  return scenario;
}
