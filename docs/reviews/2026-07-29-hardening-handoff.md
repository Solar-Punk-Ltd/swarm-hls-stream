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
register is your input. Its "Rejected findings" section lists nine claims that were investigated
and disproved, so do not re-raise them.

Pick up from the progress log at the bottom of the handoff. Follow the working protocol exactly,
including the review gate on every PR and the re-audit step at the end of each sprint. A task is
done when its acceptance criterion passes as a test, not when the code looks right.

Before your first commit, confirm you are on feat/ai-hardening and that HEAD matches what the
progress log says. Ask me before pushing anything to a shared branch.
```

## Next session starts here

Written 2026-07-30 at the end of the S1.3 session. Read this before the sprint plan below, because it
supersedes anything in this document that contradicts it.

**Where the code is.** `feat/ai-hardening` @ `dee6905`. Both P0 one-file fixes are merged: S1.4 as
PR #27 and S1.3 as PR #28, each through the full review gate. `feature/uploader-hardening` @
`f146588` and `main` @ `6b82baa` are untouched and must stay that way. Test baseline is now **94
uploader, 5 client**, with lint, typecheck and whole-tree prettier all clean. Do not let those
regress.

**Next task: S2.1**, deriving `/health` status from the signals it already computes. It is next in
the P0 order now that S1.4, S1.3 and S0.1 are done, and it unblocks every QA number, because the
endpoint currently cannot report a problem at all. Then S2.2, S1.1, S4.1. Sprint 0 still has S0.3
through S0.7 open, and S0.6 is the smallest of those.

**One decision is waiting on the owner: SEC-11.** `engines/ome/.env.sample` ships
`OME_ADMISSION_SECRET=change-me`, and `setup.sh:44` copies that file, so a fresh OME deployment runs
a secret published in this repository. S1.3 moved the shipped default from _no secret_ to _a known
secret_, which is an improvement and not a closure. Every fix changes operator workflow, so it is not
an implementation decision: an empty sample value makes a first deploy refuse to start, and
generating a random secret in `setup.sh` is an OPS change. Ask before picking one.

**There is an unmerged branch: `chore/agent-harness`** (3 commits, pushed, no PR yet). It carries
`.claude/settings.json` disabling the GateGuard edit-write fact hook, the `.gitignore` rule for
TEST-10, and a composite `pnpm verify` script. **It has not been through the review gate**, so open a
PR and run the gate before merging it. Note that `.claude/settings.json` exists only on that branch,
so the hook stays active on `feat/ai-hardening` until it lands.

**Gate amendments to fold into `review-gate.md` when that branch merges.** Measured this session, not
guessed:

- Give each lens a neutral orientation brief (repo layout, test commands, known traps). It reveals
  nothing about the expected answer, so R1 holds. It cut the test lens 20% on tokens and 38% on time
  and cost the security lens 19% more, so it is not a uniform win, and it needs more samples.
- Run the **claims auditor first and alone**, before the code lenses. Twice this session a test count
  went stale mid-review and invalidated the description after the code lenses had finished.
- Four lenses, not five, on small diffs. The floor is three plus claims, and both rounds ran five.
- The mechanical lenses (test integrity, claims audit) mostly run commands and count. They do not
  need the top model tier. Security and correctness do.

**Traps found the hard way this session.**

- Lens agents created git worktrees **inside the repo** (`base-revision/`, `test-base/`) despite being
  told to use the scratchpad, and one of them held `feat/ai-hardening` checked out, which blocked the
  merge until it was detached. Tell lenses the scratchpad path explicitly, and remove both directories.
- A lens ran `tsc` with file names on the command line, which silently ignores `tsconfig.json` and
  emits 15 `.js` files beside the sources, turning `pnpm lint` red while every tracked file was clean.
  Always instruct lenses to pass `--noEmit` and never name files.
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

**The health check currently cannot report a problem.** `api/routes/health.ts:10` hardcodes
`status: 'ok'`. The e2e suite and smoke test both gate on it, so a silently dead uploader passes
today. Any QA number taken before S2.1 lands cannot distinguish healthy from dead.

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
   short: at least three independent lenses plus the claims auditor, none of them given the PR
   description or the author's reasoning, then a verification pass in which every finding defaults to
   refuted until it reduces to a specific input and a specific wrong outcome. Fix the confirmed ones
   as separate commits, rebut the rest with evidence, post the result on the PR, and append the
   refutations to the register. Prior rounds produced both genuine bugs and confidently wrong claims,
   so neither blanket acceptance nor blanket dismissal is correct.
4. **CI green**, coverage not below the recorded baseline.
5. **Re-audit the touched domain** at the end of each sprint. Re-run that domain's audit against the
   new HEAD with the register attached, asking two questions: is each claimed-closed finding actually
   closed, and did the fix introduce anything new. A fix that closes its own finding but adds a HIGH
   does not pass.
6. **Close on evidence.** A finding closes when its acceptance test exists and passes.

Sprint exit gate, all four required: every acceptance test in the sprint passes, the re-audit reports
no new CRITICAL or HIGH in the touched files, no review-gate finding is left unaddressed or
unrebutted, and CI is green.

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

| Task                  | Commit                                     | Date       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —                     | `f146588`                                  | 2026-07-29 | Branch point. Audit and handoff docs only, zero code changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| SEC-7 added           | `f0d19f3`                                  | 2026-07-29 | New register row. GitHub reports 60 open Dependabot alerts, axios 21 of them at runtime scope through bee-js. The audit had inferred "no known vulnerabilities" from package.json without checking advisories. Promotes the bee-js work in S6.3 from optional spike to remediation path.                                                                                                                                                                                                                                                                                                             |
| **S0.2 done**         | `b1d37e9`, `64f7ffa`                       | 2026-07-29 | eslint config added to `packages/cli`, mirroring stream-uploader minus the jest env. Root `pnpm lint` now exits 0, previously always 1. The config surfaced 9 pre-existing violations across 6 files (curly, one import-sort), all autofixed in the second commit. `tsc --noEmit` clean.                                                                                                                                                                                                                                                                                                             |
| **S0.8 done**         | `96b3e57`                                  | 2026-07-29 | README quickstart fixed. `pnpm dev`, `pnpm start:uploader`, `pnpm srs:up` did not exist. Now `client:start`, `uploader:start`, `srs:host`, plus `ome:host` since the block only ever named SRS. Verified by asserting every `pnpm X` in the block resolves to a real script or a pnpm builtin. Closes DOC-1.                                                                                                                                                                                                                                                                                         |
| **S0.1 done**         | `db06455`, `6f84776`                       | 2026-07-29 | CI workflow added, **verified green on a real run** (node 20 and 22). Runs typecheck, lint, test. Formatting is gated on changed files only, see the note below. Its first run immediately caught a latent bug: the uploader test glob never worked on node 20, fixed in `6f84776`.                                                                                                                                                                                                                                                                                                                  |
| **Review gate**       | `7341363`, `1bc5cb3`                       | 2026-07-29 | Copilot quota ran out for the month, so the gate it filled was rebuilt in-house as [`review-gate.md`](./review-gate.md). Five independent lenses ran against PR #24, then a verification pass in which every finding defaulted to refuted. Five claims refuted with disproofs recorded, three confirmed and fixed, four real out-of-scope findings added to the register as SEC-8, SEC-9, TEST-7, TEST-8.                                                                                                                                                                                            |
| **Gate fixes on #24** | `0c151c1`, `c7e6014`, `81d0a7d`, `e094fe1` | 2026-07-29 | What the gate confirmed. Explicit read-only `permissions` on the workflow. NUL-delimited changed-file list, since bare `xargs` split paths on whitespace. Prettier's own `--ignore-unknown` in place of a hand-written extension allowlist that omitted `html` and so never gated `packages/client/index.html`. `packages/cli` now declares the eslint toolchain it lints with, instead of relying on siblings to declare it.                                                                                                                                                                        |
| **Node baseline 22**  | `af390bc`, `55b35eb`                       | 2026-07-29 | Owner decision. Nine declarations moved from 20 to 22 and the CI matrix dropped to a single entry, since `engines.node`, the deploy images and the tooling now agree. Images take effect on the next deploy only. Node 22 is in maintenance and 24 is the current active LTS, so 24 is a real follow-up.                                                                                                                                                                                                                                                                                             |
| **Prettier sweep**    | `7f41d02`, `80c8fb8`, `da26850`            | 2026-07-29 | Owner decision. All 28 files formatted, CI widened from changed-files to the whole tree on push and PR. Semantic equivalence proven by diffing `tsc` emit before and after: 12 differing lines, all `arrowParens`, byte-identical once normalized. Widening also deleted both `${{ github.base_ref }}` interpolations, **closing SEC-9**. `.git-blame-ignore-revs` added.                                                                                                                                                                                                                            |
| **S1.4 done**         | `8299bd1`                                  | 2026-07-30 | **Closes SEC-2.** `resolveSegmentPath` compares the resolved path against the resolved media root, so an escaping path returns before any `fs` call. First test for the SRS engine, 11 cases, uploader suite 67 to 78. Proven by neutering the containment and confirming 8 of the 11 fail, which is the only thing that shows the assertions have teeth.                                                                                                                                                                                                                                            |
| **S1.3 done**         | `dba3f94`, `3bcf889`                       | 2026-07-30 | **Closes SEC-3.** An empty admission secret now rejects instead of admitting, and `createOmeEngineFromEnv` uses `required`, so an `ENGINE=ome` deployment without a secret fails at startup. Deleting the early return alone would not have been enough: the empty string is a usable HMAC key, so a caller who knows the secret is empty can sign with it and pass. Tests written first, 6 of 12 failing before the change. Uploader suite 79 to 91. Left open as **SEC-11**: `setup.sh` copies the sample, so the published `change-me` becomes the live secret on a fresh OME deploy.             |
| **Gate on #28**       | `c97efd3`                                  | 2026-07-30 | Five lenses: claims audit, security, correctness, test integrity, config consistency. Config consistency replaced silent failure, since the change is a configuration contract. All 17 claims verified TRUE, though one was TRUE on insufficient evidence and was reworded. Four refutations, and one confirmed finding fixed: `required` said "missing" for a variable compose had set to empty. Lenses were given a neutral orientation brief for the first time, which cut the test lens by 20% on tokens and 38% on time but cost the security lens 19% more tokens, so it is not a uniform win. |
| **Gate on #27**       | `d8a1965`                                  | 2026-07-30 | Five lenses: claims audit, security, correctness, test integrity, silent failure. All 14 claims in the PR body verified TRUE independently, including the base test count. Four findings refuted with measurements, one of them a reassurance from the lens that reported nothing, which turned out to be the only claim in the round that was false. Three real out-of-scope findings became SEC-10, OBS-8, TEST-9 and TEST-10. One fix landed, a fail-closed test for a malformed body.                                                                                                            |

### Sprint 0 remaining

`S0.3`, `S0.4`, `S0.5`, `S0.6`, `S0.7` are not started. S0.6 is the smallest and unblocks puller
tests, so it is the natural next one.

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
