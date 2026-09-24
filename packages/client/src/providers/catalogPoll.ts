import { STREAM_STATUS_SCHEDULED, StreamState } from '@/types/stream';

/**
 * How often a page that shows the catalog reads it again, in milliseconds.
 *
 * One number for both pages that poll: the browse page always, and the watch page while the stream it
 * shows has not started. Both use the same SWR key, so a viewer moving between the two pages never
 * has two polls running against the gateway.
 */
export const CATALOG_POLL_INTERVAL_MS = 5_000;

/**
 * How often the watch page has to read the catalog again for the stream it shows, or null when it
 * need not.
 *
 * ⛔ **Only a scheduled entry needs it.** The page decides to show "This stream has not started yet"
 * from the catalog entry's `state` alone, and without a poll the catalog is read once, when the app
 * loads. A viewer who opened the link before the start then stayed on that message after the
 * broadcast began, until they reloaded the page. Once the entry is live the player follows the
 * stream's own feeds, and the page deliberately keeps no catalog poll for that case, see
 * `isStreamListLoaded` in `providers/App.tsx`.
 */
export function watchPageCatalogPollMs(state: StreamState | undefined): number | null {
  return state === STREAM_STATUS_SCHEDULED ? CATALOG_POLL_INTERVAL_MS : null;
}
