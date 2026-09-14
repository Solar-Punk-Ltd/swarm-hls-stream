/**
 * Imports the module named in argv and exits, so a parent can ask what importing it costs.
 *
 * It exists because "this module reads nothing it does not need at import time" is a property of a
 * fresh process, not of an expression. A module graph is evaluated once per process, so asking the
 * question in the test's own process would answer it about whatever the first test file happened to
 * import, and a cache-busting query only re-evaluates the module named, never the config module
 * underneath it that is the one doing the reading.
 *
 * Prints nothing on success. A throw goes to stderr with a non-zero exit, which is the parent's
 * whole assertion.
 */
const specifier = process.argv[2];

if (!specifier) {
  console.error('usage: importOnly.ts <module specifier>');
  process.exit(2);
}

await import(specifier);
