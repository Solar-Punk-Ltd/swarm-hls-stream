/**
 * Which qualities a ladder's master playlist is offering a viewer who joins right now.
 *
 * ## What a master playlist is, in one sentence
 *
 * One small text file per ladder, published to a feed of its own, naming every rendition a player
 * may choose and where each one's playlist lives.
 *
 * ## ⛔ Why nothing read this until the drain suites needed it
 *
 * `service/abr-ladder.test.ts` says outright that it does not assert the master is correct. It reads
 * the uploader's log, which can say four rungs published and nothing at all about what a viewer is
 * offered. The master's TEXT belongs to `packages/shared/test/masterPlaylist.test.ts` and reading it
 * back belongs to `packages/client/test/ladderSource.test.ts`, both on fixtures. Nothing had ever
 * read the master a paid broadcast actually published.
 *
 * That is the half of a rung death nothing could see. A drained rung going quiet is one thing. The
 * other is that the master stops offering it, so a viewer joining during the drain is not handed a
 * quality with nothing behind it. Observed 2026-08-31, before the dead-rung rule shipped: the master
 * went on naming 1080p for minutes after that rung was unpublished.
 *
 * ## ⛔ Rungs are joined by TOPIC, never by resolution
 *
 * A master carries `RESOLUTION=1920x1080` and a `swarm://` feed address per rendition, and no rung
 * name anywhere: rung names are the uploader's, and a master speaks a player's language. Matching on
 * the geometry would mean a second copy of the ladder's name-to-height mapping living here, and it
 * would break on any two rungs sharing a height. The topic is exact, the rung announce already
 * carries it, and it is what the player itself resolves.
 *
 * ## ⛔ Where the master lives
 *
 * The feed topic **is** the ladder's group id, which is the identifier every rung already agrees on
 * and the catalog already carries. So a suite that has read the group off a rung announce needs
 * nothing further to find the master. See `MasterFeedWriter` for why that is deliberate rather than
 * convenient.
 *
 * The parse and the verdict are pure so `test/masterShape.test.ts` covers them under `pnpm verify`,
 * which nothing under `suites/` is. {@link readLadderMaster} is the only wiring.
 */

import { HLS_STREAM_INF, parseSwarmUri } from '@swarm-hls-stream/shared';

import { feedTopicHexOf } from '../browser/rungManifest.js';
import type { E2EConfig } from '../config.js';

import type { Host } from './host.js';
import { sleep } from './wait.js';

/** How long one master read is given before the parse records what the gateway did answer. */
const MASTER_READ_TIMEOUT_S = 15;
/**
 * How long the master is given to answer with a playlist at all, across retries.
 *
 * Spent only when the feed answers nothing usable. A gateway that is restarting answers its own
 * error envelope for a few seconds, and a suite failing on that would name the transport rather than
 * the product. The same window `manifestContractLive.ts` gives a rung feed, for the same reason.
 */
const MASTER_RETRY_WINDOW_MS = 30_000;
const MASTER_RETRY_INTERVAL_MS = 2_000;

/** Enough of a body to recognise it in a failure, without pasting a whole playlist into one. */
const BODY_EXCERPT_CHARS = 120;

/**
 * What one master playlist is offering, and what it names that this ladder cannot account for.
 *
 * Not exported: every caller gets it from {@link masterRungsOf} and passes it straight to
 * {@link masterRungRefusal} or {@link describeMaster}, so a name here would be a promise nothing
 * imports. The same reason `BatchRefusal` is unexported in `logwatch.ts`.
 */
interface MasterRungs {
  /**
   * Whether the body is a multivariant playlist at all.
   *
   * ⛔ Kept apart from an empty {@link offered}. A media playlist is not a master with no rungs, and
   * neither is a gateway error envelope: reading either as an empty ladder would report a broadcast
   * offering nothing, on a stage that is publishing perfectly.
   */
  readonly isMaster: boolean;
  /** The rung names the master offers, in the order it lists them, which is lowest first. */
  readonly offered: readonly string[];
  /**
   * Feed topics the master named that no rung of this ladder announced.
   *
   * ⛔ Reported rather than dropped. It means the master being read belongs to another broadcast, and
   * a suite that ignored it would compare a stranger's ladder against its own expectation.
   */
  readonly unclaimedTopics: readonly string[];
}

/**
 * The rungs one master playlist offers, joined to rung names through the topics the log announced.
 *
 * @param rungByTopic every rung of this ladder by its raw feed topic, out of `announcedRungs`
 */
export function masterRungsOf(masterText: string, rungByTopic: ReadonlyMap<string, string>): MasterRungs {
  if (!masterText.includes(HLS_STREAM_INF)) {
    return { isMaster: false, offered: [], unclaimedTopics: [] };
  }

  const byHashedTopic = new Map([...rungByTopic].map(([topic, rung]) => [feedTopicHexOf(topic), rung]));
  const offered: string[] = [];
  const unclaimedTopics: string[] = [];

  for (const topic of masterVariantTopics(masterText)) {
    const rung = byHashedTopic.get(feedTopicHexOf(topic));
    if (rung === undefined) {
      unclaimedTopics.push(topic);
      continue;
    }
    if (!offered.includes(rung)) {
      offered.push(rung);
    }
  }

  return { isMaster: true, offered, unclaimedTopics };
}

/**
 * The feed topics a master points at, in the order it lists them.
 *
 * The URI is on the line AFTER each rendition tag, which is what the HLS format says and what
 * `buildMasterPlaylist` writes. A tag with nothing under it, or another tag under it, names no feed
 * and is skipped rather than credited to whichever line followed.
 */
function masterVariantTopics(masterText: string): string[] {
  const lines = masterText.split('\n').map((line) => line.trim());
  const topics: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(HLS_STREAM_INF)) {
      continue;
    }
    const uri = lines[i + 1];
    if (uri === undefined || uri === '' || uri.startsWith('#')) {
      continue;
    }
    const { owner, topic } = parseSwarmUri(uri);
    if (owner !== '' && topic !== undefined && topic !== '') {
      topics.push(topic);
    }
    i++;
  }
  return topics;
}

/**
 * Why the master is not offering the rungs it should be, or null.
 *
 * ⛔ Three causes kept apart, because they have three different fixes. A body that is not a master
 * means the feed read is wrong or the ladder never published one. A stranger topic means the master
 * read belongs to another broadcast. A wrong rung set is the product, and both directions of it are
 * real: still offering a dead rung hands a joining viewer a quality with nothing behind it, and
 * dropping a live one takes a rung away from viewers who were watching it.
 *
 * ⚠️ Order is not judged. It is the uploader's to choose and a player reads the whole list.
 */
export function masterRungRefusal(read: MasterRungs, expected: readonly string[]): string | null {
  if (!read.isMaster) {
    return (
      `the ladder's master feed answered no multivariant playlist: nothing in the body carries ` +
      `${HLS_STREAM_INF}. A rung's own media playlist and a gateway error envelope both read this ` +
      'way, so either the feed being read is not the master or this ladder never published one.'
    );
  }

  if (read.unclaimedTopics.length > 0) {
    return (
      `the master offers ${read.unclaimedTopics.length} feed(s) no rung of this ladder announced: ` +
      `${read.unclaimedTopics.join(', ')}. This is another broadcast's master, so the rung set read ` +
      'off it says nothing about the one under test.'
    );
  }

  const missing = expected.filter((rung) => !read.offered.includes(rung));
  const extra = read.offered.filter((rung) => !expected.includes(rung));
  if (missing.length === 0 && extra.length === 0) {
    return null;
  }

  const wrong = [
    extra.length === 0 ? null : `it still offers ${extra.join(', ')}, which stopped being produced`,
    missing.length === 0 ? null : `it no longer offers ${missing.join(', ')}, which never stopped`,
  ].filter((part): part is string => part !== null);

  return (
    `the master offers ${read.offered.join(', ') || 'nothing'} where it should offer ` +
    `${expected.join(', ')}: ${wrong.join(', and ')}. A master naming a rung nothing is producing ` +
    'hands a viewer who joins now a quality with nothing behind it, and one missing a rung that is ' +
    'still publishing takes that quality away from every viewer who could have used it.'
  );
}

/**
 * Read one ladder's published master playlist off the gateway, the way the client reads it.
 *
 * Retried rather than read once, for the reason `readOneRungPlaylist` records: a gateway that is
 * restarting answers its own error envelope for a few seconds, and failing on that would name the
 * transport rather than the product. Hands back whatever the gateway last said, so the caller's
 * refusal is about the body rather than about a throw.
 *
 * @param owner the signer's address, as `discoverCatalogFeed` reads it off the `[StreamCatalog]` line
 * @param group the ladder group, which is also the master feed's topic. See `MasterFeedWriter`
 */
export async function readLadderMaster(host: Host, cfg: E2EConfig, owner: string, group: string): Promise<string> {
  const route = `/feeds/${owner}/${feedTopicHexOf(group)}`;
  const deadline = Date.now() + MASTER_RETRY_WINDOW_MS;

  for (;;) {
    const body = await host
      .localText(cfg.ports.beeGatewayApi, route, MASTER_READ_TIMEOUT_S)
      .catch((error: Error) => `no answer from the gateway: ${error.message}`);

    if (body.includes(HLS_STREAM_INF) || Date.now() >= deadline) {
      return body;
    }
    await sleep(MASTER_RETRY_INTERVAL_MS);
  }
}

/** One line an operator reads beside a verdict: what the master held at the moment it was read. */
export function describeMaster(read: MasterRungs, body: string): string {
  if (!read.isMaster) {
    const head = body.trim().slice(0, BODY_EXCERPT_CHARS).replace(/\s+/g, ' ');
    return `the master feed answered no playlist, but ${head || 'nothing at all'}`;
  }
  const strangers = read.unclaimedTopics.length === 0 ? '' : `, plus ${read.unclaimedTopics.length} unclaimed feed(s)`;
  return `the master offers ${read.offered.length} rung(s): ${read.offered.join(', ')}${strangers}`;
}
