# Hardening implementation handoff

Entry point for whoever picks up this work, human or a fresh AI session. Branch `feat/ai-hardening`,
branched from `feature/uploader-hardening` at `f146588`.

The companion document [`2026-07-29-hardening-audit.md`](./2026-07-29-hardening-audit.md) holds the
findings register and the acceptance criteria. This document holds the ordering, the protocol, and the
traps. Read both before touching code.

## Kickoff prompt

Paste this to start a session:

```
You are picking up the hardening work on the swarm-hls-stream repo, branch feat/ai-hardening.

Read these three files IN FULL before doing anything else:
  docs/reviews/2026-07-29-hardening-audit.md      (findings register + acceptance criteria)
  docs/reviews/2026-07-29-hardening-handoff.md    (priorities, protocol, environment traps)
  docs/reviews/review-gate.md                     (the review every PR must pass)

The audit is already done. Do NOT re-audit the codebase and do NOT re-derive findings. The
register is your input. Its "Rejected findings" section lists every claim that was investigated and
disproved, across the original audit and each review-gate round since, so do not re-raise any of them.
Read all of its tables, not only the first.

Pick up from the progress log at the bottom of the handoff. Follow the working protocol exactly,
including the review gate on every PR and the re-audit step at the end of each sprint. A task is
done when its acceptance criterion passes as a test, not when the code looks right.

Before your first commit, confirm you are on feat/ai-hardening and that HEAD matches what the
progress log says. Ask me before pushing anything to a shared branch.
```

## Next session starts here

Written 2026-07-30. That session ran S0.7, S2.1, SEC-11, TEST-9, a dead-code sweep, and S0.5 plus S0.6,
landing three pull requests each through its own review gate. Read this before the sprint plan below,
because it supersedes anything in this document that contradicts it.

**Where the code is.** `feat/ai-hardening`, at `8d50e1b` plus the handover commits that carry this paragraph, so the tip is a docs commit or two ahead of that sha by construction. The progress-log rows below are the shas to trust. Six PRs merged, each through the review gate:
S1.4 as #27, S1.3 as #28, the working-loop changes as #29, S0.7 + S2.1 + SEC-11 + TEST-9 as #30, the dead-code sweep as #31, and S0.5 + S0.6 as #32.
`feature/uploader-hardening` @ `f146588` and `main` @ `6b82baa` are untouched and must stay that way.

**Nothing is open.** #31 (cleanup) and #32 (the S0.5 and S0.6 seams) both merged after their own gates,
three lenses and four respectively, selected by surface.

Test baseline is **142 uploader, 5 client**, with lint, typecheck and whole-tree prettier all clean.
Check all four with one command: **`pnpm verify`**. It short-circuits at the first failing stage, so a
lint error hides later test results, where CI runs the four as independent jobs and reports all of
them. Do not let any of it regress. Typecheck now covers `test/` as well, see TEST-9.

**Next task: S2.2**, timeouts on all four `fetch` call sites. Both prerequisites are done, so it is
unblocked. S0.6 gives the puller an injectable fetcher and S0.5 gives the orchestrator an injectable clock,
which is what makes an abort window steppable rather than waited out.

**Start S2.2 by strengthening one test, and do not trust the previous version of this paragraph.** It
claimed `OmeHlsPuller.test.ts` already held a tripwire whose load-bearing line was
`assert.deepEqual(inits, [undefined])`, and that flipping it was S2.2's first move. **That test was never
written.** `git log --all -S'inits'` on the file returns nothing, so the strengthening was described as
done when it had only been decided on.

What is actually there is `"blocks the tick while a fetch hangs, which is the gap S2.2 closes"`, asserting
that `puller.tick()` has not settled after 80ms. That is the weak form, and it is worse than weak here:
its fake fetcher is `() => new Promise(() => {})`, which ignores any `AbortSignal` it is handed, so the
tick will never settle no matter what timeout S2.2 adds and the test stays green forever.

S2.2's acceptance criterion is behavioural rather than shape-based, so satisfy that instead: a hanging
fetch aborts within the configured window, the abort is logged as an error, and the next tick still runs.
That needs a fake fetcher that **honours** the signal, rejecting when it aborts, which is the seam S0.6
provides.

Then S1.1 and S4.1. Sprint 0 still has S0.3 and S0.4 open, and S0.4's FakeBee is largely built already in
`test/helpers/fakes.ts`, which offers per-call upload control, immediate rejection with a non-retryable
status, and a never-settling response.

**The clock seam stops at the orchestrator.** `OmeHlsPuller` still schedules its own polls with a raw
`setTimeout` and `retryUntilDeadlineAsync` still sleeps for real, so the suite is not free of real waiting.
S2.3's backoff will want the puller's.

**The one thing to take from the #30 gate before writing any more of Sprint 2.** The change that closed
OBS-1 was substantially wrong when it was first pushed, and every fix came from the gate rather than from
the author. The CRITICAL is the lesson: three signals were added, and the most likely real failure, a
refused segment upload on a spent postage batch, was invisible to all three at once. When you add a
signal, enumerate the failure modes it is supposed to catch and check each one reaches it, because
"`/health` degrades" is not the same claim as "`/health` degrades when this breaks". Two of the ten fixes
were against commits written an hour earlier in the same session.

**S0.5 is now the binding constraint on Sprint 2.** Nothing can advance a clock or a timer, which is
why S2.1's manifest-failure threshold is proven by feeding one segment at a time and waiting for the
counter rather than by stepping time. Every remaining Sprint 2 task with a timing element wants it.

**SEC-11 is closed.** The owner chose the empty sample value on 2026-07-30, so a fresh OME deploy now
stops at a named startup error rather than running the `change-me` secret published in this
repository. The rejected alternative was generating a secret in `setup.sh`, an OPS change to a script
that touches live deployments.

**Three working-loop changes landed in PR #29.** A committed `.claude/settings.json` that disables the
GateGuard edit-write fact hook **for everyone who clones this repo**, the `.gitignore` rule that
closes TEST-10, and the `pnpm verify` script. The hook scope and the script are documented in
README's Development section, which is where a contributor will look.

That merge is the first **merge commit** in this branch's history, because the handover commit had
already landed on `feat/ai-hardening` and rebasing would have rewritten `a19edd6`, which the gate
result and the pull request body both cite by sha. Every earlier task branch fast-forwarded. Expect a
fast-forward again unless the same thing happens, and prefer preserving a reviewed sha over a linear
history when the two conflict.

**Lens selection is in the protocol now, not just in these notes.** The owner's rule of 2026-07-30 is to
select the lenses the diff in front of you needs, run those, name the ones you dropped, and save the full
catalogue for a sprint-exit deep run. [`review-gate.md`](./review-gate.md) carries it as of PR #33: R1's
floor of three reviewers plus the claims auditor is **withdrawn**, R4 requires both lists in the posted
result, and fail-closed keys on a selected lens that did not run rather than on a count. The gate's "Lens
prompt rules" section now holds ten rules: seven moved out of this section, two were promoted from the
traps list below it, and one is new. An eighth rule from this section, "four lenses not five on small
diffs", was deleted rather than moved, because the selection rule supersedes it. Read the gate document
for the procedure rather than this paragraph.

What is worth keeping here is why the rule exists. The same fleet was running on a 13-line config diff as
on a four-task logic change, and #30 showed that the way to need fewer lenses is a tighter pull request
rather than a shorter list on a broad one. The claims auditor is never dropped.

**Traps found the hard way this session.**

- Both lens-agent traps found this session are now prompt rules in `review-gate.md`: worktrees created
  inside the repo, one of them holding `feat/ai-hardening` checked out and blocking a merge, and a `tsc`
  run that named files on the command line, silently ignoring `tsconfig.json` and emitting 15 `.js` files
  beside the sources. Two author-side habits survive them. Run `git worktree list` before a merge rather
  than after it fails, and stage explicit paths while lenses are running, because a `git add -A` swept one
  lens's leftover probe directory into a commit.
- `engines/ome/.env` **cannot** fix a failing OME container. `Dockerfile.uploader` copies only
  `package.json` and `dist/`, so the file is not in the image, and dotenv does not override an
  already-present empty value. The deploy `.env` is the only lever.
- Test files are outside `tsconfig.json`'s `include`, so `pnpm typecheck` never reads them (TEST-9).
  Typecheck a new test file explicitly.

**Still blocked, unchanged.** The bee-uploader node has zero postage stamps and buying one is an
on-chain action only the owner can perform. The deployed uploader is stale and updating it needs
`pnpm build` followed by an operator `scp`. The QA stress test is deferred to the very end by owner
decision, which keeps PR #10 and the `streaming-infra-manager` branch held for the duration.

## Branch model

Three levels, and the middle one is the point. Do not commit code straight to the integration
branch, which is the mistake that produced this section.

| Branch                                   | Role                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `feature/uploader-hardening` @ `f146588` | **Frozen reference.** The version the owner wants preserved as-is. Never commit here.           |
| `feat/ai-hardening`                      | **Integration branch.** Carries the plan documents. All hardening PRs target this.              |
| `feat/<task>` off `feat/ai-hardening`    | **One task branch per unit of work.** PR back into `feat/ai-hardening`, review gate on that PR. |

So the loop per unit of work is: branch off `feat/ai-hardening`, commit there one fix per commit, PR
into `feat/ai-hardening`, run the review gate on that PR, merge. Never straight onto the integration
branch, because that skips the PR and therefore skips the review entirely.

**Consequence worth knowing:** the plan documents live on `feat/ai-hardening`, but progress-log
entries arrive with the task PR that produced them. If you read the handoff on `feat/ai-hardening`
and the progress log looks empty, check for open PRs into it before concluding nothing has been done.

### Surrounding state

- `feature/uploader-hardening` @ `f146588` holds merged PRs #10 and #23.
- Sibling infra repo `streaming-infra-manager` on `feature/e2e-suite` at `356bc9e`, submodule pinned
  to `f146588`.
- Both of those are **held pending QA stress-test numbers** per nandibaa's review of PR #10.
- Test baseline at `f146588`: 67/67 uploader, 5/5 client, typecheck clean, eslint clean on uploader
  and client. Do not let these regress.

### Copilot is unavailable, the gate it filled is not

The organization's Copilot review quota is exhausted for the month, so there is no automated outside
reviewer. That also explains the earlier symptom on PR #24, where the REST call returned HTTP 200 with
`requested_reviewers: []`, GitHub having accepted the request and silently discarded it, and
`gh pr edit --add-reviewer` failed to resolve the login under either
`copilot-pull-request-reviewer[bot]` or `Copilot`. It was not a wrong command.

**The replacement is [`review-gate.md`](./review-gate.md), and it is required on every PR.** If quota
returns, run Copilot as an additional lens rather than a substitute for the gate, because the gate now
checks things Copilot never did.

## Read this before you plan anything

**The repo had no CI, and now it does.** S0.1 added `.github/workflows/ci.yml`, running typecheck,
lint and test on Node 22, plus a prettier check across the whole tree. Before that a prettier violation
shipped inside PR #10 and nobody noticed. Treat CI as the floor now rather than a manual step, and note
that it caught a real latent break on its very first run.

**About half the acceptance criteria are currently unwritable.** There is no way to make Bee return a
402, no way to advance the clock for the 60-second recovery timer or the 5-minute drain timeout, no way
to substitute `fetch` inside `OmeHlsPuller`, and no HTTP-level test layer. That is why Sprint 0 is
first and is not optional. Skipping it turns the re-check loop into re-reading diffs.

**The health check reports a problem now, as of S2.1.** `api/routes/health.ts` used to hardcode
`status: 'ok'` while the e2e suite and the smoke test both gated on it, so a silently dead uploader
passed. It now answers 503 with a `reasons` array when a signal degrades. Two consequences for the
e2e suite in `streaming-infra-manager`: a scenario asserting a 200 on `/health` will now fail when the
uploader is genuinely degraded, which is the point, and any client that throws on a non-2xx needs to
read the body instead. Scenario F's `activeStreams >= 1` check is unaffected, since every previous
body key is still there.

## P0 shortlist

If you do nothing else, do these seven. About four days. Closes every exploitable CRITICAL and makes
the QA numbers mean something.

| Order | ID   | Task                                                                       |
| ----- | ---- | -------------------------------------------------------------------------- |
| 1     | S1.4 | Contain the SRS media path, absolute and `../` both rejected               |
| 2     | S1.3 | `OME_ADMISSION_SECRET` required, empty secret rejects instead of accepting |
| 3     | S0.1 | CI workflow: typecheck, lint, prettier, test                               |
| 4     | S2.1 | `/health` status derived from the signals it already computes              |
| 5     | S2.2 | Timeouts on all four `fetch` call sites                                    |
| 6     | S1.1 | Auth middleware on all control and ingest routes                           |
| 7     | S4.1 | Persist the stamp batch id before the on-chain spend                       |

S1.4 and S1.3 are first because they are one-file changes that close unauthenticated arbitrary file
deletion and open ingest respectively. S0.1 comes third so everything after it is guarded.

## Full task list

48 tasks. Priority: P0 do first, P1 silent wrong behaviour in the live path, P2 degraded or friction,
P3 polish. Effort: S under 2h, M about half a day. Acceptance criteria for each are in the audit
document under the matching sprint heading.

### Sprint 0, make verification possible

Implementation order matters here. S0.2 must land before S0.1, otherwise CI is red the moment it is
introduced, because root `pnpm lint` currently fails on `packages/cli`.

| ID   | Task                                                        | Fixes          | Pri | Eff |
| ---- | ----------------------------------------------------------- | -------------- | --- | --- |
| S0.2 | eslint config for `packages/cli`                            | —              | P2  | S   |
| S0.8 | Fix the README quickstart, all three commands are wrong     | DOC-1          | P1  | S   |
| S0.1 | CI workflow: typecheck, lint, prettier, test on push and PR | gates all      | P0  | M   |
| S0.3 | Coverage via c8, record the real baseline                   | TEST-5         | P2  | S   |
| S0.6 | Injectable `Fetcher` in `OmeHlsPuller`                      | ARCH-2         | P0  | S   |
| S0.4 | `FakeBee` double: 402, 503, network throw, call log         | TEST-1         | P0  | M   |
| S0.5 | Injectable clock and timers                                 | TEST-4, TEST-6 | P0  | M   |
| S0.7 | API test layer over the express app                         | TEST-2         | P0  | M   |

### Sprint 1, close the funds-drain and destruction surface

| ID   | Task                                              | Fixes | Pri | Eff |
| ---- | ------------------------------------------------- | ----- | --- | --- |
| S1.4 | Contain the SRS media path                        | SEC-2 | P0  | S   |
| S1.3 | `OME_ADMISSION_SECRET` required, empty rejects    | SEC-3 | P0  | S   |
| S1.1 | Auth middleware on control and ingest routes      | SEC-1 | P0  | M   |
| S1.2 | SRS webhook signature verification                | SEC-1 | P0  | M   |
| S1.5 | Zod schemas, `mediatype` enum, `streamId` charset | SEC-4 | P1  | M   |
| S1.6 | Rate limits, per-stream quota, body ceiling       | SEC-5 | P1  | M   |
| S1.7 | Stop echoing internals in error responses         | SEC-6 | P2  | S   |

### Sprint 2, make failure loud

| ID   | Task                                                          | Fixes        | Pri | Eff |
| ---- | ------------------------------------------------------------- | ------------ | --- | --- |
| S2.1 | `/health` status derived from real signals                    | OBS-1        | P0  | S   |
| S2.2 | Timeouts on all four `fetch` call sites                       | OBS-2        | P0  | S   |
| S2.3 | Puller backoff plus a halt threshold                          | OBS-6        | P1  | M   |
| S2.4 | Surface `notifyStart` failure, stop per-segment catalog retry | CON-3        | P1  | M   |
| S2.5 | `/stream/stop` reports the real drain outcome                 | OBS-3        | P1  | M   |
| S2.6 | Persist and catalog-index failures mark the stream degraded   | OBS-4, OBS-5 | P2  | S   |
| S2.7 | Metrics counters and a `/metrics` route                       | OBS-7        | P2  | M   |

### Sprint 3, concurrency and lifecycle

| ID   | Task                                                                      | Fixes        | Pri | Eff |
| ---- | ------------------------------------------------------------------------- | ------------ | --- | --- |
| S3.1 | Atomic stream registration                                                | CON-1        | P1  | S   |
| S3.2 | Sequence the re-announce, do not spawn when the stop failed               | CON-2        | P1  | S   |
| S3.3 | Reject segments for a draining stream with a distinct reason              | CON-6        | P1  | S   |
| S3.4 | OME: await `stopStream` before removing the puller, clear stale on resume | CON-4, CON-5 | P1  | M   |
| S3.5 | Keepalive so a transient OME outage does not VOD a live stream            | CON-10       | P1  | M   |
| S3.6 | Bound `processedSegments` to a rolling window                             | CON-8        | P2  | S   |
| S3.7 | Playlist parse hardening                                                  | CON-7, CON-9 | P2  | M   |

### Sprint 4, operator safety

| ID   | Task                                                                | Fixes        | Pri | Eff |
| ---- | ------------------------------------------------------------------- | ------------ | --- | --- |
| S4.1 | Persist the batch id before the spend, echo on every failure path   | OPS-1        | P0  | M   |
| S4.2 | Confine the `clean.sh` straggler sweep to the service filter        | OPS-2        | P0  | M   |
| S4.3 | `stop.sh` honors its service arguments                              | OPS-3        | P1  | S   |
| S4.4 | Unknown `--profile` fails loudly                                    | OPS-4        | P1  | S   |
| S4.5 | Replace `eval` in `load_env`                                        | OPS-6        | P1  | M   |
| S4.6 | Balance sufficiency, plus cost and TTL confirmation before spending | OPS-5, OPS-7 | P1  | M   |
| S4.7 | Surface `config.json` parse failure                                 | OPS-8        | P2  | S   |
| S4.8 | `shellcheck` in CI                                                  | —            | P2  | S   |

### Sprint 5, latency and quality

S5.1 first. Nothing else in this sprint is provable without a baseline.

| ID   | Task                                                           | Fixes | Pri | Eff |
| ---- | -------------------------------------------------------------- | ----- | --- | --- |
| S5.1 | Glass-to-glass latency instrumentation, establish the baseline | LAT-1 | P1  | M   |
| S5.2 | Retune hls.js live params and add catch-up                     | LAT-2 | P1  | S   |
| S5.3 | Client manifest poll backoff plus a visible retrying state     | LAT-3 | P1  | M   |
| S5.4 | Validate manifest responses before parsing                     | LAT-4 | P2  | S   |
| S5.5 | Cut QoE overlay render cost                                    | LAT-5 | P2  | S   |
| S5.6 | Abort pending thumbnail work before revoking the blob URL      | LAT-6 | P2  | S   |

### Sprint 6, structure, docs, spike

| ID   | Task                                                                   | Fixes          | Pri | Eff |
| ---- | ---------------------------------------------------------------------- | -------------- | --- | --- |
| S6.1 | Shared package for types and HLS tags, plus a manifest round-trip test | ARCH-1, TEST-3 | P1  | M   |
| S6.2 | Explicit stream lifecycle state                                        | ARCH-3         | P2  | M   |
| S6.3 | bee-js spike, evidence only, ships nothing                             | —              | P2  | M   |
| S6.4 | Docs corrections DOC-2 through DOC-6                                   | DOC-2..6       | P2  | S   |
| S6.5 | Logger levels and structured output                                    | ARCH-4         | P3  | S   |

**Droppable if you need this shorter:** S6.5 is P3. S2.7 and S6.2 are real but block nothing.

## Working protocol

Per task:

1. **Implement.** One fix per commit, conventional subject (`feat:`, `fix:`, `refactor:`, `test:`,
   `docs:`, `chore:`, `ci:`, `perf:`).
2. **PR.** Group related tasks into one PR with several commits rather than opening 48 PRs. Sprint 1's
   S1.1 through S1.3 are one auth PR. Keep the grouping tight enough that a review finding maps to
   one change. Expect roughly 18 to 22 PRs total.
3. **Review gate, required on every PR.** The full protocol is
   [`review-gate.md`](./review-gate.md), which replaces the Copilot gate now that quota is gone. In
   short: the claims auditor plus the lenses that this diff's surfaces call for, selected and posted as
   a PR comment before anything is launched. None of the code lenses gets the PR description or the
   author's reasoning. The claims auditor gets the description and only the description, because that is
   what it is auditing. Then a verification pass in which every finding defaults to refuted until it
   reduces to a specific input and a specific wrong outcome. Fix the confirmed ones
   as separate commits, rebut the rest with evidence, post the result on the PR, and append the
   refutations to the register. Prior rounds produced both genuine bugs and confidently wrong claims,
   so neither blanket acceptance nor blanket dismissal is correct.
4. **CI green**, coverage not below the recorded baseline.
5. **Re-audit the touched domain** at the end of each sprint. Re-run that domain's audit against the
   new HEAD with the register attached, asking two questions: is each claimed-closed finding actually
   closed, and did the fix introduce anything new. A fix that closes its own finding but adds a HIGH
   does not pass.
6. **Close on evidence.** A finding closes when its acceptance test exists and passes.

Sprint exit gate, all five required: every acceptance test in the sprint passes, the re-audit reports no
new CRITICAL or HIGH in the touched files, **the full lens catalogue has had its deep run**, no
review-gate finding is left unaddressed or unrebutted, and CI is green.

The deep run is the other half of per-PR lens selection. Selecting narrowly during a sprint is only safe
if breadth arrives somewhere, and sprint exit is where it arrives, because that is when a fix in one
domain is most likely to have quietly broken another.

## Environment traps that will waste your time

- **This repo is a git submodule** of `streaming-infra-manager` at `manager/swarm-hls-stream`, and
  that repo's `.gitmodules` currently tracks `branch = feature/uploader-hardening`, **not**
  `feat/ai-hardening`. The e2e suite will not see work on this branch until you either merge back to
  `feature/uploader-hardening` or repoint the submodule. Decide deliberately, do not let it surprise
  you at test time.
- **Root `pnpm lint` always fails** on `packages/cli` with "No files matching the pattern". That
  package has no eslint config. Pre-existing, fixed by S0.2. Until then run per-package
  `npx eslint .`.
- **Per-package typecheck:** use `npx tsc --noEmit` inside each package. The workspace-level script
  can trip a pnpm version gate.
- **Test runners differ:** uploader uses `tsx --test`, client uses `vitest run`.
- **`| tee` masks pnpm exit codes.** Read the `# pass` and `# fail` tally lines instead of trusting
  the exit status.
- A **prettier hook reformats markdown** on write, so tables get column-padded after you save. Expect
  your Edit strings to need the padded form on a second pass.
- **On-chain actions are the user's, not yours.** Buying or topping up a postage stamp spends BZZ.
  Never do it, always hand it back.
- **The bee-uploader node currently has zero stamps** (`/stamps` returns `{"stamps":[]}`), so nothing
  live can run until the user buys one.
- **The deployed uploader is stale** by two candidates. A live run needs a local `pnpm build`, then a
  user-performed `scp`, then `deploy-uploader` from the manager.
- **Never run the deploy or clean scripts casually.** `clean.sh` destroys containers and data of a
  live stack, and OPS-2 means it over-reaches beyond the service you name.
- `gh pr merge` is blocked in this environment. Merge locally with git and push, GitHub marks the PR
  merged once its head lands on the base.
- `git merge -F -` does not read stdin, unlike `git commit -F -`. Write the message to a file or use
  repeated `-m`.

## House rules

From the repo owner's standing configuration. These are not suggestions.

- **No `Co-Authored-By:` footers** on commits.
- **No "Generated with Claude Code" footers** in PR descriptions, PR comments, or issue comments.
- **One fix per commit.** Addressing three review comments means three commits.
- Conventional commit subjects.
- **No em-dashes and no semicolons in prose.** Applies to commit bodies, PR text, docs, and comments.
  Code is exempt, semicolons are syntax there. Hyphens and minus signs are fine.
- Comments supply missing context, they do not narrate. If a comment explains a name, fix the name.
- Shapes described in prose belong in a named type.
- Shared shapes live once, which is what S6.1 is about.
- Immutability, return new objects rather than mutating.
- Repeated string literals become named constants.

## Decided: QA runs last

**The repo owner decided on 2026-07-29 that the QA stress test happens at the very end, after all the
hardening work is finished.** Do not run it earlier and do not treat any earlier measurement as the
QA number.

This is the safest option on the measurement question. `/health` cannot currently report a problem and
four `fetch` calls have no timeout, so a number taken today cannot distinguish a healthy uploader from
a silently dead one. Running QA after S2.1 and S2.2 was the minimum for the figures to mean anything,
and running it after everything is strictly better than that.

Two consequences to carry, neither of them blockers:

- **PR #10 and the `streaming-infra-manager` branch stay held for the duration**, since nandibaa's
  review gated them on QA numbers. That is a long hold now. Say so when it comes up rather than
  letting people assume the hold is short.
- **Nothing establishes a latency baseline until then either.** S5.1 exists to instrument
  glass-to-glass latency and the rest of Sprint 5 is unprovable without it, so S5.1 still runs inside
  Sprint 5 rather than waiting for the QA pass. The two are separate measurements and only the stress
  test is deferred.

## What not to do

- Do not re-audit. The register is the input, and re-deriving it burns days.
- Do not re-raise any of the nine rejected findings. They were each investigated and disproved, with
  the reason recorded in the audit document.
- Do not treat the current 67/67 and 11/11 as proof of correctness. The audit explains why parts of
  that green are unearned.
- Do not widen scope. If you find something new, add it to the register with evidence rather than
  fixing it inside an unrelated PR.

## Progress log

Append one line per completed task, newest last. This is the resume point for a fresh session, so keep
it accurate and keep it in the same commit as the work it describes.

| Task                  | Commit                                                                                 | Date       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —                     | `f146588`                                                                              | 2026-07-29 | Branch point. Audit and handoff docs only, zero code changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| SEC-7 added           | `f0d19f3`                                                                              | 2026-07-29 | New register row. GitHub reports 60 open Dependabot alerts, axios 21 of them at runtime scope through bee-js. The audit had inferred "no known vulnerabilities" from package.json without checking advisories. Promotes the bee-js work in S6.3 from optional spike to remediation path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **S0.2 done**         | `b1d37e9`, `64f7ffa`                                                                   | 2026-07-29 | eslint config added to `packages/cli`, mirroring stream-uploader minus the jest env. Root `pnpm lint` now exits 0, previously always 1. The config surfaced 9 pre-existing violations across 6 files (curly, one import-sort), all autofixed in the second commit. `tsc --noEmit` clean.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **S0.8 done**         | `96b3e57`                                                                              | 2026-07-29 | README quickstart fixed. `pnpm dev`, `pnpm start:uploader`, `pnpm srs:up` did not exist. Now `client:start`, `uploader:start`, `srs:host`, plus `ome:host` since the block only ever named SRS. Verified by asserting every `pnpm X` in the block resolves to a real script or a pnpm builtin. Closes DOC-1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **S0.1 done**         | `db06455`, `6f84776`                                                                   | 2026-07-29 | CI workflow added, **verified green on a real run** (node 20 and 22). Runs typecheck, lint, test. Formatting is gated on changed files only, see the note below. Its first run immediately caught a latent bug: the uploader test glob never worked on node 20, fixed in `6f84776`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Review gate**       | `7341363`, `1bc5cb3`                                                                   | 2026-07-29 | Copilot quota ran out for the month, so the gate it filled was rebuilt in-house as [`review-gate.md`](./review-gate.md). Five independent lenses ran against PR #24, then a verification pass in which every finding defaulted to refuted. Five claims refuted with disproofs recorded, three confirmed and fixed, four real out-of-scope findings added to the register as SEC-8, SEC-9, TEST-7, TEST-8.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Gate fixes on #24** | `0c151c1`, `c7e6014`, `81d0a7d`, `e094fe1`                                             | 2026-07-29 | What the gate confirmed. Explicit read-only `permissions` on the workflow. NUL-delimited changed-file list, since bare `xargs` split paths on whitespace. Prettier's own `--ignore-unknown` in place of a hand-written extension allowlist that omitted `html` and so never gated `packages/client/index.html`. `packages/cli` now declares the eslint toolchain it lints with, instead of relying on siblings to declare it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Node baseline 22**  | `af390bc`, `55b35eb`                                                                   | 2026-07-29 | Owner decision. Nine declarations moved from 20 to 22 and the CI matrix dropped to a single entry, since `engines.node`, the deploy images and the tooling now agree. Images take effect on the next deploy only. Node 22 is in maintenance and 24 is the current active LTS, so 24 is a real follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Prettier sweep**    | `7f41d02`, `80c8fb8`, `da26850`                                                        | 2026-07-29 | Owner decision. All 28 files formatted, CI widened from changed-files to the whole tree on push and PR. Semantic equivalence proven by diffing `tsc` emit before and after: 12 differing lines, all `arrowParens`, byte-identical once normalized. Widening also deleted both `${{ github.base_ref }}` interpolations, **closing SEC-9**. `.git-blame-ignore-revs` added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **S1.4 done**         | `8299bd1`                                                                              | 2026-07-30 | **Closes SEC-2.** `resolveSegmentPath` compares the resolved path against the resolved media root, so an escaping path returns before any `fs` call. First test for the SRS engine, 11 cases, uploader suite 67 to 78. Proven by neutering the containment and confirming 8 of the 11 fail, which is the only thing that shows the assertions have teeth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **S1.3 done**         | `dba3f94`, `3bcf889`                                                                   | 2026-07-30 | **Closes SEC-3.** An empty admission secret now rejects instead of admitting, and `createOmeEngineFromEnv` uses `required`, so an `ENGINE=ome` deployment without a secret fails at startup. Deleting the early return alone would not have been enough: the empty string is a usable HMAC key, so a caller who knows the secret is empty can sign with it and pass. Tests written first, 6 of 12 failing before the change. Uploader suite 79 to 91. Left open as **SEC-11**: `setup.sh` copies the sample, so the published `change-me` becomes the live secret on a fresh OME deploy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Gate on #28**       | `c97efd3`                                                                              | 2026-07-30 | Five lenses: claims audit, security, correctness, test integrity, config consistency. Config consistency replaced silent failure, since the change is a configuration contract. All 17 claims verified TRUE, though one was TRUE on insufficient evidence and was reworded. Four refutations, and one confirmed finding fixed: `required` said "missing" for a variable compose had set to empty. Lenses were given a neutral orientation brief for the first time, which cut the test lens by 20% on tokens and 38% on time but cost the security lens 19% more tokens, so it is not a uniform win.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Gate on #27**       | `d8a1965`                                                                              | 2026-07-30 | Five lenses: claims audit, security, correctness, test integrity, silent failure. All 14 claims in the PR body verified TRUE independently, including the base test count. Four findings refuted with measurements, one of them a reassurance from the lens that reported nothing, which turned out to be the only claim in the round that was false. Three real out-of-scope findings became SEC-10, OBS-8, TEST-9 and TEST-10. One fix landed, a fail-closed test for a malformed body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **S0.7 done**         | `63b0cda`, `04c5d52`                                                                   | 2026-07-30 | **Closes TEST-2.** `createApiApp` separates app construction from listening, and `startTestApi` binds the real app to an ephemeral port and drives it with `fetch`, so middleware order, body parsing, status codes and the error handler all run. No new dependency, node 22 has `fetch`. Five cases, uploader suite 94 to 99. `requestUntil` exists because `startStream` queues uploader construction, so a stream is not addressable when `/stream/start` returns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **TEST-9 done**       | `04d0323`                                                                              | 2026-07-30 | **Closes TEST-9.** `tsconfig.test.json` puts `test/` under the same compiler options and the package `typecheck` script uses it, while `build` keeps the src-only config. Turning it on surfaced ten pre-existing errors in `OmeHlsPuller.test.ts`, which reached into private members through an `OmeHlsPuller & PullerInternals` intersection that TypeScript reduces to `never`. It paid for itself within the hour: S2.1's new required config field broke `StreamOrchestrator.test.ts` and typecheck caught it before the test run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **S2.1 done**         | `9c17965`                                                                              | 2026-07-30 | **Closes OBS-1.** `deriveHealthStatus` holds the whole policy as one pure function. Degrades on three consecutive manifest publish failures, on high queue pressure, or on a registered stream silent for `SEGMENT_STALL_MS`, and degraded answers 503. Three rather than one because a failed publish retries at the same SOC index on the next segment, so one or two self-heal and would only flap the endpoint. All four states proven end to end over HTTP, boundaries asserted either side. Nothing restarts on the 503: no compose healthcheck exists and `health.sh` treats a non-200 as a warning. Suite 99 to 114.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **SEC-11 closed**     | `e5ae217`, `0f92a3d`                                                                   | 2026-07-30 | **Closes SEC-11.** Owner decision: the OME admission sample ships an empty value, so a first deploy stops at a named startup error rather than running a secret published in this repository. Measured both ways against `createOmeEngineFromEnv` rather than assumed. `setup.sh` now prints the generator command when it creates the file. The rejected alternative was generating a secret in `setup.sh`, an OPS change to a script that touches live deployments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Gate on #30**       | `408d366`, `4b07988`, `402a927`, `19549ad`, `6c9d7fb`, `3bcd955`                       | 2026-07-30 | Six lenses: claims audit, correctness, security, silent failure, config consistency, test integrity. **The widest gate result so far, and the first where the change under review was substantially wrong.** One CRITICAL: a refused segment upload was invisible to all three signals at once, so `/health` answered `200 ok` while every segment was lost, reproduced before fixing. Four lenses independently found the stall clock was one process-wide scalar, masking a dead stream behind a live one. A normal drain and every crash recovery both reported degraded. `SEGMENT_STALL_MS` could not be set in a container. The `setup.sh` warning added hours earlier fired only when false. Ten findings fixed, eight rejected with disproofs, five new register rows. Test integrity ran 36 mutations, 27 caught and 9 survived, and following the survivors found a further defect in the fix itself. Claims audit: 33 TRUE, 1 MISLEADING, 1 UNVERIFIABLE, 0 FALSE. Suite 114 to 126.                                                                |
| **S0.6 done**         | `4f44e85`                                                                              | 2026-07-30 | **Closes S0.6 and the fetch half of ARCH-2.** All three of the puller's fetch call sites went through the global. A `PullerOptions` object replaces the trailing optional `onHalt` parameter rather than adding an eighth positional argument, and the fetcher defaults to global `fetch`. Three tests with no network: master to variant resolution, a 404 leaving the puller retrying rather than latching a dead variant, and a hang. The hang test asserts the tick does **not** settle, documenting the gap S2.2 closes instead of pretending it is shut. Suite 128 to 131.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **S0.5 done**         | `1a0e47f`                                                                              | 2026-07-30 | **Closes S0.5 and the timing half of TEST-4 and TEST-6.** A `Clock` supplies a monotonic `now` and a cancellable `setTimer`, defaulting to the real clock so no call site changes. `FakeClock` advances time on demand. The acceptance test advances past 60s and finalizes the unfed recovered stream, and it also closes TEST-4 by asserting the VOD entry landed and the recovery state was cleared, since reaching an active count of zero passes even when nothing was published. One deliberate behaviour change: the recovery handler was an async callback whose rejection nobody could observe, and it now routes failures through ErrorHandler. Measured, 128 tests in 2492ms becomes 134 in 2389ms, so the criterion's "wall time does not increase" holds.                                                                                                                                                                                                                                                                                        |
| **Gate amendment**    | `0d65d84`, `83bb8e6`, `abb4258`                                                        | 2026-07-30 | **PR #33.** The owner's lens-selection rule lives in `review-gate.md` now rather than only in session notes, which is why it kept not being followed. R1's floor of three reviewers plus the claims auditor is withdrawn, R4 requires the posted result to name both the lenses that ran and the ones selected against, fail-closed keys on a selected lens that did not run, and the sprint exit gate gains the full-catalogue deep run as a fifth condition. Ten measured prompt rules moved in alongside it. The follow-up had been deferred across three PRs behind a defensible reason, that amending the gate deserves its own gate, which is how a deferral turns into an omission.                                                                                                                                                                                                                                                                                                                                                                    |
| **Gate on #33**       | `98fffa1`, `4b0fda5`, `f7c1bc0`, `13e8874`, `ca52502`, `5e7aa7f`, `fbe9e75`, `82a26ca` | 2026-07-30 | Three lenses, selected by surface: claims audit, config consistency, protocol correctness. **The last of those was not in the catalogue, and having to invent it was the round's most useful finding**, so it is a row now. Seven findings, all confirmed, none refuted, so the rejected-findings tables are unchanged. The one that mattered: adding the deep run updated the handoff's copy of the sprint exit gate and left the register's copy saying "all four", and the condition missing from it was the deep run itself, the whole mechanism that makes narrow per-PR selection safe. That duplicate is gone rather than synced. Two clauses turned out to have no artifact behind them, the pre-launch selection and the new ban on lenses reading `docs/reviews/`, which R1 contradicts on exactly the pull requests that amend this document. Claims audit: 22 TRUE, 3 MISLEADING, 2 FALSE, 5 UNVERIFIABLE, every error in the description rather than in the diff, including the prompt-rules section asserting its own measurements as evidence. |

### Sprint 0 remaining

`S0.3`, `S0.4`, `S0.5` and `S0.6` are not started. S0.7 is done. S0.6 is the smallest and unblocks
puller tests plus S2.2's timeout proof, so it is the natural next one.

### Both decisions from Sprint 0 are now made

**Full-tree prettier sweep. Decided: swept.** All 28 files that predated the formatting gate are
formatted, and the CI `format` job now checks the whole tree on push and on pull requests instead of
only the files a pull request touched.

The conflict worry that argued for deferring this was mostly wrong. `feature/uploader-hardening` is
frozen at zero commits past `f146588`, so it cannot conflict with anything. Five of the 28 files are
touched by open PRs #11, #12 and #13 into `main`, which is the real overlap, but those branches sit on
a line behind `f146588` and already need reconciling with this one, so formatting adds a mechanical
resolution rather than a new problem. Take their change, re-run prettier.

Sweep hygiene worth keeping. Semantic equivalence was established rather than assumed, by compiling
the uploader before and after and diffing the emitted JavaScript: 12 differing lines across 5 files,
every one of them `x =>` becoming `(x) =>` from prettier's arrowParens default, and byte-identical once
that single construct is normalized in both. `.git-blame-ignore-revs` lists the sweep revision, so
enable it once per clone with
`git config blame.ignoreRevsFile .git-blame-ignore-revs`.

Count tracked files, with `git ls-files -z | xargs -0 npx prettier --check`. A bare
`prettier --check .` also walks untracked and gitignored paths such as `.vscode/settings.json`, so it
reports a number that depends on whose machine it ran on. That is where the 35 in earlier drafts came
from, and it is not reproducible in CI.

**Node version story. Decided: 22.** `engines.node` said `>=20` and the production images were
`node:20-alpine`, while the test tooling had never actually run on 20. Ten declarations now agree on
22: `engines.node`, `.nvmrc`, both deploy images, four READMEs, and the two in the CI workflow, which
are the matrix and the format job's own `node-version`. The matrix drops to a single entry because
nothing claims to support a second version any more.

22 rather than 24 because 22 is what the team runs locally and what the tests have always passed on.
Note that **Node 22 is in maintenance as of mid-2026 and 24 is the current active LTS**, so moving to
24 is a real follow-up. The image change only takes effect on the next deploy, which needs a build and
an operator-run `scp`.
