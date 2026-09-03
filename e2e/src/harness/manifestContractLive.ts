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
 * one or the harness had to hold `STREAM_KEY`. Neither is so. **There is one feed owner for the whole
 * uploader**: `StreamCatalog`, `MasterFeedWriter` and every `StreamUploader` build their signer from
 * the same `STREAM_KEY` (`packages/stream-uploader/src/index.ts`), so the address
 * `discoverCatalogFeed` already reads out of the `[StreamCatalog]` line owns every rung's playlist
 * feed as well. The topic comes from the rung announce, and the read is the one `e2e/browser/vod.ts`
 * already makes:
 *
 *   `GET /feeds/{owner}/{feedTopicHexOf(rawTopic)}` on the bee gateway, which answers the m3u8 itself.
 *
 * ## What one read covers
 *
 * The live playlist and the recording are the same feed at different indices, because `finalize`
 * publishes the closing live playlist and then the VOD manifest to the stream's own manifest feed. A
 * feed read answers with the head, so a suite reading mid-broadcast gets the live playlist and one
 * reading after the finalize gets the recording. {@link RungPlaylistParse.recording} says which
 * arrived rather than leaving a reader to guess.
 *
 * ## ⛔ Why fetching and judging are two steps
 *
 * `#EXT-X-MEDIA-SEQUENCE:0` is required of the playlist that still starts at the broadcast's first
 * segment, and the live window is a byte budget that slides once the broadcast outgrows it. A suite
 * cannot know from the clock whether it read before that: at 2s fragments the window holds about a
 * minute, and a suite that asserted zero because it "read early" would be green on the wall clock
 * rather than on the product. So the read hands back what the feed said, the suite establishes what
 * it can defend, and {@link judgeRungPlaylists} applies the rules. See
 * {@link namesEverySegmentPublished} for the one derivation that settles it without a stopwatch.
 *
 * ⛔ Correctness only. Nothing here times anything and nothing here refuses on a duration. See the
 * repository's rule on what an e2e suite may gate on.
 */

import { HLS_PLAYLIST_TYPE_VOD, parseManifest } from '@swarm-hls-stream/shared';

import { feedTopicHexOf } from '../browser/rungManifest.js';
import type { E2EConfig } from '../config.js';
import { SEGMENT_ANY, type SegmentExpectation } from '../segmentLength.js';

import type { Host } from './host.js';
import { announcedLiveTopics, announcedRungs, segmentIndicesByStream } from './logwatch.js';
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
   * The stream the uploader keyed its segment and manifest lines on, or null where no line names one.
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
   * The signer's address, as `discoverCatalogFeed` reads it off the `[StreamCatalog]` line. One for
   * the catalog, every master and every rung. See the header.
   */
  owner: string;
  rungs: readonly RungFeed[];
}

/** What one rung's feed answered, before any rule is applied to it. */
export interface RungPlaylistParse {
  rung: string | null;
  streamId: string | null;
  topic: string;
  /** The topic as the gateway's `/feeds/{owner}/{topic}` route wants it. */
  topicHex: string;
  /** The m3u8 as the gateway served it, or null where the feed answered something that is not one. */
  playlist: string | null;
  /** Why nothing could be read, or null. Kept apart from a contract failure: this is the transport. */
  unreadable: string | null;
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
}

/** One rung's playlist with the contract applied to it. */
export interface RungPlaylistReading extends RungPlaylistParse {
  /** Everything wrong with this rung's timeline, or empty. Holds the transport reason too. */
  failures: readonly string[];
}

/** How long one feed read is given before the parse records what the gateway did answer. */
const PLAYLIST_READ_TIMEOUT_S = 15;
/**
 * How long a rung is given to answer with a playlist at all, across retries.
 *
 * Spent only by a rung whose feed answered nothing usable. A gateway that is restarting answers its
 * own error envelope for a few seconds, and a suite failing on that would name the transport rather
 * than the product.
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
 * ⛔ The run's declaration and never a measurement. `#EXT-X-PROGRAM-DATE-TIME` is derived from
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
 * ⛔ The NEWEST announce per rung, for the reason `lastUploadedSegmentRefByRung` records: a session
 * an engine restart replaced announces again on a fresh topic while the retired one keeps its own,
 * and the retired feed is mid-finalize as the read happens. The newest announce is the session a
 * suite asking "what is this broadcast publishing" means. A suite that wants a specific session
 * filters `announcedRungs` itself and builds the feeds from that.
 *
 * The two line families are mode-exclusive, the way `announcedSessionTopics` relies on: a ladder
 * never writes `Adding stream to list` and a single rendition never announces a rung.
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
 * The feeds of the rungs that actually published, out of the announces and the segment lines in one
 * log window.
 *
 * ⛔ Scoped to rungs whose stream uploaded a segment, and that scope is the point. A rung that
 * announced and never uploaded has an empty feed, and refusing on that would be this check inventing
 * a red for a rung the suite around it deliberately does not judge: `service/happy-path` asserts
 * about "every rung that uploaded a segment" and scenario I warms up on a merged count that one fast
 * rung can satisfy alone.
 *
 * A single-rendition feed carries no stream id, so it is kept whenever the window holds any upload
 * at all. There is one stream on such a deployment, so there is nothing else the uploads could
 * belong to.
 */
export function publishingRungFeedsOf(logText: string): RungFeed[] {
  const published = publishedCountsOf(logText);
  return rungFeedsOf(logText).filter((feed) =>
    feed.streamId === null ? published.size > 0 : published.has(feed.streamId),
  );
}

/**
 * Segment uploads per stream, which is what {@link namesEverySegmentPublished} weighs a playlist
 * against.
 */
export function publishedCountsOf(logText: string): ReadonlyMap<string, number> {
  return new Map([...segmentIndicesByStream(logText)].map(([streamId, indices]) => [streamId, indices.length]));
}

/**
 * What one rung's playlist text says about itself.
 *
 * Pure, so everything but the feed read is reachable from CI on fixtures rather than only from a
 * paid sitting.
 */
export function rungPlaylistParse(feed: RungFeed, body: string): RungPlaylistParse {
  const base = {
    rung: feed.rung,
    streamId: feed.streamId,
    topic: feed.topic,
    topicHex: feedTopicHexOf(feed.topic),
  };
  const text = body.trim();

  if (text === '') {
    return { ...base, ...NOTHING_READ, unreadable: `the ${feedName(feed)} feed answered nothing at all` };
  }
  // ⛔ Checked before the parse, not after. A gateway's own JSON error envelope parses as a playlist
  // naming no segments, so a reader that trusted the parse would report an empty timeline the
  // broadcast never published, on a stage that was publishing perfectly.
  if (!text.includes(PLAYLIST_MARKER)) {
    return {
      ...base,
      ...NOTHING_READ,
      unreadable: `the ${feedName(feed)} feed answered no playlist, but ${excerpt(text)}`,
    };
  }

  const parsed = parseManifest(text);
  const dates = programDateTimesOf(text);

  return {
    ...base,
    playlist: text,
    unreadable: null,
    segments: parsed.segments.length,
    mediaSequence: mediaSequenceOf(text),
    firstDate: isoOf(dates[0]),
    lastDate: isoOf(dates[dates.length - 1]),
    recording: parsed.headers.includes(HLS_PLAYLIST_TYPE_VOD),
  };
}

/** The fields a parse carries when the feed produced no playlist to read. */
const NOTHING_READ = {
  playlist: null,
  segments: 0,
  mediaSequence: null,
  firstDate: null,
  lastDate: null,
  recording: false,
} as const;

/**
 * Read every rung's published playlist, without judging any of it.
 *
 * One rung at a time rather than all at once. The reads go over one ssh master connection to the
 * deployment host, and nothing here compares one rung's timeline against another's, so there is
 * nothing a simultaneous read would buy.
 */
export async function readRungPlaylists(
  host: Host,
  cfg: E2EConfig,
  broadcast: BroadcastPlaylists,
): Promise<RungPlaylistParse[]> {
  const parses: RungPlaylistParse[] = [];
  for (const feed of broadcast.rungs) {
    parses.push(await readOneRungPlaylist(host, cfg, broadcast.owner, feed));
  }
  return parses;
}

async function readOneRungPlaylist(
  host: Host,
  cfg: E2EConfig,
  owner: string,
  feed: RungFeed,
): Promise<RungPlaylistParse> {
  const route = `/feeds/${owner}/${feedTopicHexOf(feed.topic)}`;
  const deadline = Date.now() + PLAYLIST_RETRY_WINDOW_MS;

  for (;;) {
    const body = await host
      .localText(cfg.ports.beeGatewayApi, route, PLAYLIST_READ_TIMEOUT_S)
      .catch((error: Error) => `no answer from the gateway: ${error.message}`);
    const parse = rungPlaylistParse(feed, body);

    if (parse.playlist !== null || Date.now() >= deadline) {
      return parse;
    }
    await sleep(PLAYLIST_RETRY_INTERVAL_MS);
  }
}

/**
 * Whether this playlist can only be the broadcast's first, from how much its rung had published.
 *
 * A live window that has slid names exactly the newest segments that fit its byte budget, so a
 * playlist naming at least as many segments as the rung has ever published has dropped none and
 * therefore still starts at the broadcast's first. That is a fact about the playlist rather than
 * about when it was read, which is the whole reason it exists.
 *
 * ⛔⛔ **Read the count AFTER the playlist, never before.** A count taken first can be lower than
 * what the broadcast had actually published by the time the playlist was fetched, and this would
 * then call a slid window a first playlist and demand a sequence of 0 that the product is right to
 * have moved past. Taken afterwards it can only be too high, which costs an assertion nobody was
 * owed rather than a red on correct code.
 *
 * @param publishedByNow segment uploads the uploader's log attributes to this rung
 */
export function namesEverySegmentPublished(parse: RungPlaylistParse, publishedByNow: number): boolean {
  return parse.playlist !== null && parse.segments >= publishedByNow;
}

/**
 * How many segments this rung had published, out of the log's per-stream counts, or null where the
 * counts cannot be attributed to it.
 *
 * A single-rendition feed carries no stream id, so it takes the count of the one stream the window
 * holds. Two or more streams with no id to choose between them is a case this refuses to guess at,
 * and null there costs an assertion rather than risking one against another broadcast's numbers.
 */
export function publishedFor(parse: RungPlaylistParse, byStream: ReadonlyMap<string, number>): number | null {
  if (parse.streamId !== null) {
    return byStream.get(parse.streamId) ?? null;
  }
  return byStream.size === 1 ? [...byStream.values()][0] : null;
}

/**
 * Apply the contract to every parse.
 *
 * ⛔ A recording is held to sequence 0 whatever the caller promised, because a recording names every
 * segment of the broadcast by construction and that holds however late it was read. Left to the
 * caller's flag, the one playlist whose numbering can always be checked would go unchecked in every
 * scenario that reads a finished broadcast, which is every crash scenario that leaves one.
 *
 * @param knownFirst per rung, whether the suite can show this playlist still starts at the
 *   broadcast's first segment. Defaults to the contract's own flag for every rung. See
 *   {@link namesEverySegmentPublished}.
 */
export function judgeRungPlaylists(
  parses: readonly RungPlaylistParse[],
  contract: ManifestContract,
  knownFirst: (parse: RungPlaylistParse) => boolean = () => contract.firstOfBroadcast,
): RungPlaylistReading[] {
  return parses.map((parse) => ({
    ...parse,
    failures:
      parse.playlist === null
        ? [parse.unreadable ?? 'nothing was read from this feed and no reason was recorded']
        : manifestContractFailures(parse.playlist, {
            ...contract,
            firstOfBroadcast: parse.recording || knownFirst(parse),
          }),
  }));
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

/** What a suite asks about the playlists its broadcast published. */
export interface TimelineCheck {
  /** The signer's address, from `discoverCatalogFeed`. See {@link BroadcastPlaylists.owner}. */
  owner: string;
  /** Usually {@link publishingRungFeedsOf} over the suite's own log window. */
  rungs: readonly RungFeed[];
  /**
   * What the run declared it needs a segment to be, out of `cfg.segmentExpectation`. A run that
   * pinned none leaves the timeline unchecked and says so. See {@link fragmentSecondsFor}.
   */
  expectation: SegmentExpectation;
  /**
   * The uploader's log, re-read once the playlists are in hand.
   *
   * ⛔ Called by this function AFTER the reads and never before, which is the ordering
   * {@link namesEverySegmentPublished} depends on and the reason it is a callback rather than a
   * string. Its per-stream segment counts are what prove a live window has not slid, so leaving it
   * out means sequence 0 is asserted on recordings alone.
   *
   * Scope it to the session under test. A suite that restarted the engine mid-broadcast must count
   * from the restart, or the retired session's segments make every recovered playlist look slid.
   */
  logAfterTheRead?: () => Promise<string>;
}

/** What a suite prints and asserts on. */
export interface TimelineVerdict {
  /**
   * One line per rung, or the sentence saying why nothing was checked.
   *
   * A suite prints this whether it passes or fails, so the two states are told apart in the run's own
   * output rather than by a field nobody reads.
   */
  summary: string;
  /** Why the published playlists do not meet the contract, or null. */
  refusal: string | null;
}

/**
 * Read the playlists this broadcast published and say what is wrong with them.
 *
 * The one call a live suite makes. It reads each rung's feed, re-reads the log to learn what each
 * rung had published by then, applies the contract and composes both the summary and the refusal, so
 * a red is legible beside a reading of what the whole ladder held at that moment.
 */
export async function checkPublishedTimeline(
  host: Host,
  cfg: E2EConfig,
  check: TimelineCheck,
): Promise<TimelineVerdict> {
  const fragmentSeconds = fragmentSecondsFor(check.expectation);
  if (fragmentSeconds === null) {
    return { summary: `  ${UNCHECKED_WITHOUT_FRAGMENT}`, refusal: null };
  }

  const parses = await readRungPlaylists(host, cfg, { owner: check.owner, rungs: check.rungs });
  const published = check.logAfterTheRead === undefined ? null : publishedCountsOf(await check.logAfterTheRead());
  const readings = judgeRungPlaylists(parses, { fragmentSeconds, firstOfBroadcast: false }, (parse) => {
    if (published === null) {
      return false;
    }
    const byNow = publishedFor(parse, published);
    return byNow !== null && namesEverySegmentPublished(parse, byNow);
  });

  return { summary: describeRungPlaylists(parses), refusal: rungPlaylistRefusal(readings) };
}

/**
 * One line per rung: what came back and the span of time it claims to cover.
 *
 * Printed by every wired suite whether it passes or fails, so a red names the segment and the date
 * it objected to beside a reading of what the whole ladder held at that moment.
 */
export function describeRungPlaylists(parses: readonly RungPlaylistParse[]): string {
  return parses.map(lineFor).join('\n');
}

function lineFor(parse: RungPlaylistParse): string {
  const name = feedName(parse);
  if (parse.playlist === null) {
    return `  ${name}: nothing was read from its feed`;
  }

  const kind = parse.recording ? 'recording' : 'live';
  const sequence =
    parse.mediaSequence === null ? 'no #EXT-X-MEDIA-SEQUENCE' : `#EXT-X-MEDIA-SEQUENCE:${parse.mediaSequence}`;
  const span = parse.firstDate === null ? 'no dates' : `${parse.firstDate} to ${parse.lastDate}`;

  return `  ${name}: ${kind}, ${parse.segments} segments, ${sequence}, ${span}`;
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
