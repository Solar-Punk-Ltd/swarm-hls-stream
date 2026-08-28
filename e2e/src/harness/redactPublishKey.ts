/**
 * Taking the publish credential out of anything this harness prints.
 *
 * ⛔ The publish key is live. It is what proves the holder may broadcast as a given stream, and it
 * rides in the ingest URL because a query parameter is the only channel either engine leaves open.
 * So the URL an operator needs to see and the credential nobody may see are one string, and on
 * 2026-08-28 the smoke test's `ingest:` line put one into a transcript. A credential that reaches a
 * transcript is spent, and the repair is not narrow: keys are derived rather than stored, so
 * rotating `PUBLISH_KEY_SECRET` invalidates every stream's key at once rather than only that one.
 *
 * ⛔⛔ SRS AND OME SPELL IT DIFFERENTLY, AND ONLY ONE OF THEM CONTAINS `key=`.
 *
 * SRS carries the key inside the streamid's `r=` value, so it is plain `?key=<hex>,m=publish`. OME
 * takes an entire publish URL as the streamid and that whole URL is percent-encoded, which is the
 * form measured working against real OME, so its credential arrives as `key%3D<hex>`. A redactor
 * written against the plain spelling alone passes every SRS test and leaves an OME run leaking
 * exactly as it was.
 *
 * Sibling, deliberately not imported: `packages/stream-uploader/src/utils/urlSecrets.ts` does the
 * same job for the service's own logs. e2e must not reach past a package boundary into another
 * package's internals, and the two want different output anyway. That one replaces the value whole,
 * because a service log has no reader who needs to tell two requests apart. This one keeps four
 * characters, because an operator reading a run's output does.
 *
 * ⛔ Printing only. The real URL is what gets published, and a caller that redacts on the way to the
 * publisher rather than on the way to the console has broken the run instead of securing it.
 */

/**
 * `key=` or `key%3D`, with the delimiter ahead of it captured so it can be put back.
 *
 * The leading delimiter is matched rather than assumed, so a word merely ending in `key` is left
 * alone: without it `monkey=banana` reads as a credential. `%3F` and `%26` are in the set because in
 * OME's encoded streamid the `?` or `&` in front of the parameter is itself encoded. The value runs
 * to the first character that can end one, which for SRS is the `,` before `m=publish`.
 */
const PUBLISH_KEY_IN_TEXT = /(^|[?&,=/:\s]|%3[Ff]|%26)(key)(=|%3[Dd])([^\s,&#'"]+)/g;

/** Enough to tell two runs apart in a log, and far short of the 128 bits the key is. */
const KEPT_CHARS = 4;

const REDACTED_SUFFIX = '…REDACTED';

/** The same text with every publish key cut down to its first few characters. */
export function redactPublishKey(text: string): string {
  return text.replace(
    PUBLISH_KEY_IN_TEXT,
    (_match, before: string, name: string, equals: string, value: string) =>
      `${before}${name}${equals}${value.slice(0, KEPT_CHARS)}${REDACTED_SUFFIX}`,
  );
}
