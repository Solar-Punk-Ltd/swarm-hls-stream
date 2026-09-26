import { Stream, STREAM_STATUS_SCHEDULED } from '@/types/stream';

/** The catalog has not been read yet, so nothing can tell an announced stream from a live one. */
export const WATCH_VIEW_LOADING = 'loading';
/** The catalog lists the stream as announced, which means no feed has been written under it yet. */
export const WATCH_VIEW_NOT_STARTED = 'not-started';
/** The stream this page was waiting to start has left the catalog. */
export const WATCH_VIEW_UNAVAILABLE = 'unavailable';
/**
 * An entry that is live, recorded or in a state this page does not know, or a stream the catalog
 * does not list that the page was not waiting for, such as a deep link.
 */
export const WATCH_VIEW_PLAYER = 'player';

/** What the watch page puts where the player goes. */
export type WatchPageView =
  | typeof WATCH_VIEW_LOADING
  | typeof WATCH_VIEW_NOT_STARTED
  | typeof WATCH_VIEW_UNAVAILABLE
  | typeof WATCH_VIEW_PLAYER;

/** The part of a catalog entry the watch page decides on. */
type ListedStream = Pick<Stream, 'state'>;

/**
 * Whether the page is waiting for its stream to start, after one more look at the stream list.
 *
 * An entry in the list answers the question outright. A list without the entry keeps the previous
 * answer, because the list alone cannot tell a stream that was unpublished from one the catalog never
 * had: the web2 admin removes an entry when it unpublishes it, and a deep link names a topic no entry
 * ever carried.
 *
 * @param wasWaiting The answer from the previous look, false before the first.
 * @param listed The page's entry in the list it now holds, or undefined when the list does not have it.
 */
export function isWaitingForStart(wasWaiting: boolean, listed: ListedStream | undefined): boolean {
  return listed === undefined ? wasWaiting : listed.state === STREAM_STATUS_SCHEDULED;
}

/**
 * What the watch page shows, from the stream list it holds.
 *
 * ⛔ **A stream the page was waiting for that leaves the list is no longer available, and the player
 * is not mounted for it.** An announced broadcast has no manifest feed under its topic, so a player
 * mounted there polls a slot nobody writes and loads for ever. The stream list follows every catalog
 * change, so an unpublish in the web2 admin reaches a page that is waiting and takes the entry away.
 *
 * ⭐ **Everything else the list does not have still plays.** A deep link to a topic this catalog does
 * not list may be a real stream, and nothing here knows better. So may a stream that was already
 * playing when its entry went: a viewer switching to a node that has not caught up with this catalog
 * gets that node's list, whatever it holds, and the page stopped waiting when the entry said live.
 *
 * @param isStreamListLoaded Whether the app's first catalog read has landed. The ladder comes from
 *   the catalog, and a player mounted before it would start on one rendition and rebuild a second later.
 * @param listed The page's entry in the stream list, or undefined when the list does not have it.
 * @param isWaiting What {@link isWaitingForStart} answered for this same list.
 */
export function watchPageView(
  isStreamListLoaded: boolean,
  listed: ListedStream | undefined,
  isWaiting: boolean,
): WatchPageView {
  if (!isStreamListLoaded) {
    return WATCH_VIEW_LOADING;
  }
  if (listed === undefined) {
    return isWaiting ? WATCH_VIEW_UNAVAILABLE : WATCH_VIEW_PLAYER;
  }
  return listed.state === STREAM_STATUS_SCHEDULED ? WATCH_VIEW_NOT_STARTED : WATCH_VIEW_PLAYER;
}
