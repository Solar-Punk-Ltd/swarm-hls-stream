/**
 * What the browse page should show, given what the catalog fetch has managed so far.
 *
 * The page used to read only `data` off SWR and drop `error` and `isLoading` on the floor, so a
 * gateway nobody could reach rendered as a catalog with no streams in it. A viewer whose gateway is
 * down and a viewer who is early to an event saw identical pixels, and only one of them could act on
 * what they were seeing.
 *
 * Pure so it can be tested: `packages/client` runs vitest with `environment: 'node'` and no jsdom, so
 * a rule left inside the component is a rule nothing covers.
 */

export type CatalogView =
  /** Streams to show. Stale ones count, which is the point of the ordering below. */
  | 'streams'
  /** The fetch failed and there is nothing to fall back on. */
  | 'unreachable'
  /** First load still in flight. */
  | 'loading'
  /** The gateway answered and there is genuinely nothing on it yet. */
  | 'empty';

export interface CatalogFetchState {
  isLoading: boolean;
  hasError: boolean;
  streamCount: number;
}

/**
 * ⭐ Streams win over an error on purpose. SWR keeps the last successful `data` while a later refresh
 * fails, so a page that shouted about every failed poll would replace a usable catalog with an error
 * every time one refresh in twelve missed. A viewer can still open a stale stream; they can do nothing
 * with an error page. The failure is only worth the whole screen when there is nothing behind it.
 */
export function catalogViewFrom({ isLoading, hasError, streamCount }: CatalogFetchState): CatalogView {
  if (streamCount > 0) {
    return 'streams';
  }
  if (hasError) {
    return 'unreachable';
  }
  return isLoading ? 'loading' : 'empty';
}

/** What each empty-ish view says. Kept beside the rule so a new view cannot ship without its copy. */
export const CATALOG_VIEW_MESSAGE: Record<Exclude<CatalogView, 'streams'>, string> = {
  unreachable: 'Could not reach this gateway. Check the address, or pick another one.',
  loading: 'Looking for streams...',
  empty: 'No streams here yet.',
};
