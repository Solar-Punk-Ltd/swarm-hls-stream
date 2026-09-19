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
  /** The catalog body just read, parsed, or null when the read found nothing. */
  fetched: unknown;
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
 * ⭐ **On the same gateway, a poll that carries nothing keeps what is on screen.** That is the older
 * rule and it is still right: a catalog refresh that fails or comes back empty is not a reason to
 * blank a usable list, and a viewer can open a stale stream while they can do nothing with an empty
 * page.
 *
 * The timestamp comparison is what makes a poll cheap to apply and is also why the gateway has to be
 * part of this: two nodes number their own view of the feed, so a fresh node's catalog is routinely
 * older than the one already on screen and would be refused for ever by the comparison alone.
 */
export function nextStreamList({ held, fetched, isSameGateway }: CatalogPoll): Stream[] | null {
  const streams = Array.isArray(fetched) && fetched.every(isStream) ? fetched : [];

  if (!isSameGateway) {
    return streams;
  }

  if (streams.length === 0) {
    return null;
  }

  const latestFetched = streams[streams.length - 1];
  const latestHeld = held[held.length - 1];

  return !latestHeld || latestFetched.timestamp > latestHeld.timestamp ? streams : null;
}
