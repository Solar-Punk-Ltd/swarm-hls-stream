# Mutating `packages/shared`, and the limit the workspace puts on it

First mutation run against `packages/shared`, 2026-08-10. **76.00%**, 206 killed, 3 timed out, 66
survived, 275 mutants over 9 files in 24m45s at concurrency 2.

| file                |    score | survivors |
| ------------------- | -------: | --------: |
| `hlsTags.ts`        |   100.00 |         0 |
| `segmentSpan.ts`    |    95.65 |         2 |
| `manifest.ts`       |    88.24 |         8 |
| `mpegTs.ts`         |    73.83 |        28 |
| `feedFollow.ts`     |    46.43 |        15 |
| **`publishKey.ts`** | **0.00** |    **13** |

## ⛔ Read `publishKey.ts` at 0.00% correctly. It is not untested.

`derivePublishKey` is the HMAC that mints the credential authorising a publish, so a zero here reads
as alarming. It is measuring the harness, not the function.

The function **is** pinned, by a golden vector in `packages/stream-uploader/test/publishKey.test.ts`,
which asserts two fixed `streamId` to key pairs computed on 2026-08-03. That test runs in this
harness. It still kills nothing, and the reason is structural:

**Stryker's sandbox symlinks `node_modules` back to the real tree.** In a pnpm workspace
`node_modules/@swarm-hls-stream/shared` therefore points at the real `packages/shared`, not at the
sandbox's mutated copy. The uploader's test reaches the function as
`import ... from '@swarm-hls-stream/shared/publishKey'`, so it executes the **unmutated** original
while Stryker mutates a copy nothing imports.

⭐⭐ **So a mutant in `packages/shared` is only visible to a test that imports it by relative path.**
`packages/shared/test/*.test.ts` do exactly that (`../src/manifest.js`), which is why the other five
files score at all. Every consumer in another package reaches it by package name and is blind to the
mutation.

**The consequence to carry:** this score measures how well `packages/shared` tests itself, and says
nothing about how well its consumers pin it. A file used only through the package name will report
0.00% however thoroughly it is tested elsewhere. Do not chase such a number with more tests in the
consumer, because no test written there can ever move it.

Adding `deploy/test/publishKey.test.js` to the runner was tried and reverted. It does not help, for a
second reason worth knowing on its own: **that file never calls the TypeScript function.** It defines
a local `derivePublishKey` that shells out to `deploy/scripts/_lib.sh`, so it pins the **bash**
implementation against the golden vector. Two implementations, one vector, and the source comment in
`packages/shared/src/publishKey.ts` describing it as pinning "the same golden vector this package's
tests use" is loose: this package has no publish-key test of its own.

## What is worth doing

1. **`feedFollow.ts` at 46.43%, 15 survivors, is the real gap** and the one to mine next. It is feed
   following, which both ends depend on.
2. **`mpegTs.ts`'s 28 survivors** matter more than the score suggests. This is the packet parsing
   behind the recording that opened with four segments carrying no video packets.
3. **A relative-import test for `publishKey.ts` inside `packages/shared/test/`** would make the
   function measurable at all. The golden vector already exists to copy.
4. Leave the two `segmentSpan.ts` survivors. Both are `StringLiteral` mutants on explanatory text
   inside a report.
