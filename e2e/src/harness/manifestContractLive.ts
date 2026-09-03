/**
 * The playlists a broadcast actually published, fetched from its own feeds and held against the
 * manifest contract.
 *
 * `manifestContract.ts` is the rulebook and it reads text. This is what finds the text on a live
 * deployment, so a suite can assert the contract on the playlists a paid broadcast wrote instead of
 * an operator reading one by hand after the run.
 *
 * ## ⭐ Why this needs nothing new from the uploader
 *
 * `docs/e2e-coverage.md` recorded, correctly for the log lines it looked at, that a ladder announce
 * carries the topic and the group and no owner, and concluded that either the uploader had to log
 * one or the harness had to hold `STREAM_KEY`. Neither is so. **There is one feed owner for the
 * whole uploader**: `StreamCatalog`, `MasterFeedWriter` and every `StreamUploader` build their signer
 * from the same `STREAM_KEY` (`packages/stream-uploader/src/index.ts`), so the address
 * {@link discoverCatalogFeed} already reads out of the `[StreamCatalog]` line is also the owner of
 * every rung's playlist feed. The topic comes from the rung announce, and the read is the one
 * `e2e/browser/vod.ts` already makes:
 *
 *   `GET /feeds/{owner}/{feedTopicHexOf(rawTopic)}` on the bee gateway, which answers the m3u8 itself.
 *
 * ## What one read covers
 *
 * The live playlist and the recording are the same feed at different indices, because `finalize`
 * publishes the closing live playlist and then the VOD manifest to the stream's own manifest feed.
 * A feed read answers with the head, so a suite reading mid-broadcast gets the live playlist and one
 * reading after the finalize gets the recording, and {@link RungPlaylistReading.recording} says which
 * arrived rather than leaving a reader to guess.
 *
 * ⛔ Correctness only. Nothing here times anything, and nothing here refuses on a duration. See the
 * repository's rule on what an e2e suite may gate on.
 */

import { HLS_PLAYLIST_TYPE_VOD, parseManifest } from '@swarm-hls-stream/shared';

import { feedTopicHexOf } from '../browser/rungManifest.js';
import type { E2EConfig } from '../config.js';
import { SEGMENT_ANY, type SegmentExpectation } from '../segmentLength.js';

import type { Host } from './host.js';
import { announcedLiveTopics, announcedRungs } from './logwatch.js';
import {
  type ManifestContract,
  manifestContractFailures,
  mediaSequenceOf,
  programDateTimesOf,
} from './manifestContract.js';
import { sleep } from './wait.js';

/** Where one rung's playlist is published, and the names a report should call it by. */
export interface RungFeed {
  /** The rung name on a ladder, or null on a deployment publishing one rendition. */
  rung: string | null;
  /**
   * The stream the uploader keyed its segment and manifest lines on, or null where no line names
   * one.
   *
   * Carried so a suite can read the playlists of exactly the streams it already judged. A rung that
   * announced and never uploaded has an empty feed, and a suite scoped to "every rung that uploaded
   * a segment" must not acquire a new red for a rung it deliberately left out.
   */
  streamId: string | null;
  /** The raw topic the uploader chose, a UUID on this stage, which the gateway wants hashed. */
  topic: string;
}

/** Where every playlist one broadcast published can be read: one owner, one topic per rung. */
export interface BroadcastPlaylists {
  /**
   * The signer's address, as {@link discoverCatalogFeed} reads it off the `[StreamCatalog]` line.
   * One for the catalog, every master and every rung. See the header.
   */
  owner: string;
  rungs: readonly RungFeed[];
}

/** What one rung's published playlist says about its own timeline. */
export interface RungPlaylistReading {
  rung: string | null;
  streamId: string | null;
  topic: string;
  /** The topic as the gateway's `/feeds/{owner}/{topic}` route wants it. */
  topicHex: string;
  /** The m3u8 as the gateway served it, or null where the feed answered something that is not one. */
  playlist: string | null;
  segments: number;
  mediaSequence: number | null;
  /** The first and last `#EXT-X-PROGRAM-DATE-TIME`, as ISO text, or null where a segment carried none. */
  firstDate: string | null;
  lastDate: string | null;
  /**
   * Whether this playlist declares itself a finished recording.
   *
   * ⛔ `#EXT-X-PLAYLIST-TYPE:VOD`, never the `#EXT-X-ENDLIST` beside it. `buildClosingLiveManifest`
   * carries an ENDLIST too and is published at the feed index BEFORE the recording, so an ENDLIST
   * read as a recording would demand sequence 0 of a live window that has legitimately slid.
   */
  recording: boolean;
  /** Everything wrong with this rung's timeline, or empty. Also holds the reason nothing was read. */
  failures: readonly string[];
}

/** How long one feed read is given before the reading records what the gateway did answer. */
const PLAYLIST_READ_TIMEOUT_S = 15;
/**
 * How long a rung is given to answer with a playlist at all, across retries.
 *
 * Spent only by a rung whose feed answered nothing usable. A gateway restarting answers its own
 * error envelope for a few seconds, and a suite failing on that would name the transport rather than
 * the product.
 */
const PLAYLIST_RETRY_WINDOW_MS = 30_000;
const PLAYLIST_RETRY_INTERVAL_MS = 2_000;

/** Enough of a body to recognise it in a failure, without pasting a whole playlist into one. */
const BODY_EXCERPT_CHARS = 120;

/** The first line of any playlist. A body without it is not one, whatever else it parses as. */
const PLAYLIST_MARKER = '#EXTM3U';

/**
 * The step a playlist's dates must take, out of what the run declared, or null where it declared
 * none.
 *
 * ⛔ The run's declaration and not a measurement. `#EXT-X-PROGRAM-DATE-TIME` is derived from
 * `HLS_FRAGMENT` and a segment count rather than from any segment's own `#EXTINF`, precisely so the
 * rungs of one ladder agree about the same media, and checking a nominal step against an observation
 * would pass exactly the drift the derivation exists to prevent.
 *
 * `E2E_EXPECT_SEGMENT_S=any` is a declaration rather than a gap, the way
 * `suites/preflight/segment-length.test.ts` treats it, so it reads as null here and
 * {@link UNCHECKED_WITHOUT_FRAGMENT} is what a suite prints instead of a verdict.
 */
export function fragmentSecondsFor(expectation: SegmentExpectation): number | null {
  return expectation === SEGMENT_ANY || expectation === 'undeclared' ? null : expectation;
}

/** What a suite prints in place of a verdict when the run pinned no segment length. */
export const UNCHECKED_WITHOUT_FRAGMENT =
  "this run declared no segment length, so the step a playlist's #EXT-X-PROGRAM-DATE-TIME must " +
  'take is not known here and the published timeline was not checked. Set E2E_EXPECT_SEGMENT_S to ' +
  "the deployment's HLS_FRAGMENT to have it checked";

/**
 * Every rung feed the broadcasts in this log window announced, whichever shape the deployment
 * publishes.
 *
 * ⛔ The NEWEST announce per rung, for the reason {@link lastUploadedSegmentRefByRung} records: a
 * session that an engine restart replaced announces again on a fresh topic while the retired one
 * keeps its own, and the retired feed is mid-finalize as the read happens. The newest announce is
 * the session a suite asking "what is this broadcast publishing" means. A suite that wants a
 * specific session filters {@link announcedRungs} itself and builds the feeds from that.
 *
 * The two line families are mode-exclusive, the way {@link announcedSessionTopics} relies on: a
 * ladder never writes `Adding stream to list` and a single rendition never announces a rung.
 */
export function rungFeedsOf(logText: string): RungFeed[] {
  const ladder = announcedRungs(logText);
  if (ladder.length > 0) {
    const byRung = new Map<string, RungFeed>();
    for (const announce of ladder) {
      byRung.set(announce.rung, { rung: announce.rung, streamId: announce.streamId, topic: announce.topic });
    }
    return [...byRung.values()];
  }

  return [...new Set(announcedLiveTopics(logText))].map((topic) => ({ rung: null, streamId: null, topic }));
}

/**
 * What one rung's playlist text says about its own timeline.
 *
 * Pure, so the whole verdict is reachable from CI on fixtures rather than only from a paid sitting.
 * {@link readRungPlaylists} is the half that needs a deployment.
 */
export function rungPlaylistReading(feed: RungFeed, body: string, contract: ManifestContract): RungPlaylistReading {
  const base = {
    rung: feed.rung,
    streamId: feed.streamId,
    topic: feed.topic,
    topicHex: feedTopicHexOf(feed.topic),
  };
  const text = body.trim();

  if (text === '') {
    return { ...base, ...NOTHING_READ, failures: [`the ${feedName(feed)} feed answered nothing at all`] };
  }
  // ⛔ Checked before the parse, not after. A gateway's own JSON error envelope parses as a playlist
  // naming no segments, so a reader that trusted the parse would report an empty timeline the
  // broadcast never published, on a stage that was publishing perfectly.
  if (!text.includes(PLAYLIST_MARKER)) {
    return {
      ...base,
      ...NOTHING_READ,
      failures: [`the ${feedName(feed)} feed answered no playlist, but ${excerpt(text)}`],
    };
  }

  const parsed = parseManifest(text);
  const recording = parsed.headers.includes(HLS_PLAYLIST_TYPE_VOD);
  const dates = programDateTimesOf(text);

  return {
    ...base,
    playlist: text,
    segments: parsed.segments.length,
    mediaSequence: mediaSequenceOf(text),
    firstDate: isoOf(dates[0]),
    lastDate: isoOf(dates[dates.length - 1]),
    recording,
    // A recording names every segment of the broadcast, so its sequence is 0 by construction and
    // that holds however late a suite read it. Left to the caller's flag, the one playlist whose
    // numbering can always be checked would go unchecked in every scenario that reads a finished
    // broadcast, which is every crash scenario that leaves one.
    failures: manifestContractFailures(text, {
      ...contract,
      firstOfBroadcast: contract.firstOfBroadcast || recording,
    }),
  };
}

/** The fields a reading carries when the feed produced no playlist to read. */
const NOTHING_READ = {
  playlist: null,
  segments: 0,
  mediaSequence: null,
  firstDate: null,
  lastDate: null,
  recording: false,
} as const;

/**
 * Read every rung's published playlist and hold each against the contract.
 *
 * One rung at a time rather than all at once. The reads go over one ssh master connection to the
 * deployment host, and nothing here compares one rung's timeline against another's, so there is
 * nothing a simultaneous read would buy.
 */
export async function readRungPlaylists(
  host: Host,
  cfg: E2EConfig,
  broadcast: BroadcastPlaylists,
  contract: ManifestContract,
): Promise<RungPlaylistReading[]> {
  const readings: RungPlaylistReading[] = [];
  for (const feed of broadcast.rungs) {
    readings.push(await readOneRungPlaylist(host, cfg, broadcast.owner, feed, contract));
  }
  return readings;
}

async function readOneRungPlaylist(
  host: Host,
  cfg: E2EConfig,
  owner: string,
  feed: RungFeed,
  contract: ManifestContract,
): Promise<RungPlaylistReading> {
  const route = `/feeds/${owner}/${feedTopicHexOf(feed.topic)}`;
  const deadline = Date.now() + PLAYLIST_RETRY_WINDOW_MS;

  for (;;) {
    const body = await host
      .localText(cfg.ports.beeGatewayApi, route, PLAYLIST_READ_TIMEOUT_S)
      .catch((error: Error) => `no answer from the gateway: ${error.message}`);
    const reading = rungPlaylistReading(feed, body, contract);

    // Retried only while nothing readable came back, never on a playlist the contract refused. A
    // rung whose timeline is wrong is wrong now and will be wrong in thirty seconds, and polling it
    // would turn one refusal into a wait that reports a timeout instead of the reason.
    if (reading.playlist !== null || Date.now() >= deadline) {
      return reading;
    }
    await sleep(PLAYLIST_RETRY_INTERVAL_MS);
  }
}

/**
 * Why the playlists this broadcast published do not meet the contract, or null.
 *
 * ⛔ An empty list refuses. A suite whose log window held no announce reaches here with nothing to
 * judge, and a check that was never made must not read as one that passed: that is the whole shape
 * of defect wiring the contract into a paid sitting exists to end.
 */
export function rungPlaylistRefusal(readings: readonly RungPlaylistReading[]): string | null {
  if (readings.length === 0) {
    return (
      'no rung feed was announced in this log window, so no published playlist was read and the ' +
      'manifest contract was not checked at all. Either the broadcast announced nothing, or the ' +
      'window was opened after its announces had scrolled past'
    );
  }

  const wrong = readings.filter((reading) => reading.failures.length > 0);
  if (wrong.length === 0) {
    return null;
  }

  return wrong.flatMap((reading) => reading.failures.map((failure) => `${feedName(reading)}: ${failure}`)).join('\n');
}

/**
 * One line per rung: what came back and the span of time it claims to cover.
 *
 * Printed by every wired suite whether it passes or fails, so a red names the segment and the date
 * it objected to against a reading of what the whole ladder held at that moment.
 */
export function describeRungPlaylists(readings: readonly RungPlaylistReading[]): string {
  return readings.map(lineFor).join('\n');
}

function lineFor(reading: RungPlaylistReading): string {
  const name = feedName(reading);
  if (reading.playlist === null) {
    return `  ${name}: nothing was read from its feed`;
  }

  const kind = reading.recording ? 'recording' : 'live';
  const sequence =
    reading.mediaSequence === null ? 'no #EXT-X-MEDIA-SEQUENCE' : `#EXT-X-MEDIA-SEQUENCE:${reading.mediaSequence}`;
  const span = reading.firstDate === null ? 'no dates' : `${reading.firstDate} to ${reading.lastDate}`;

  return `  ${name}: ${kind}, ${reading.segments} segments, ${sequence}, ${span}`;
}

/** How a report names one feed: its rung, or what a deployment with no rungs is. */
function feedName({ rung, topic }: Pick<RungFeed, 'rung' | 'topic'>): string {
  return `${rung ?? 'single rendition'} (topic ${topic})`;
}

function isoOf(stamp: number | null | undefined): string | null {
  return stamp === null || stamp === undefined ? null : new Date(stamp).toISOString();
}

function excerpt(text: string): string {
  const head = text.slice(0, BODY_EXCERPT_CHARS).replace(/\s+/g, ' ');
  return text.length > BODY_EXCERPT_CHARS ? `answered ${head}…` : `answered ${head}`;
}
