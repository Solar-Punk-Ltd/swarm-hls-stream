/**
 * The five variables `config.ts` demands at import time, seeded before any test file loads.
 *
 * `src/utils/config.ts` builds its `config` object at module scope and five of its fields come from
 * `required()`, which throws on an absent variable. Every engine module imports that config, so a
 * test file that imports an engine reaches it transitively and throws while being imported, before
 * any test body runs. Five files were in exactly that state on a checkout with no `.env` at the
 * repository root, which is every clean checkout: CI has no `.env`, so those five failed on every
 * run there while passing on the laptops that wrote them. A suite that is green only on a machine
 * carrying an untracked file reports nothing about the tree.
 *
 * Seeded here rather than inside each test file because the throw happens at import. Node loads
 * this through `--import` in the package's `test` script, ahead of the test files, and passes it to
 * each of the child processes the test runner spawns.
 *
 * ⛔ These are fixtures, not configuration, and nothing here reaches a real service. Every test that
 * touches a Bee node, a webhook or the API supplies its own fake or its own loopback server, so
 * these values exist only to get the module past its own guard. The address is in the reserved
 * `.invalid` domain so a request that escaped a fake could not resolve anywhere.
 *
 * A variable already set in the real environment is left alone, so a deliberate `VAR=… pnpm test`
 * still decides. A repository `.env` does not: `dotenv` never overrides what is already set, and it
 * runs when `src/utils/env.ts` is first imported, which is after this. That is the point rather than
 * a side effect. The suite reads the same values on a developer's machine and on a clean checkout,
 * so it can no longer pass in one place and fail in the other.
 */
const TEST_ENV: Readonly<Record<string, string>> = {
  BEE_URL: 'http://bee.invalid:1633',
  STAMP: '0'.repeat(64),
  STREAM_KEY: 'test-stream-key',
  STREAM_LIST_TOPIC: 'test-stream-list-topic',
  API_AUTH_TOKEN: 'test-api-auth-token',
};

for (const [name, value] of Object.entries(TEST_ENV)) {
  process.env[name] ??= value;
}
