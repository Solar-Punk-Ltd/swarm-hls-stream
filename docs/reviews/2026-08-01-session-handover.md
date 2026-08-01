# Session handover, 2026-08-01

Written to start the next session cold. Everything below is state as of `feat/ai-hardening` @
`bfa8a51`, working tree clean, `pnpm verify` exit 0.

The two long-lived documents are still the sources of truth and this one does not replace them:

- [`2026-07-29-hardening-audit.md`](2026-07-29-hardening-audit.md) — the findings register and every
  acceptance criterion. **Read the row before implementing it, and check it against source.** Three
  criteria have now been found defective this way (S1.1, S1.6, S1.7); the amendments are recorded
  beside the originals with the originals struck through.
- [`2026-07-29-hardening-handoff.md`](2026-07-29-hardening-handoff.md) — priorities, protocol,
  environment traps, and the progress log. The "Batch 3 recon" and "Batch 3 closed" rows cover this
  session.
- [`review-gate.md`](review-gate.md) — the review every PR passes.

## Where things stand

`feat/ai-hardening` @ `bfa8a51`, **27 PRs merged**. Uploader 484 tests, deploy 20, client 31, cli 40,
gate-facts 49, audit-gate 38. Sprint 2's exit criterion is met. Batch 3 is merged (PR #54) and
`feat/s1-input-hardening` is spent.

Copilot review is **on** since the owner asked for it on 2026-08-01. Request it with:

```
gh api repos/Solar-Punk-Ltd/swarm-hls-stream/pulls/N/requested_reviewers -X POST -f "reviewers[]=copilot-pull-request-reviewer[bot]"
```

It has returned something real on both PRs it has seen. The wide multi-lens gate is no longer
automatic; the owner asked for fan-out plus Copilot.

## What to do next

**TEST-34 first.** It is the only open test-integrity row and it blocks the mutation work behind it.

`OmeHlsPuller.test.ts`, "polls a cold-starting origin at the ordinary interval, then slows once it
stays unusable", and its sibling about deferring a recovery finalize. They count polls inside a
wall-clock grace window and assert the count, so under CPU contention the timers fire late, fewer
polls land, and the assertion reports the load on the machine: `a cold start must keep its ordinary
interval, got 3 polls in the grace`.

Measured on 2026-08-01: **8 failures in 48 runs of that file alone at 16-wide**, and 13 of 36
full-suite runs at 4-wide. It does **not** fire at the concurrency `pnpm test` and CI actually use,
which is why it went unseen. Both the test and `src/engines/ome/OmeHlsPuller.ts` are byte-identical
between batch 3's base (`7ead6e6`) and its head, so it is neither newly introduced nor a product
defect.

The fix has a worked precedent in this repository: TEST-15 had the same shape and was fixed by
**asserting on what was requested rather than on what a wall clock observed**. See the
`applies the environment window to the pullers it starts` test, which now reads the abort window off
the call the puller makes, correlated through a `WeakMap` so other still-running pullers cannot
pollute it. The puller already accepts an injected clock, which is the other route.

**It matters more than one flaky test usually would**: a flaky failure scores as a killed mutant, so
this suite is the mutation gate's multiplicand and every score taken under contention is inflated
until this is closed.

**Then, in order:** the S4 remainder (S4.3 through S4.8, shell scripts, one pull request), then S6,
then S5 last.

**Deferred to one live-engine block at the end, by owner decision:** CON-17, S5.1, S5.2, S6.3, and the
reconnect / crash / Bee-outage e2e run. Mutation triage and test integrity are deferred, not passed.

## Things this session learned that will otherwise be relearned

**A diagnosis written in the register is a hypothesis, not a finding.** TEST-31 carried a written,
plausible, unverified cause: pooled keep-alive sockets meeting a recycled ephemeral port. It was
wrong. Refuting it took two measurements, 3000 isolated listen/fetch/close rounds producing zero
failures and **zero port reuse**, and forcing reuse on a fixed port producing zero in 400. A fix aimed
at it would have looked right, because the real rate was about one in ninety.

The actual cause was found only by instrumenting the failing helper to print the undici `cause` and
the port, then reading the captured data: three failures, every one on **the same port**, which a
desktop application held as `*:57446`. The helpers bound `::` via `app.listen(0)` and dialled
`127.0.0.1`, which are different sockets, so the OS could hand out a port another process already held
on IPv4 and the request went to that process. Its reply is not HTTP, which is the
`HPE_INVALID_CONSTANT` behind the bare `TypeError: fetch failed`.

**Run the mutation before believing a test you just wrote.** Two of this session's own tests asserted
nothing, both written by me, both passing, both reading convincingly:

- S1.5's consequence test checked that a refused `mediatype` never reached the published catalog. A
  stream is announced to the catalog on its **first segment**, not on start, and the test never posted
  one, so it asserted that nothing was published in a state where nothing would be published either
  way.
- S1.7's induction failed the manifest upload, whose error the uploader wraps in a message carrying
  only the caller's own stream id. All four disclosure assertions passed **against unfixed code**. The
  unwrapped path is `streamCatalog.addStream` at the end of `finalize`.

The tests that demonstrate the _consequence_ rather than the _mechanism_ are the ones to distrust.

**Never run a verification hunt while editing the tree.** It cost two runs this session, one reporting
28 failures of 52 and another 36 of 100, both of them half-applied imports being read mid-edit. Finish
and commit first, or run the hunt against a `git worktree` pinned to a commit.

**Classify hunt failures by failing test name, never by grepping the whole log.** The final
verification classifier matched `fetch failed` anywhere in the output and fired on an ordinary
`[OME] Segment 3 fetch failed: HTTP 404` warning, reporting a recurrence that had not happened.

**A test can encode the machine it was written on.** The TEST-31 regression test reconstructs the
hazard with a squatter on the IPv4 wildcard, which needs an OS that lets an IPv6 bind coexist with an
IPv4 one on a port. macOS allows it; Linux refuses with `EADDRINUSE`, so CI failed on the new test on
its first run. It now reports an absent hazard as **skipped**, detected by attempting the bind rather
than by reading `process.platform`.

## Traps that are still live

- **Typecheck with `tsconfig.test.json`, not `tsconfig.json`.** The latter does not cover `test/`, and
  its `lib` is older: `Error.cause` is an error there and compiles fine in the other.
- **Bash cwd drifts between calls.** Use absolute paths, or `cd` in the same command.
- **`status` is read-only in zsh.** Assigning to it aborts a script that can still exit 0. Any hunt
  script needs `set -eu` plus a round counter asserted at the end, or it reports success having
  checked nothing.
- **A test double cast through `as unknown as` is a compile error nowhere.** Sixth occurrence is
  recorded as TEST-33. Prefer `makeTestOrchestrator`; reach for `makeFakeOrchestrator` only when the
  test is about what the caller does with the answer.
- **Never name files on a `tsc` command line**, and never leave `test/*.test.ts` unquoted.
- **On-chain actions are the owner's.** Never buy, extend or top up a postage stamp, testnet included.
- **`clean.sh` destroys the containers and data of a live stack.** Never run it casually.

## Verification recipes used this session

Kept because they are the instruments, and each was wrong the first time.

```bash
# Full suite once
cd packages/stream-uploader && npx tsx --test --test-force-exit "test/*.test.ts"

# Hunt a rare intermittent: N batches of W concurrent runs of one file
# (finding an unknown fault; the wrong instrument for reporting a rate)

# Report a rate: sequential full-suite runs, classified by failing test name
# (the baseline these compare against was measured the same way)
```

Both scripts are throwaway. What matters is that a hunt **finds** and a sequential run **measures**,
and that neither runs while the tree is being edited.
