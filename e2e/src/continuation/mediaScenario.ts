import { createHash } from 'node:crypto';

import { FixtureRefusal } from './fixture.js';

const FIXTURE_ID_RE = /^srs-continuation-20260920-[a-z0-9]{8,16}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE_RE = /^(?:[0-9a-f]{64}|[0-9a-f]{128})$/i;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const AUTH_REFERENCE_RE = /^\S{1,256}$/;
const POLL_INTERVAL_MS = 1_000;
const STATE_DEADLINE_MS = 180_000;
const PUBLISH_DURATION_SECONDS = 6;
const MAX_HTTP_BYTES = 256 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;
const MAX_SEAM_GAP_SECONDS = 4;

export type SourceMarkerId = 'A' | 'B' | 'C';
export type SourceProtocol = 'rtmp' | 'srt';

export interface ContinuationMediaScenarioInput {
  fixtureId: string;
  srs: {
    host: string;
    rtmpPort: number;
    srtPort: number;
  };
  viewer: {
    controlBaseUrl: string;
    mediaBaseUrl: string;
  };
  adminBaseUrl: string;
  stream: {
    id: string;
    topic: string;
    mediaType: 'video';
  };
  uploaderId: string;
  authReferences: {
    owner: string;
    publishKey: string;
    srtPassphrase: string;
  };
}

export interface MediaScenarioFetchRequest {
  url: string;
  method: 'GET' | 'POST';
  authReference: string;
  body?: unknown;
  maxResponseBytes: number;
}

export interface MediaScenarioFetchResponse {
  status: number;
  body: unknown;
}

export interface MediaScenarioFetch {
  fetch(request: MediaScenarioFetchRequest): Promise<MediaScenarioFetchResponse>;
}

export type MediaScenarioProcessArgument =
  | string
  | {
      kind: 'secret-template';
      segments: readonly ({ kind: 'literal'; value: string } | { kind: 'secret-reference'; reference: string })[];
    };

export interface MediaScenarioProcessInvocation {
  purpose: 'publish' | 'decode-video' | 'decode-audio';
  file: '/usr/bin/ffmpeg';
  args: readonly MediaScenarioProcessArgument[];
  timeoutMs: number;
  maxOutputBytes: number;
  markerId?: SourceMarkerId;
  protocol?: SourceProtocol;
}

export interface MediaScenarioProcessResult {
  code: number | null;
  signal?: string | null;
  stdout: Uint8Array;
  stderr: string;
}

export interface MediaScenarioProcess {
  wait(): Promise<MediaScenarioProcessResult>;
  /** Reaps a publisher if lifecycle polling refuses before its bounded encode finishes. */
  stop(): Promise<void>;
}

export interface MediaScenarioSpawn {
  /** Executes inside the exact journal-owned media-sender container. */
  spawn(invocation: MediaScenarioProcessInvocation): Promise<MediaScenarioProcess>;
}

export interface MediaScenarioClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface MediaScenarioDependencies {
  fetch: MediaScenarioFetch;
  spawn: MediaScenarioSpawn;
  clock: MediaScenarioClock;
}

export interface ImmutableMediaEvidence {
  topic: string;
  index: number;
  reference: string;
  duration: number;
}

export interface ImmutableRenditionEvidence extends ImmutableMediaEvidence {
  name: string;
  width: number;
  height: number;
  bandwidth: number;
  avgBandwidth: number;
}

export interface DecodedMarkerRange {
  markerId: SourceMarkerId;
  firstTimestampSeconds: number;
  lastTimestampSeconds: number;
  frameCount: number;
}

export interface DecodedReplayEvidence {
  evidenceKind: 'sampled-order';
  videoSampleRateFps: 1;
  audioWindowSeconds: 1;
  track: {
    kind: 'master' | 'rendition';
    name?: string;
    topic: string;
    index: number;
    reference: string;
  };
  videoMarkerRanges: DecodedMarkerRange[];
  audioMarkerRanges: DecodedMarkerRange[];
}

export interface CompletedSnapshotEvidence {
  runNumber: number;
  lifecycleRevision: number;
  master: ImmutableMediaEvidence;
  expectedRenditions: string[];
  renditions: ImmutableRenditionEvidence[];
  decoded: DecodedReplayEvidence;
}

export interface MediaScenarioEvidence {
  fixtureId: string;
  streamId: string;
  streamTopic: string;
  uploaderId: string;
  sources: Array<{
    markerId: SourceMarkerId;
    protocol: SourceProtocol;
    runNumber: number;
  }>;
  snapshots: CompletedSnapshotEvidence[];
  preservedSnapshot: {
    runNumber: number;
    reference: string;
    index: number;
    decoded: DecodedReplayEvidence;
  };
}

interface StreamLifecycle {
  revision: number;
  runNumber: number;
  state: 'ready' | 'claimed' | 'live' | 'waiting' | 'closed' | 'vod';
  permission: 'open' | 'claimed' | 'closed';
}

interface CompletedRecording {
  runNumber: number;
  master: ImmutableMediaEvidence;
  expectedRenditions: string[];
  renditions: ImmutableRenditionEvidence[];
}

interface StreamView {
  id: string;
  topic: string;
  lifecycle: StreamLifecycle;
  completedRecording?: CompletedRecording;
}

interface ContinuationOperation {
  operationId: string;
  streamId: string;
  topic: string;
  previousRunNumber: number;
  nextRunNumber: number;
  revision: number;
  status: 'pending' | 'ready' | 'failed' | 'cancelled' | 'claimed';
}

interface SourcePlan {
  markerId: SourceMarkerId;
  protocol: SourceProtocol;
  color: string;
  frequency: number;
}

const SOURCES: readonly SourcePlan[] = [
  { markerId: 'A', protocol: 'rtmp', color: 'red', frequency: 440 },
  { markerId: 'B', protocol: 'srt', color: 'lime', frequency: 880 },
  { markerId: 'C', protocol: 'rtmp', color: 'blue', frequency: 1320 },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown, minimum = 0): number | null {
  return Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : null;
}

function finite(value: unknown, minimum = 0): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function parseBaseUrl(value: string, expectedLoopback: boolean, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new FixtureRefusal(`${label} is malformed`);
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    isLoopback(parsed.hostname) !== expectedLoopback
  ) {
    throw new FixtureRefusal(`${label} does not match its fixture reachability boundary`);
  }
  return parsed;
}

function validateInput(input: ContinuationMediaScenarioInput): void {
  if (!FIXTURE_ID_RE.test(input.fixtureId)) {
    throw new FixtureRefusal('media scenario fixture identity is malformed');
  }
  if (
    !DNS_LABEL_RE.test(input.srs.host) ||
    isLoopback(input.srs.host) ||
    !validPort(input.srs.rtmpPort) ||
    !validPort(input.srs.srtPort)
  ) {
    throw new FixtureRefusal('media scenario requires an internal SRS endpoint');
  }
  parseBaseUrl(input.viewer.controlBaseUrl, true, 'viewer control endpoint');
  parseBaseUrl(input.viewer.mediaBaseUrl, false, 'viewer media endpoint');
  parseBaseUrl(input.adminBaseUrl, true, 'admin control endpoint');
  if (!UUID_RE.test(input.stream.id) || !UUID_RE.test(input.stream.topic) || input.stream.mediaType !== 'video') {
    throw new FixtureRefusal('media scenario stream identity is malformed');
  }
  if (input.uploaderId.length < 1 || input.uploaderId.length > 128 || /\s/.test(input.uploaderId)) {
    throw new FixtureRefusal('media scenario uploader identity is malformed');
  }
  if (Object.values(input.authReferences).some((reference) => !AUTH_REFERENCE_RE.test(reference))) {
    throw new FixtureRefusal('media scenario auth reference is malformed');
  }
}

function literal(value: string): { kind: 'literal'; value: string } {
  return { kind: 'literal', value };
}

function secret(reference: string): { kind: 'secret-reference'; reference: string } {
  return { kind: 'secret-reference', reference };
}

function publishTarget(input: ContinuationMediaScenarioInput, protocol: SourceProtocol): MediaScenarioProcessArgument {
  const streamPath = `${input.stream.mediaType}/${input.stream.topic}`;
  if (protocol === 'rtmp') {
    return {
      kind: 'secret-template',
      segments: [
        literal(`rtmp://${input.srs.host}:${input.srs.rtmpPort}/${streamPath}?key=`),
        secret(input.authReferences.publishKey),
      ],
    };
  }
  return {
    kind: 'secret-template',
    segments: [
      literal(`srt://${input.srs.host}:${input.srs.srtPort}?streamid=#!::r=${streamPath}?key=`),
      secret(input.authReferences.publishKey),
      literal(',m=publish&passphrase='),
      secret(input.authReferences.srtPassphrase),
    ],
  };
}

function publisherInvocation(
  input: ContinuationMediaScenarioInput,
  source: SourcePlan,
): MediaScenarioProcessInvocation {
  const fps = 24;
  return {
    purpose: 'publish',
    file: '/usr/bin/ffmpeg',
    markerId: source.markerId,
    protocol: source.protocol,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    args: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-re',
      '-f',
      'lavfi',
      '-i',
      `color=c=${source.color}:size=1280x720:rate=${fps}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${source.frequency}:sample_rate=48000`,
      '-t',
      String(PUBLISH_DURATION_SECONDS),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-g',
      String(fps * 2),
      '-sc_threshold',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-b:a',
      '128k',
      '-f',
      source.protocol === 'rtmp' ? 'flv' : 'mpegts',
      publishTarget(input, source.protocol),
    ],
  };
}

function selectedTrack(recording: CompletedRecording): DecodedReplayEvidence['track'] {
  const rendition = [...recording.renditions].sort(
    (left, right) =>
      right.height - left.height || right.bandwidth - left.bandwidth || left.name.localeCompare(right.name),
  )[0];
  if (rendition) {
    return {
      kind: 'rendition',
      name: rendition.name,
      topic: rendition.topic,
      index: rendition.index,
      reference: rendition.reference,
    };
  }
  return {
    kind: 'master',
    topic: recording.master.topic,
    index: recording.master.index,
    reference: recording.master.reference,
  };
}

function videoDecodeInvocation(
  input: ContinuationMediaScenarioInput,
  recording: CompletedRecording,
): MediaScenarioProcessInvocation {
  const track = selectedTrack(recording);
  const source = `${input.viewer.mediaBaseUrl}/bee/bytes/${track.reference}`;
  return {
    purpose: 'decode-video',
    file: '/usr/bin/ffmpeg',
    timeoutMs: 120_000,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    args: [
      '-hide_banner',
      '-loglevel',
      'info',
      '-allowed_extensions',
      'ALL',
      '-extension_picky',
      '0',
      '-i',
      source,
      '-map',
      '0:v:0',
      '-vf',
      'fps=1,scale=1:1:flags=area,format=rgb24,showinfo',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
  };
}

function audioDecodeInvocation(
  input: ContinuationMediaScenarioInput,
  recording: CompletedRecording,
): MediaScenarioProcessInvocation {
  const track = selectedTrack(recording);
  const source = `${input.viewer.mediaBaseUrl}/bee/bytes/${track.reference}`;
  return {
    purpose: 'decode-audio',
    file: '/usr/bin/ffmpeg',
    timeoutMs: 120_000,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    args: [
      '-hide_banner',
      '-loglevel',
      'info',
      '-allowed_extensions',
      'ALL',
      '-extension_picky',
      '0',
      '-i',
      source,
      '-map',
      '0:a:0',
      '-af',
      'aresample=8000,asetnsamples=n=8000:p=1,aspectralstats=measure=centroid,ametadata=print:key=lavfi.aspectralstats.1.centroid',
      '-f',
      'null',
      '-',
    ],
  };
}

async function waitForProcess(
  deps: MediaScenarioDependencies,
  invocation: MediaScenarioProcessInvocation,
  label: string,
): Promise<MediaScenarioProcessResult> {
  try {
    const process = await deps.spawn.spawn(invocation);
    const result = await process.wait();
    if (result.code !== 0 || result.signal) {
      throw new Error('process failed');
    }
    if (result.stdout.byteLength + Buffer.byteLength(result.stderr) > invocation.maxOutputBytes) {
      throw new Error('process output exceeded bound');
    }
    return result;
  } catch {
    throw new FixtureRefusal(`${label} failed without exposing process arguments or diagnostics`);
  }
}

async function requestJson(
  input: ContinuationMediaScenarioInput,
  deps: MediaScenarioDependencies,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<unknown> {
  try {
    const response = await deps.fetch.fetch({
      url: `${input.adminBaseUrl}${path}`,
      method,
      authReference: input.authReferences.owner,
      ...(body === undefined ? {} : { body }),
      maxResponseBytes: MAX_HTTP_BYTES,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error('request refused');
    }
    return response.body;
  } catch {
    throw new FixtureRefusal(`media scenario ${method} ${path} failed without exposing authorization data`);
  }
}

function mediaReference(value: unknown): ImmutableMediaEvidence | null {
  if (!isObject(value)) {
    return null;
  }
  const topic = string(value.topic);
  const index = integer(value.index);
  const reference = string(value.reference);
  const duration = finite(value.duration);
  if (!topic || index === null || !reference || !REFERENCE_RE.test(reference) || duration === null) {
    return null;
  }
  return { topic, index, reference, duration };
}

function rendition(value: unknown): ImmutableRenditionEvidence | null {
  if (!isObject(value)) {
    return null;
  }
  const media = mediaReference(value);
  const name = string(value.name);
  const width = integer(value.width, 1);
  const height = integer(value.height, 1);
  const bandwidth = integer(value.bandwidth, 1);
  const avgBandwidth = integer(value.avgBandwidth, 1);
  if (!media || !name || width === null || height === null || bandwidth === null || avgBandwidth === null) {
    return null;
  }
  return { ...media, name, width, height, bandwidth, avgBandwidth };
}

function completedRecording(value: unknown): CompletedRecording | null {
  if (!isObject(value)) {
    return null;
  }
  const runNumber = integer(value.runNumber, 1);
  const master = mediaReference(value.master);
  if (runNumber === null || !master || !Array.isArray(value.expectedRenditions) || !Array.isArray(value.renditions)) {
    return null;
  }
  const expectedRenditions = value.expectedRenditions.map(string);
  const renditions = value.renditions.map(rendition);
  if (expectedRenditions.some((name) => name === null) || renditions.some((entry) => entry === null)) {
    return null;
  }
  const names = expectedRenditions as string[];
  const usableRenditions = renditions as ImmutableRenditionEvidence[];
  if (
    new Set(names).size !== names.length ||
    new Set(usableRenditions.map((entry) => entry.name)).size !== usableRenditions.length ||
    names.slice().sort().join('\0') !==
      usableRenditions
        .map((entry) => entry.name)
        .sort()
        .join('\0')
  ) {
    return null;
  }
  return {
    runNumber,
    master,
    expectedRenditions: names,
    renditions: usableRenditions.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function streamView(value: unknown, input: ContinuationMediaScenarioInput): StreamView | null {
  if (!isObject(value) || !isObject(value.lifecycle)) {
    return null;
  }
  const id = string(value.id);
  const topic = string(value.topic);
  const revision = integer(value.lifecycle.revision);
  const runNumber = integer(value.lifecycle.runNumber, 1);
  const state = value.lifecycle.state;
  const permission = value.lifecycle.permission;
  if (
    id !== input.stream.id ||
    topic !== input.stream.topic ||
    revision === null ||
    runNumber === null ||
    !['ready', 'claimed', 'live', 'waiting', 'closed', 'vod'].includes(String(state)) ||
    !['open', 'claimed', 'closed'].includes(String(permission))
  ) {
    return null;
  }
  const recording = value.completedRecording === undefined ? undefined : completedRecording(value.completedRecording);
  if (value.completedRecording !== undefined && !recording) {
    return null;
  }
  return {
    id,
    topic,
    lifecycle: {
      revision,
      runNumber,
      state: state as StreamLifecycle['state'],
      permission: permission as StreamLifecycle['permission'],
    },
    ...(recording ? { completedRecording: recording } : {}),
  };
}

function continuationOperation(value: unknown, input: ContinuationMediaScenarioInput): ContinuationOperation | null {
  if (!isObject(value) || !isObject(value.operation)) {
    return null;
  }
  const operation = value.operation;
  const operationId = string(operation.operationId);
  const streamId = string(operation.streamId);
  const topic = string(operation.topic);
  const previousRunNumber = integer(operation.previousRunNumber, 1);
  const nextRunNumber = integer(operation.nextRunNumber, 1);
  const revision = integer(operation.revision);
  const status = operation.status;
  if (
    !operationId ||
    !UUID_RE.test(operationId) ||
    streamId !== input.stream.id ||
    topic !== input.stream.topic ||
    previousRunNumber === null ||
    nextRunNumber === null ||
    revision === null ||
    !['pending', 'ready', 'failed', 'cancelled', 'claimed'].includes(String(status))
  ) {
    return null;
  }
  return {
    operationId,
    streamId,
    topic,
    previousRunNumber,
    nextRunNumber,
    revision,
    status: status as ContinuationOperation['status'],
  };
}

async function readStream(input: ContinuationMediaScenarioInput, deps: MediaScenarioDependencies): Promise<StreamView> {
  const value = await requestJson(input, deps, `/api/streams/${encodeURIComponent(input.stream.id)}`, 'GET');
  const parsed = streamView(value, input);
  if (!parsed) {
    throw new FixtureRefusal('admin returned a malformed managed stream view');
  }
  return parsed;
}

async function pollStream(
  input: ContinuationMediaScenarioInput,
  deps: MediaScenarioDependencies,
  accept: (stream: StreamView) => boolean,
  label: string,
): Promise<StreamView> {
  const deadline = deps.clock.now() + STATE_DEADLINE_MS;
  do {
    const current = await readStream(input, deps);
    if (accept(current)) {
      return current;
    }
    await deps.clock.sleep(POLL_INTERVAL_MS);
  } while (deps.clock.now() <= deadline);
  throw new FixtureRefusal(`media scenario timed out waiting for ${label}`);
}

function requestId(input: ContinuationMediaScenarioInput, nextRunNumber: number): string {
  const bytes = createHash('sha256')
    .update(`${input.fixtureId}:${input.stream.id}:${nextRunNumber}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function prepareNextRun(
  input: ContinuationMediaScenarioInput,
  deps: MediaScenarioDependencies,
  previous: StreamView,
): Promise<number> {
  const createdValue = await requestJson(
    input,
    deps,
    `/api/streams/${encodeURIComponent(input.stream.id)}/continuations`,
    'POST',
    {
      requestId: requestId(input, previous.lifecycle.runNumber + 1),
      expectedRevision: previous.lifecycle.revision,
    },
  );
  let operation = continuationOperation(createdValue, input);
  if (
    !operation ||
    operation.previousRunNumber !== previous.lifecycle.runNumber ||
    operation.nextRunNumber <= previous.lifecycle.runNumber
  ) {
    throw new FixtureRefusal('admin returned a continuation for another managed run');
  }
  const deadline = deps.clock.now() + STATE_DEADLINE_MS;
  while (operation.status === 'pending') {
    if (deps.clock.now() > deadline) {
      throw new FixtureRefusal('media scenario timed out waiting for continuation preparation');
    }
    await deps.clock.sleep(POLL_INTERVAL_MS);
    const currentValue = await requestJson(
      input,
      deps,
      `/api/streams/${encodeURIComponent(input.stream.id)}/continuations/${encodeURIComponent(operation.operationId)}`,
      'GET',
    );
    const current = continuationOperation(currentValue, input);
    if (
      !current ||
      current.operationId !== operation.operationId ||
      current.previousRunNumber !== operation.previousRunNumber ||
      current.nextRunNumber !== operation.nextRunNumber
    ) {
      throw new FixtureRefusal('admin changed continuation identity during preparation');
    }
    operation = current;
  }
  if (operation.status !== 'ready') {
    throw new FixtureRefusal(`continuation preparation ended ${operation.status}`);
  }
  return operation.nextRunNumber;
}

function timestamps(stderr: string): number[] {
  const result: number[] = [];
  for (const match of stderr.matchAll(/\bpts_time:([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)/gi)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      result.push(value);
    }
  }
  return result;
}

function classifyMarker(red: number, green: number, blue: number): SourceMarkerId | null {
  const largest = Math.max(red, green, blue);
  if (largest < 64) {
    return null;
  }
  if (red > green * 1.25 && red > blue * 1.25) {
    return 'A';
  }
  if (green > red * 1.25 && green > blue * 1.25) {
    return 'B';
  }
  if (blue > red * 1.25 && blue > green * 1.25) {
    return 'C';
  }
  return null;
}

function markerRanges(frames: readonly { markerId: SourceMarkerId; timestamp: number }[]): DecodedMarkerRange[] {
  const ranges: DecodedMarkerRange[] = [];
  for (const [index, frame] of frames.entries()) {
    if (index > 0 && frame.timestamp < frames[index - 1].timestamp) {
      throw new FixtureRefusal('FFmpeg decoded a replay with a backwards timeline');
    }
    const current = ranges.at(-1);
    if (current?.markerId === frame.markerId) {
      current.lastTimestampSeconds = frame.timestamp;
      current.frameCount += 1;
    } else {
      if (current && frame.timestamp - current.lastTimestampSeconds > MAX_SEAM_GAP_SECONDS) {
        throw new FixtureRefusal('FFmpeg decoded a cumulative replay with a broken seam');
      }
      ranges.push({
        markerId: frame.markerId,
        firstTimestampSeconds: frame.timestamp,
        lastTimestampSeconds: frame.timestamp,
        frameCount: 1,
      });
    }
  }
  return ranges;
}

function videoMarkerRanges(result: MediaScenarioProcessResult): DecodedMarkerRange[] {
  const frameTimestamps = timestamps(result.stderr);
  if (
    result.stdout.byteLength === 0 ||
    result.stdout.byteLength % 3 !== 0 ||
    frameTimestamps.length * 3 !== result.stdout.byteLength
  ) {
    throw new FixtureRefusal('FFmpeg video decode did not return one timestamp per RGB frame');
  }
  return markerRanges(
    frameTimestamps.map((timestamp, index) => {
      const offset = index * 3;
      const markerId = classifyMarker(result.stdout[offset], result.stdout[offset + 1], result.stdout[offset + 2]);
      if (!markerId) {
        throw new FixtureRefusal('FFmpeg decoded an unknown video source marker');
      }
      return { markerId, timestamp };
    }),
  );
}

function classifyFrequency(frequency: number): SourceMarkerId | null {
  const closest = SOURCES.map((source) => ({
    markerId: source.markerId,
    distance: Math.abs(source.frequency - frequency),
  })).sort((left, right) => left.distance - right.distance)[0];
  return closest && closest.distance <= 180 ? closest.markerId : null;
}

function audioMarkerRanges(result: MediaScenarioProcessResult): DecodedMarkerRange[] {
  const frames: Array<{ markerId: SourceMarkerId; timestamp: number }> = [];
  for (const measurement of result.stderr.matchAll(
    /\bpts_time:([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)[\s\S]*?lavfi\.aspectralstats\.1\.centroid=([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)/gi,
  )) {
    const timestamp = Number(measurement[1]);
    const frequency = Number(measurement[2]);
    const markerId = classifyFrequency(frequency);
    if (!Number.isFinite(timestamp) || !markerId) {
      throw new FixtureRefusal('FFmpeg decoded an unknown audio source marker');
    }
    frames.push({ markerId, timestamp });
  }
  if (result.stdout.byteLength !== 0 || frames.length === 0) {
    throw new FixtureRefusal('FFmpeg audio decode did not return bounded frequency windows');
  }
  return markerRanges(frames);
}

function decodeEvidence(
  recording: CompletedRecording,
  videoResult: MediaScenarioProcessResult,
  audioResult: MediaScenarioProcessResult,
): DecodedReplayEvidence {
  return {
    evidenceKind: 'sampled-order',
    videoSampleRateFps: 1,
    audioWindowSeconds: 1,
    track: selectedTrack(recording),
    videoMarkerRanges: videoMarkerRanges(videoResult),
    audioMarkerRanges: audioMarkerRanges(audioResult),
  };
}

function assertMarkers(decoded: DecodedReplayEvidence, expected: readonly SourceMarkerId[]): void {
  for (const ranges of [decoded.videoMarkerRanges, decoded.audioMarkerRanges]) {
    const actual = ranges.map((range) => range.markerId);
    if (actual.length !== expected.length || actual.some((marker, index) => marker !== expected[index])) {
      throw new FixtureRefusal('FFmpeg cumulative replay did not preserve the A/B/C source order');
    }
  }
}

async function decodeRecording(
  input: ContinuationMediaScenarioInput,
  deps: MediaScenarioDependencies,
  recording: CompletedRecording,
  expected: readonly SourceMarkerId[],
): Promise<DecodedReplayEvidence> {
  const videoResult = await waitForProcess(deps, videoDecodeInvocation(input, recording), 'FFmpeg video replay decode');
  const audioResult = await waitForProcess(deps, audioDecodeInvocation(input, recording), 'FFmpeg audio replay decode');
  const decoded = decodeEvidence(recording, videoResult, audioResult);
  assertMarkers(decoded, expected);
  return decoded;
}

function snapshotEvidence(stream: StreamView, decoded: DecodedReplayEvidence): CompletedSnapshotEvidence {
  const recording = stream.completedRecording;
  if (!recording) {
    throw new FixtureRefusal('managed VOD did not include a completed recording');
  }
  return {
    runNumber: recording.runNumber,
    lifecycleRevision: stream.lifecycle.revision,
    master: { ...recording.master },
    expectedRenditions: [...recording.expectedRenditions],
    renditions: recording.renditions.map((entry) => ({ ...entry })),
    decoded,
  };
}

/**
 * Publishes three bounded, color-labelled sources, requests two continuations, and decodes each
 * immutable cumulative replay plus run A again after run C. Infrastructure and credentials stay in
 * injected fixture adapters.
 */
export async function runContinuationMediaScenario(
  input: ContinuationMediaScenarioInput,
  deps: MediaScenarioDependencies,
): Promise<MediaScenarioEvidence> {
  validateInput(input);
  let current = await readStream(input, deps);
  if (current.lifecycle.state !== 'ready' || current.lifecycle.permission !== 'open') {
    throw new FixtureRefusal('managed media scenario must start from open ready permission');
  }

  const snapshots: CompletedSnapshotEvidence[] = [];
  const sources: MediaScenarioEvidence['sources'] = [];
  for (let index = 0; index < SOURCES.length; index += 1) {
    const source = SOURCES[index];
    const runNumber = current.lifecycle.runNumber;
    const publisher = await deps.spawn.spawn(publisherInvocation(input, source)).catch(() => {
      throw new FixtureRefusal(
        `FFmpeg publisher ${source.markerId} failed without exposing process arguments or diagnostics`,
      );
    });
    let vod: StreamView;
    let decoded: DecodedReplayEvidence;
    try {
      const live = await pollStream(
        input,
        deps,
        (stream) => stream.lifecycle.runNumber === runNumber && stream.lifecycle.state === 'live',
        `run ${runNumber} live`,
      );
      if (live.lifecycle.revision < current.lifecycle.revision) {
        throw new FixtureRefusal('managed lifecycle revision moved backwards');
      }
      let publishResult: MediaScenarioProcessResult;
      try {
        publishResult = await publisher.wait();
      } catch {
        throw new FixtureRefusal(
          `FFmpeg publisher ${source.markerId} failed without exposing process arguments or diagnostics`,
        );
      }
      if (
        publishResult.code !== 0 ||
        publishResult.signal ||
        publishResult.stdout.byteLength + Buffer.byteLength(publishResult.stderr) > 64 * 1024
      ) {
        throw new FixtureRefusal(
          `FFmpeg publisher ${source.markerId} failed without exposing process arguments or diagnostics`,
        );
      }
      vod = await pollStream(
        input,
        deps,
        (stream) =>
          stream.lifecycle.runNumber === runNumber &&
          stream.lifecycle.state === 'vod' &&
          stream.completedRecording?.runNumber === runNumber,
        `run ${runNumber} immutable VOD`,
      );
      const expected = SOURCES.slice(0, index + 1).map((entry) => entry.markerId);
      decoded = await decodeRecording(input, deps, vod.completedRecording!, expected);
    } catch (error) {
      try {
        await publisher.stop();
      } catch {
        // The original fixed diagnostic is the useful answer. The executor still owns hard cleanup.
      }
      if (error instanceof FixtureRefusal) {
        throw error;
      }
      throw new FixtureRefusal(
        `FFmpeg publisher ${source.markerId} failed without exposing process arguments or diagnostics`,
      );
    }
    snapshots.push(snapshotEvidence(vod, decoded));
    sources.push({ markerId: source.markerId, protocol: source.protocol, runNumber });
    current = vod;
    if (index < SOURCES.length - 1) {
      const nextRunNumber = await prepareNextRun(input, deps, current);
      current = {
        ...current,
        lifecycle: {
          revision: current.lifecycle.revision,
          runNumber: nextRunNumber,
          state: 'ready',
          permission: 'open',
        },
      };
    }
  }

  const first = snapshots[0];
  if (!first) {
    throw new FixtureRefusal('media scenario produced no immutable recording');
  }
  const firstRecording: CompletedRecording = {
    runNumber: first.runNumber,
    master: first.master,
    expectedRenditions: first.expectedRenditions,
    renditions: first.renditions,
  };
  const preservedDecoded = await decodeRecording(input, deps, firstRecording, ['A']);
  if (
    JSON.stringify(preservedDecoded.videoMarkerRanges) !== JSON.stringify(first.decoded.videoMarkerRanges) ||
    JSON.stringify(preservedDecoded.audioMarkerRanges) !== JSON.stringify(first.decoded.audioMarkerRanges) ||
    preservedDecoded.track.reference !== first.decoded.track.reference ||
    preservedDecoded.track.index !== first.decoded.track.index
  ) {
    throw new FixtureRefusal('run A immutable snapshot changed after run C');
  }

  return {
    fixtureId: input.fixtureId,
    streamId: input.stream.id,
    streamTopic: input.stream.topic,
    uploaderId: input.uploaderId,
    sources,
    snapshots,
    preservedSnapshot: {
      runNumber: first.runNumber,
      reference: first.decoded.track.reference,
      index: first.decoded.track.index,
      decoded: preservedDecoded,
    },
  };
}
