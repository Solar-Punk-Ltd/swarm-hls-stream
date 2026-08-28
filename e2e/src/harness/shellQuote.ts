/**
 * Putting a value inside a shell command, once, for everything here that builds one.
 *
 * Every command this harness constructs reaches the deployment host as a single ssh argument, or goes
 * through `bash -c` locally, and is parsed once there. So one level of quoting is the whole
 * requirement, and a single-quoted string is the right level: a shell performs no expansion of any
 * kind inside one.
 *
 * ⛔ There were two of these, privately, in two files whose commands both go to the same `Host.run`.
 * `uploaderState.ts` escaped an embedded quote and `harness/browser.ts` refused one outright, so a
 * third caller had two incompatible precedents to copy from and nothing said which was the house
 * rule. Refusing is the weaker of the two: it is safe, but it turns an odd-looking value into a dead
 * run rather than into a correct command, and a value that a paid sitting was configured with is a
 * bad place to discover a harness opinion.
 *
 * Escaping is safe by construction here rather than by care. A single-quoted shell string has no
 * escape sequence at all, so the only character that can end it is a literal quote, and closing,
 * escaping and reopening is the complete answer to that one character.
 *
 * ⭐ `test/shellQuote.test.ts` round-trips the output through a real `bash` rather than comparing it
 * against the escaping this file would have written, which would only be a test of the code against
 * itself.
 */

/** Wrap a value so one shell parse yields it back unchanged, whatever it contains. */
export function shellQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
