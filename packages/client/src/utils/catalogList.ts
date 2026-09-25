import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, Rendition, Stream } from '@/types/stream';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isRendition(value: unknown): value is Rendition {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.name === 'string' &&
    typeof value.topic === 'string' &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    isFiniteNumber(value.bandwidth) &&
    isFiniteNumber(value.avgBandwidth) &&
    isOptionalFiniteNumber(value.index) &&
    isOptionalFiniteNumber(value.duration)
  );
}

function isStream(value: unknown): value is Stream {
  if (!isRecord(value)) {
    return false;
  }

  const hasUsableRenditions =
    value.renditions === undefined || (Array.isArray(value.renditions) && value.renditions.every(isRendition));
  const hasUsableDuration =
    value.duration === undefined || typeof value.duration === 'string' || isFiniteNumber(value.duration);
  const hasUsableScheduledStart =
    value.scheduledStartTime === undefined ||
    value.scheduledStartTime === null ||
    typeof value.scheduledStartTime === 'string' ||
    isFiniteNumber(value.scheduledStartTime);

  return (
    typeof value.owner === 'string' &&
    typeof value.topic === 'string' &&
    typeof value.title === 'string' &&
    isFiniteNumber(value.timestamp) &&
    (value.mediatype === MEDIA_TYPE_AUDIO || value.mediatype === MEDIA_TYPE_VIDEO) &&
    (value.state === undefined || typeof value.state === 'string') &&
    hasUsableDuration &&
    isOptionalFiniteNumber(value.index) &&
    (value.thumbnail === undefined || typeof value.thumbnail === 'string') &&
    hasUsableScheduledStart &&
    hasUsableRenditions
  );
}

/**
 * One catalog poll, and what the page is holding when it lands.
 *
 * `fetched` is deliberately `unknown`: it is whatever `JSON.parse` made of a feed slot written by
 * another program, so it is validated here rather than trusted by the caller.
 */
interface CatalogPoll {
  /** The streams on screen. */
  held: Stream[];
  /** The feed slot the streams on screen were read from, or null when that is not known. */
  heldSlot: bigint | null;
  /** The catalog body just read, parsed, or null when the read found nothing. */
  fetched: unknown;
  /** The feed slot {@link fetched} was read from, or null when the gateway did not say. */
  fetchedSlot: bigint | null;
  /** Whether the streams on screen came from the gateway this read went to. */
  isSameGateway: boolean;
}

/**
 * What the stream list should become after a poll, or null to keep what is on screen.
 *
 * ⛔ **A read from another gateway replaces the list whatever it holds, including nothing.** Until
 * this rule existed, switching node left the previous gateway's streams on the page: a viewer who
 * pointed the picker at their own Bee node, which holds none of that catalog yet, saw the site
 * gateway's ten streams, believed their node was serving them, and got "Reconnecting to the stream"
 * on a stream their node has never heard of. The message written for that moment, "Could not reach
 * this gateway", could not appear at all, because a non-empty list is what the page looks at first.
 *
 * ⭐ **On the same gateway, a poll that carries no valid catalog keeps what is on screen.** That is
 * the older rule and it is still right: a read that failed, found nothing newer or brought a body
 * that does not validate is not a reason to blank a usable list, and a viewer can open a stale stream
 * while they can do nothing with an empty page.
 *
 * ⛔ **On the same gateway, a valid catalog read from a newer feed slot is taken whatever changed in
 * it, and one from the same or an older slot never is.** The catalog has two writers and they change
 * it in different places. The stack's own uploader removes a changed entry and appends it again, so
 * its changes always land on the last entry. The web2 admin appends an entry when it first publishes
 * it and from then on replaces it where it stands, on go-live, end and every edit, and an unpublish
 * removes an entry without touching any other. This used to compare only the last entries'
 * timestamps, so in admin mode a stream that was not the newest entry could go live, end, be renamed
 * or be unpublished without an open page ever showing it before a reload, and a watch page waiting on
 * a scheduled stream only started for the newest one.
 *
 * **That includes a catalog that is empty.** Unpublishing the last stream leaves the admin's catalog
 * empty, and only a newer slot can say so: a read that failed or found nothing newer brings no body
 * and no slot, and a body that does not validate is refused whatever its slot, so a writer's mistake
 * cannot blank every open page.
 *
 * The slot orders two reads rather than whether their lists differ, because the reader can hand back
 * an older slot after a newer one. The app's first read and the browse page's first poll resolve the
 * head at the same time and either can land last, and a head resolved again, after the viewer confirms
 * the gateway they are already on, is checked against nothing already on screen. Taking any list that
 * differs would put an older catalog back, an unpublished stream with it.
 *
 * A catalog whose slot is not known keeps the older rule: it is taken only when it holds streams and
 * nothing is on screen or its last entry is newer than the last one held. That is a head read whose
 * `swarm-feed-index` header was missing or unreadable, or a list that came from one. Bee sends that
 * header on every feed read and exposes it to the page, so only a proxy that drops it leads here, and
 * there an in-place change or an emptied catalog still waits for a reload.
 *
 * The gateway has to be part of all of this because each node resolves its own head: a node freshly
 * pointed at this catalog routinely answers with an older slot than the one on screen, and the
 * comparison alone would refuse it for ever.
 */
export function nextStreamList({ held, heldSlot, fetched, fetchedSlot, isSameGateway }: CatalogPoll): Stream[] | null {
  const isValidCatalog = Array.isArray(fetched) && fetched.every(isStream);
  const streams = isValidCatalog ? fetched : [];

  if (!isSameGateway) {
    return streams;
  }

  if (fetchedSlot !== null && heldSlot !== null) {
    return isValidCatalog && fetchedSlot > heldSlot ? streams : null;
  }

  return hasNewerLastEntry(held, streams) ? streams : null;
}

/**
 * The older rule, for a read whose slot is not known: a list that holds streams is newer when nothing
 * is on screen or its last entry is newer than the last one held. A list with no streams never is.
 */
function hasNewerLastEntry(held: Stream[], fetched: Stream[]): boolean {
  const latestFetched = fetched[fetched.length - 1];
  if (!latestFetched) {
    return false;
  }
  const latestHeld = held[held.length - 1];
  return !latestHeld || latestFetched.timestamp > latestHeld.timestamp;
}
