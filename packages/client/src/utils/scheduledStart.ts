/**
 * When an announced broadcast says it will begin, written for whoever is reading the page.
 *
 * Shared by the browse card and the watch page rather than formatted at each, because the two would
 * otherwise disagree about what an unusable value means — and this one is external input: the
 * catalog is JSON off a feed, parsed unchecked, and `scheduledStartTime` is explicitly `null` on an
 * entry whose time is not fixed yet.
 */

/**
 * ⭐ The browser's own locale and time zone, never a format chosen here. A viewer reads a start time
 * to decide whether to come back, which they can only do in their own clock; a fixed format would be
 * both wrong for most readers and a second place for the offset to be lost.
 *
 * A number is accepted alongside the ISO string the admin layer writes because the entry beside it
 * (`timestamp`) is epoch milliseconds, so a publisher sending the same shape here is a mistake worth
 * rendering rather than dropping.
 *
 * Null for anything that is not a time — absent, null, empty, or unparseable — so a caller has one
 * thing to check and no card ever renders the words "Invalid Date".
 */
export function scheduledStartLabel(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? null : when.toLocaleString();
}
