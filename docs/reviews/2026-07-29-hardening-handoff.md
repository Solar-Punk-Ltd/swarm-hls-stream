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
lint and test on a Node 20 and 22 matrix, plus a formatting check on the files a pull request touches.
Before that a prettier violation shipped inside PR #10 and nobody noticed. Treat CI as the floor now
rather than a manual step, and note that it caught a real latent break on its very first run.

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

## Open decision, not yet made

The repo owner has not chosen how to sequence against the QA stress test. The options put to them:

1. Land S0.1, S2.1, and S2.2 first, then run QA, so the test can actually fail when the system is
   broken. This was the recommendation.
2. Run QA now on `f146588` and treat the result as a rough baseline only.
3. Land all of Sprint 0, 1, and 2 before any stress testing.

Ask before assuming. The answer changes what you do first.

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

| Task          | Commit               | Date       | Notes                                                                                                                                                                                                                                                                                                        |
| ------------- | -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| —             | `f146588`            | 2026-07-29 | Branch point. Audit and handoff docs only, zero code changes.                                                                                                                                                                                                                                                |
| SEC-7 added   | `f0d19f3`            | 2026-07-29 | New register row. GitHub reports 60 open Dependabot alerts, axios 21 of them at runtime scope through bee-js. The audit had inferred "no known vulnerabilities" from package.json without checking advisories. Promotes the bee-js work in S6.3 from optional spike to remediation path.                     |
| **S0.2 done** | `b1d37e9`, `64f7ffa` | 2026-07-29 | eslint config added to `packages/cli`, mirroring stream-uploader minus the jest env. Root `pnpm lint` now exits 0, previously always 1. The config surfaced 9 pre-existing violations across 6 files (curly, one import-sort), all autofixed in the second commit. `tsc --noEmit` clean.                     |
| **S0.8 done** | `96b3e57`            | 2026-07-29 | README quickstart fixed. `pnpm dev`, `pnpm start:uploader`, `pnpm srs:up` did not exist. Now `client:start`, `uploader:start`, `srs:host`, plus `ome:host` since the block only ever named SRS. Verified by asserting every `pnpm X` in the block resolves to a real script or a pnpm builtin. Closes DOC-1. |
| **S0.1 done** | `db06455`, `6f84776` | 2026-07-29 | CI workflow added, **verified green on a real run** (node 20 and 22). Runs typecheck, lint, test. Formatting is gated on changed files only, see the note below. Its first run immediately caught a latent bug: the uploader test glob never worked on node 20, fixed in `6f84776`.                          |

### Sprint 0 remaining

`S0.3`, `S0.4`, `S0.5`, `S0.6`, `S0.7` are not started. S0.6 is the smallest and unblocks puller
tests, so it is the natural next one.

### Two decisions left open by Sprint 0

**Full-tree prettier sweep.** **28 tracked files** fail prettier, spanning source, tests and compose
files. That predates any formatting gate. The CI `format` job therefore checks only files a pull
request touches, which stops new violations without forcing a 28-file reformat that would bury real
diffs and conflict with the two branches in review. Clearing the backlog and widening the job to
`prettier --check .` is a deliberate call for the repo owner, not a side effect of this work.

Count tracked files only, with `git ls-files -z | xargs -0 npx prettier --check`. A bare
`prettier --check .` also walks untracked and gitignored paths such as `.vscode/settings.json`, so it
reports a number that depends on whose machine it ran on. That is where the 35 in earlier drafts came
from, and it is not reproducible in CI.

**Node version story.** `engines.node` says `>=20` and the production image is `node:20-alpine`, yet
the test tooling had never run on 20. The matrix now covers both. If the team decides development is
22-only, say so explicitly in `engines` and drop 20 from the matrix, because the two should not
disagree silently.
