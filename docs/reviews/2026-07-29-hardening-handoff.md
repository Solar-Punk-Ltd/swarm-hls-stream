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

Written 2026-07-31, replacing the 2026-07-30 note. Read this before the sprint plan below, because it
supersedes anything in this document that contradicts it.

**Where the code is.** `feat/ai-hardening` at `d5ed9ea`, with CON-20 on `fix/con-20-stale-session-media`. Fifteen pull requests merged, each through the
review gate: #27 through #39, #41 and #42. **PR #13 into `main` is closed as superseded**, by owner
decision on 2026-07-31, with the reasoning recorded on the pull request itself. `feature/uploader-hardening`
@ `f146588` and `main` are untouched and must stay that way.

**Test baseline is 282 uploader, 40 cli, 27 client, 38 audit-gate, 12 deploy**, with lint, typecheck and whole-tree prettier clean. One
command: **`pnpm verify`**. It short-circuits at the first failing stage, so a lint error hides later
test results. Do not let any of it regress. Typecheck covers `test/` as well, see TEST-9.

### Where things stand: no CRITICAL is open, and the highest severity left is HIGH

**CON-20 is closed, and closing it needed a real OvenMediaEngine rather than the suite.** The row
left reachability as the open acceptance criterion, and the downgrade-if-unreachable instruction was
here in the queue rather than in the row itself. It is
reachable, and the measurement is in the register row: a reconnect 4.2s to 4.8s after an abrupt
publisher drop read the outgoing broadcast's playlist 4 times out of 4, and at 5.0s and beyond read
404 0 times out of 4. **The row's stated consequence was also wrong, in the direction that
understated it.** It predicted a fabricated discontinuity. What actually happens is that the
reconnected session's own media is discarded in full, because both sessions restart the media
sequence at zero, so the real broadcast lands at or below the high-water the stale tail leaves
behind. CON-16's silence, inside the very puller that was CON-16's fix.

**SEC-1 and OPS-1 are both closed**, and they were the two that could actually cost the owner money.
SEC-1 was an open funds drain: anyone on the internet could reach the endpoints that spend the
postage stamp. OPS-1 lost the batch id after paying for it. Neither is reachable now, and both went
through the gate.

**SEC-13 is deferred to the backlog by owner decision, at MEDIUM. Do not re-open it.** SRS writes the
webhook credential into its own container log on every hook. Reading that log needs container access,
which already exposes the same secret two other ways. The two conditions that would change that are
in the SEC-13 row: shipping container logs off the host, and an operator pasting SRS logs into a
ticket.

**No CRITICALs remain open,** as of the PR #42 gate and not before it. Both rows were marked closed
once on evidence that did not support it, and the gate reopened them. OPS-2 turned out to be three
straggler sweeps rather than the one the row named, and then, after those were fixed, `docker compose
down` turned out to ignore `--profile` entirely, so a service clean still destroyed every co-located
service one step earlier. OBS-2's client half was three unbounded requests rather than one, and the
helper written to bound them bounded only the wait for headers, leaving the body read unbounded and
making one case worse than before.

**The transferable part is how both slipped through:** in each case a test suite was green beside an
open CRITICAL, because the thing doing the damage was stubbed out. `deploy`'s docker stub treated
every `compose` call as an inert no-op, and the client's fake gateway never answered at all, so
neither could see a failure that begins with a successful response. **Ask what your stub makes
impossible, not only what it makes observable.**

**The cli package now has tests**, 40 of them, including `test/helpers/fakeBee.ts`, which models the
four stages a real postage batch purchase goes through. It was verified against bee-js's own
implementation and the Bee Go node's handlers during the PR #37 gate, so trust it as a starting
point rather than rebuilding it. Before this session that package had no test script at all, so
`pnpm -r test` skipped it silently and `pnpm verify` reported success while running nothing in the
package that spends money.

### What PR #38 changed about how to read this document

**CON-16 is closed, and the register row describing it was wrong.** It asserted that the stall signal
eventually finalizes a hung stream, so the failure halts rather than hangs. Nothing finalizes an idle
live stream. That row is corrected now, but treat it as the standing warning: **the register is
evidence, not scripture.** It was written by the same kind of pass that writes everything else here,
and a claim in it can be checked with a command in about a minute.

**The fix was not where the finding said it was.** CON-16 names the puller and the engine. The engine
half was real and small. The larger half was in `StreamOrchestrator.startStream`, which retired a
re-announced session in the background, so a fresh puller fed the outgoing uploader for the whole
drain. Indexes it had seen came back accepted through the duplicate filter, indexes above its
high-water were published into the outgoing session's VOD, and none of it reached `handleSegmentLoss`.
When a finding names a component, check the component on the other side of the handoff too.

**A puller-local fix for a session-level event was tried and reverted.** CON-17 holds the three
measurements. Do not rebuild it.

### Traps this session produced, and the first one is the important one

**A fake that resolves without yielding hides every ordering defect behind it.** This is TEST-19 and
it is the most transferable thing here. The CON-16 acceptance test finalized the outgoing session
through a fake whose writes resolved with no `await` that reached the macrotask queue, so the entire
drain completed inside one microtask cascade ahead of the puller's first tick. It passed against code
that failed in production on every restart, and one millisecond took it from 4 of 4 delivered to 0 of 4. Anything standing in for a network call needs a real yield, or the window you are testing is
closed before your test looks at it. `sleep(0)` is enough.

**A test can drive an ordering the real system never produces, and the flake then reads as the exact
defect the test guards.** CON-19. The CON-16 acceptance test restarted its fake origin before posting
the announce, which OME cannot do because the admission webhook gates the publish. Under CI
contention the replaced puller polled the restarted origin in that gap and delivered it into the
session it replaced, so the assertion failed with the true signature of the defect it was written for,
on code that does not have it. Two sessions went into hypotheses about the engine before anyone asked
whether the _test's_ sequence was one the component could reach. When a guard fails with its own
signature, check the setup against the real contract before reading the failure as a regression. The
matching trap on the other side is that nothing in a playlist distinguishes that window from ordinary
progress, so a reorder here was the fix and a fix in the engine would have been theatre.

**A test that asserts on one of two published artifacts is blind to the other, and CON-20 was hiding
there the whole time.** The CON-16 acceptance test checks `vods[0]`, the retired session. Both
sessions publish a VOD. Probing `vods[1]` shows the new session's recording carrying the outgoing
session's tail plus a fabricated discontinuity, wrong in 5 of 8 runs, and no assertion has ever looked
at it. Two review rounds and a closed HIGH went past this. When a fix produces a pair of artifacts,
assert on both, because the one you did not name is where the mirror image of your bug lives. The
reorder is what made the suite start traversing that state, which is the only reason it surfaced: **a
change that makes a system take a new path is worth re-probing even when its own assertion passes.**

**A fix that moves work earlier can break a path that relied on it being later.** Making the
replacement spawn synchronous was correct and introduced a CRITICAL: a drain that started before a
re-announce still detached by stream id when it finished, and that id belonged to the replacement by
then, so a broadcaster that reconnected inside its own disconnect drain was unregistered by it.
Silent and permanent. Ask what ordering the old code was accidentally providing.

**Verify a lens finding before acting on it, including a persuasive one with probe output.** The
claims auditor reported a surviving mutation as a real coverage gap and showed readings for it. It
did not reproduce: p-queue runs a synchronous job inline, so the window it described is zero, and the
probe came back byte-identical. R2's default of refuted earns itself against lenses as often as
against the author.

**Two of my own "harmless equivalent" survivors were not equivalent.** If you dismiss a surviving
mutation, write down the mechanism that makes it equivalent and have someone else check it. One of
the two here was refuted by the test-integrity lens in the next round.

### Traps this session produced, all of them expensive

**`pnpm verify` gives a false green on any file you have not committed yet.** The format stage walks
`git ls-files`, which lists tracked files only. A new file passes locally and fails CI. Commit, then
verify.

**A fix can break a working path.** The OPS-12 fix refused to buy when the wallet balance could not
be read. That also blocked the path where an existing batch is reused, which spends nothing and
needs no chain. Ask what a new refusal stops that was previously fine.

**Probe your own fix before committing it.** The structural fix for redaction, moving it into
`Logger.formatMessage`, reasons perfectly and silently truncates every request log line at the
token, because the redactor is URL-shaped and a log line is not a URL. Three lines of probe caught
what reasoning did not.

**A fake's premise has to be pinned like any other behaviour.** `fakeBee.ts` argued for
`waitForUsable: false` at length and could not detect its removal. Flipping it left the whole suite
green while reintroducing OPS-1 in production.

**`str.replace` does not throw on a miss.** Two register edits silently no-oped after prettier
reformatted the column widths. If you edit a markdown table by string substitution, assert the
result changed, and re-check the status column afterwards.

### What SEC-1's closure does and does not mean

Both halves are closed, `/stream/*` in #35 and the SRS webhooks in #36. What that means is that
an anonymous caller can no longer cause a stamp-spending upload. What it does not mean is that the
ingest surface is finished: **SEC-5 is still open**, there is no rate limiting and no per-stream quota,
so an authenticated caller with a leaked token is unbounded. S1.5 (schema validation) and S1.7 (error
responses) are also still open.

### The queue after that, in severity order

0. **TEST-22, HIGH.** Nothing asserts anything about the client bundle, which is how PR #39 shipped a
   silent browser-target regression past two gates and a manual browser check. CI builds now, which
   proves a bundle can be produced and nothing about what is in it. The two assertions that would
   have caught it are cheap and named in the register row.
1. **Test debt, now including TEST-23.** Nothing proves `retireSession` is needed in the re-announce
   branch: delete that line and all 274 uploader tests still pass, because p-queue runs its job
   inline and the overwrite hides it. The line stays and needs covering, which takes a busy queue
   no current test can arrange. Alongside it: 36 mutations survived the #34 gate and more the #35 one, recorded as TEST-16. The
   largest single gap is that **nothing loads `config.ts`**, so every `required()` call in it can be
   deleted with the suite green. Same module-scope obstacle as TEST-11. Plus S0.3 (coverage baseline). **S0.4's
   FakeBee now exists** for the stamp path, at `packages/cli/test/helpers/fakeBee.ts`, verified
   against the vendor's own implementation.

### The lesson every gate keeps producing

Eight rounds running, the same shape: **a signal was added and the failure it was meant to catch did not
reach it.** On #30 three signals were added and the likeliest failure reached none. On #34 a lost
segment was counted on a consecutive counter that the very next success cleared, so 3623 polls answered
200 while a segment was genuinely lost. On #35 a token that passed validation could lock every caller
out permanently, and a green e2e suite would not have shown it because Node `fetch` and curl encoded
the header differently.

The generalisable move, and the one that would have caught all three: **drive the real component, not
the seam.** Every one of those defects was hidden by a test that called the thing directly and then
asserted on it. The test that caught the #34 defect drives the actual puller into the actual `/health`.

Rounds four, five and six added variants worth naming, because the move above does not catch them.

**#36: the test pinned the one case that was safe by construction.** A redaction test asserted the
uppercase `?TOKEN=` spelling, which the gate rejects, while every percent-encoded spelling that
authenticates went untested and leaked. When a control and its check read the same input through
different parsers, test the shapes the _permissive_ side accepts.

**#37: the test passed on litter from the previous run.** It scanned the shared temp directory for a
file the suite itself wrote and never cleaned up. Deleting the entire mechanism under test kept it
green on any machine that had run it once. Derive the location from the run, never discover it by
scanning shared state, and clean up what you write.

**#37 again: a fake's premise needs pinning like any other behaviour.** `fakeBee.ts` argued at length
for `waitForUsable: false` and could not detect its removal.

**#39: the control was disabled by a supported setting in the file the change itself edited.** A
`pnpm.auditConfig.ignoreGhsas` key makes `pnpm audit` drop advisories from the report entirely, not
into `muted`, so a gate built to fail on an unreviewed advisory printed "every one of them
allowlisted" with two live in the tree. Before shipping a control, ask what the tool it wraps already
offers for suppressing the thing being gated, and make the control refuse that too. The evidence was
inside the document the gate had already parsed. **And a default you inherit is not a default you
keep:** vite 5 and vite 8 default `build.target` differently, no source file changed, so the diff read
as mechanical while the emitted CSS gained range syntax older engines drop whole. Loading the built
page in a current browser is exactly the check that cannot see it.

**#38: the test could not fail, because its fake closed the window it was testing.** The seventh round
produced the same shape from a new direction: the control was added, the failure was real, and the
test that was meant to catch it ran in a world where the failure could not occur. Round one of that
gate then found the fix itself incomplete in three ways and the round two lens found the rework's own
regression, so the count of rounds where the gate changed the outcome is now every round it has run.

**CON-20: the fixture left out the one field that made the fix possible, so the fix looked impossible.**
The eleventh round, and the sharpest version of the stub lesson yet. The CON-16 playlist fixtures write
`#EXT-X-MEDIA-SEQUENCE`, `#EXTINF` and a URI, which is everything the parser read. Real OME also stamps
every segment with `#EXT-X-PROGRAM-DATE-TIME`, and that is the only field in the playlist that separates
one session's media from the next one's, because the media sequence restarts at zero and the segment
file names repeat byte for byte across broadcasts. Working from the fixture, the two sessions are
genuinely indistinguishable and no puller-local fix can exist, which is roughly what CON-17 concluded.
Working from the real origin, the answer is one line of parsing. **The earlier form of this lesson was
about a stub hiding a failure. This one is about a stub hiding a solution**, which is harder to notice,
because a missing failure eventually shows up in production and a missing solution never shows up at
all. When a fixture stands in for a protocol, diff it against a real capture before believing what it
implies about what is knowable.

**CON-20 again: an assertion on a total was satisfied by the wrong content.** The acceptance test
checked the reconnected session's VOD duration, and a mutation shrinking the floor to a single segment
passed it, because leaking three stale segments in place of the three real ones came to the same
number. Aggregates collide. The two sessions now run at different segment durations, so the length says
which broadcast is inside rather than how much of something is. **Ask whether a wrong answer could
produce your expected number**, not only whether the right one does.

Second, cheaper move: **ask which numbers in the new code an outside party controls.** That is what
found the unbounded gap scan in `5be1a72`, which no review caught.

Third: **probe your own fix before committing it.** See the traps section above.

### Traps still live

- **A question about what OME actually does is answerable in about five minutes, without the deployed
  stack.** CON-20 turned on one, and the bee node has no postage stamp so nothing live could run. It
  did not need one. Run `airensoft/ovenmediaengine:latest` on shifted ports under its own compose
  project name, mount this repo's real `engines/ome/Server.xml.template` and `entrypoint.sh` so the
  config is the production one, point `OME_ADAPTER_HOST` at `host.docker.internal`, and answer the
  admission webhook with a throwaway Node server that also records what the HLS playlist held at that
  instant. Publish with `ffmpeg` over SRT using the full-URL streamid form, `kill -9` the publisher to
  drop the connection without a close, and republish. **Never** reach for `deploy.sh` or `clean.sh` for
  this: they operate on real stacks and `clean.sh` destroys data.
- **OME keeps a dropped publisher's SRT session and HLS output alive for about five seconds**, and
  answers the admission webhook for a reconnect inside that window before checking whether the stream
  name is free. It then rejects the republish as a duplicate 111ms later. Any reasoning about
  reconnects has to account for that ordering, measured 2026-07-31.
- **This repo is a git submodule** of `streaming-infra-manager` at `manager/swarm-hls-stream`, tracking
  `branch = feature/uploader-hardening`, **not** `feat/ai-hardening`. The e2e suite will not see any of
  this work until that is merged back or the submodule is repointed.
- **The e2e suite will now fail against a current uploader** until it sends `Authorization: Bearer
$API_AUTH_TOKEN` on every `/stream/*` call. Nothing in this repo calls those routes, so the breakage
  is entirely in the sibling repo.
- `engines/ome/.env` **cannot** fix a failing OME container: `Dockerfile.uploader` copies only
  `package.json` and `dist/`, so the file is not in the image. The deploy `.env` is the only lever.
- **PR #13 into `main` is superseded, not merged.** It resolved the advisory set as it stood on
  2026-06-10 and rotted: 33 alerts became 60 and six of its pins fell behind. SEC-7 supersedes it from
  `feat/ai-hardening`. Closing it is the owner's call and it has not been made.
- **Dependabot only ever scans the default branch.** A dependency added on `feat/ai-hardening` is
  invisible to it until the branch merges, which is how a vitest CRITICAL sat with no alert. `pnpm
audit:check` runs on every branch and is the thing that actually gates. See SEC-17.
- **A dependency bump is not verified because the advisories cleared.** Check publish age, registry
  signature and SLSA provenance, `npm audit signatures`, and malware advisories, on every version the
  change introduces. During SEC-7 the base branch sat on axios 0.30.3 with a malicious 0.30.4 inside
  the range bee-js declares.
- **On-chain actions are the owner's.** Never buy or top up a postage stamp.
- **Never run the deploy or clean scripts casually.** `clean.sh` over-reaches beyond the service named,
  which is OPS-2.
- `gh pr merge` is blocked here. Merge locally and push; GitHub marks the PR merged.
- `git merge -F -` does not read stdin, unlike `git commit -F -`.
- **`tsx --test test/` with a bare directory does not work** and reports a spurious single failure that
  reads exactly like a mutation kill. TEST-7 records it and it still produced wrong numbers during the
  #34 gate. Use `pnpm test`.
- A **prettier hook reformats markdown on write**, so table columns get re-padded after you save.
- **Prettier cannot see a broken markdown table.** A paragraph inserted between a table body and its
  last row turns that row into prose, and `--check` passes. The #35 gate found one.

### Still blocked, unchanged

The bee-uploader node has zero postage stamps and buying one is the owner's action. The deployed
uploader is stale and updating it needs a local `pnpm build` then an operator `scp`. The QA stress test
is deferred to the very end by owner decision, which keeps the `streaming-infra-manager`
branch held for the duration.

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
| 5     | S2.2 | Timeouts on all six `fetch` call sites, three puller and three client      |
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
| S2.2 | Timeouts on all six `fetch` call sites (3 puller, 3 client)   | OBS-2        | P0  | S   |
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

- **The `streaming-infra-manager` branch stays held for the duration**, since nandibaa's
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

| Task                     | Commit                                                                                 | Date       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —                        | `f146588`                                                                              | 2026-07-29 | Branch point. Audit and handoff docs only, zero code changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SEC-7 added              | `f0d19f3`                                                                              | 2026-07-29 | New register row. GitHub reports 60 open Dependabot alerts, axios 22 of them at runtime scope through bee-js. The audit had inferred "no known vulnerabilities" from package.json without checking advisories. Promotes the bee-js work in S6.3 from optional spike to remediation path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **S0.2 done**            | `b1d37e9`, `64f7ffa`                                                                   | 2026-07-29 | eslint config added to `packages/cli`, mirroring stream-uploader minus the jest env. Root `pnpm lint` now exits 0, previously always 1. The config surfaced 9 pre-existing violations across 6 files (curly, one import-sort), all autofixed in the second commit. `tsc --noEmit` clean.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **S0.8 done**            | `96b3e57`                                                                              | 2026-07-29 | README quickstart fixed. `pnpm dev`, `pnpm start:uploader`, `pnpm srs:up` did not exist. Now `client:start`, `uploader:start`, `srs:host`, plus `ome:host` since the block only ever named SRS. Verified by asserting every `pnpm X` in the block resolves to a real script or a pnpm builtin. Closes DOC-1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **S0.1 done**            | `db06455`, `6f84776`                                                                   | 2026-07-29 | CI workflow added, **verified green on a real run** (node 20 and 22). Runs typecheck, lint, test. Formatting is gated on changed files only, see the note below. Its first run immediately caught a latent bug: the uploader test glob never worked on node 20, fixed in `6f84776`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Review gate**          | `7341363`, `1bc5cb3`                                                                   | 2026-07-29 | Copilot quota ran out for the month, so the gate it filled was rebuilt in-house as [`review-gate.md`](./review-gate.md). Five independent lenses ran against PR #24, then a verification pass in which every finding defaulted to refuted. Five claims refuted with disproofs recorded, three confirmed and fixed, four real out-of-scope findings added to the register as SEC-8, SEC-9, TEST-7, TEST-8.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Gate fixes on #24**    | `0c151c1`, `c7e6014`, `81d0a7d`, `e094fe1`                                             | 2026-07-29 | What the gate confirmed. Explicit read-only `permissions` on the workflow. NUL-delimited changed-file list, since bare `xargs` split paths on whitespace. Prettier's own `--ignore-unknown` in place of a hand-written extension allowlist that omitted `html` and so never gated `packages/client/index.html`. `packages/cli` now declares the eslint toolchain it lints with, instead of relying on siblings to declare it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Node baseline 22**     | `af390bc`, `55b35eb`                                                                   | 2026-07-29 | Owner decision. Nine declarations moved from 20 to 22 and the CI matrix dropped to a single entry, since `engines.node`, the deploy images and the tooling now agree. Images take effect on the next deploy only. Node 22 is in maintenance and 24 is the current active LTS, so 24 is a real follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Prettier sweep**       | `7f41d02`, `80c8fb8`, `da26850`                                                        | 2026-07-29 | Owner decision. All 28 files formatted, CI widened from changed-files to the whole tree on push and PR. Semantic equivalence proven by diffing `tsc` emit before and after: 12 differing lines, all `arrowParens`, byte-identical once normalized. Widening also deleted both `${{ github.base_ref }}` interpolations, **closing SEC-9**. `.git-blame-ignore-revs` added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **S1.4 done**            | `8299bd1`                                                                              | 2026-07-30 | **Closes SEC-2.** `resolveSegmentPath` compares the resolved path against the resolved media root, so an escaping path returns before any `fs` call. First test for the SRS engine, 11 cases, uploader suite 67 to 78. Proven by neutering the containment and confirming 8 of the 11 fail, which is the only thing that shows the assertions have teeth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **S1.3 done**            | `dba3f94`, `3bcf889`                                                                   | 2026-07-30 | **Closes SEC-3.** An empty admission secret now rejects instead of admitting, and `createOmeEngineFromEnv` uses `required`, so an `ENGINE=ome` deployment without a secret fails at startup. Deleting the early return alone would not have been enough: the empty string is a usable HMAC key, so a caller who knows the secret is empty can sign with it and pass. Tests written first, 6 of 12 failing before the change. Uploader suite 79 to 91. Left open as **SEC-11**: `setup.sh` copies the sample, so the published `change-me` becomes the live secret on a fresh OME deploy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Gate on #28**          | `c97efd3`                                                                              | 2026-07-30 | Five lenses: claims audit, security, correctness, test integrity, config consistency. Config consistency replaced silent failure, since the change is a configuration contract. All 17 claims verified TRUE, though one was TRUE on insufficient evidence and was reworded. Four refutations, and one confirmed finding fixed: `required` said "missing" for a variable compose had set to empty. Lenses were given a neutral orientation brief for the first time, which cut the test lens by 20% on tokens and 38% on time but cost the security lens 19% more tokens, so it is not a uniform win.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Gate on #27**          | `d8a1965`                                                                              | 2026-07-30 | Five lenses: claims audit, security, correctness, test integrity, silent failure. All 14 claims in the PR body verified TRUE independently, including the base test count. Four findings refuted with measurements, one of them a reassurance from the lens that reported nothing, which turned out to be the only claim in the round that was false. Three real out-of-scope findings became SEC-10, OBS-8, TEST-9 and TEST-10. One fix landed, a fail-closed test for a malformed body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **S0.7 done**            | `63b0cda`, `04c5d52`                                                                   | 2026-07-30 | **Closes TEST-2.** `createApiApp` separates app construction from listening, and `startTestApi` binds the real app to an ephemeral port and drives it with `fetch`, so middleware order, body parsing, status codes and the error handler all run. No new dependency, node 22 has `fetch`. Five cases, uploader suite 94 to 99. `requestUntil` exists because `startStream` queues uploader construction, so a stream is not addressable when `/stream/start` returns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **TEST-9 done**          | `04d0323`                                                                              | 2026-07-30 | **Closes TEST-9.** `tsconfig.test.json` puts `test/` under the same compiler options and the package `typecheck` script uses it, while `build` keeps the src-only config. Turning it on surfaced ten pre-existing errors in `OmeHlsPuller.test.ts`, which reached into private members through an `OmeHlsPuller & PullerInternals` intersection that TypeScript reduces to `never`. It paid for itself within the hour: S2.1's new required config field broke `StreamOrchestrator.test.ts` and typecheck caught it before the test run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **S2.1 done**            | `9c17965`                                                                              | 2026-07-30 | **Closes OBS-1.** `deriveHealthStatus` holds the whole policy as one pure function. Degrades on three consecutive manifest publish failures, on high queue pressure, or on a registered stream silent for `SEGMENT_STALL_MS`, and degraded answers 503. Three rather than one because a failed publish retries at the same SOC index on the next segment, so one or two self-heal and would only flap the endpoint. All four states proven end to end over HTTP, boundaries asserted either side. Nothing restarts on the 503: no compose healthcheck exists and `health.sh` treats a non-200 as a warning. Suite 99 to 114.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **SEC-11 closed**        | `e5ae217`, `0f92a3d`                                                                   | 2026-07-30 | **Closes SEC-11.** Owner decision: the OME admission sample ships an empty value, so a first deploy stops at a named startup error rather than running a secret published in this repository. Measured both ways against `createOmeEngineFromEnv` rather than assumed. `setup.sh` now prints the generator command when it creates the file. The rejected alternative was generating a secret in `setup.sh`, an OPS change to a script that touches live deployments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Gate on #30**          | `408d366`, `4b07988`, `402a927`, `19549ad`, `6c9d7fb`, `3bcd955`                       | 2026-07-30 | Six lenses: claims audit, correctness, security, silent failure, config consistency, test integrity. **The widest gate result so far, and the first where the change under review was substantially wrong.** One CRITICAL: a refused segment upload was invisible to all three signals at once, so `/health` answered `200 ok` while every segment was lost, reproduced before fixing. Four lenses independently found the stall clock was one process-wide scalar, masking a dead stream behind a live one. A normal drain and every crash recovery both reported degraded. `SEGMENT_STALL_MS` could not be set in a container. The `setup.sh` warning added hours earlier fired only when false. Ten findings fixed, eight rejected with disproofs, five new register rows. Test integrity ran 36 mutations, 27 caught and 9 survived, and following the survivors found a further defect in the fix itself. Claims audit: 33 TRUE, 1 MISLEADING, 1 UNVERIFIABLE, 0 FALSE. Suite 114 to 126.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **S0.6 done**            | `4f44e85`                                                                              | 2026-07-30 | **Closes S0.6 and the fetch half of ARCH-2.** All three of the puller's fetch call sites went through the global. A `PullerOptions` object replaces the trailing optional `onHalt` parameter rather than adding an eighth positional argument, and the fetcher defaults to global `fetch`. Three tests with no network: master to variant resolution, a 404 leaving the puller retrying rather than latching a dead variant, and a hang. The hang test asserts the tick does **not** settle, documenting the gap S2.2 closes instead of pretending it is shut. Suite 128 to 131.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **S0.5 done**            | `1a0e47f`                                                                              | 2026-07-30 | **Closes S0.5 and the timing half of TEST-4 and TEST-6.** A `Clock` supplies a monotonic `now` and a cancellable `setTimer`, defaulting to the real clock so no call site changes. `FakeClock` advances time on demand. The acceptance test advances past 60s and finalizes the unfed recovered stream, and it also closes TEST-4 by asserting the VOD entry landed and the recovery state was cleared, since reaching an active count of zero passes even when nothing was published. One deliberate behaviour change: the recovery handler was an async callback whose rejection nobody could observe, and it now routes failures through ErrorHandler. Measured, 128 tests in 2492ms becomes 134 in 2389ms, so the criterion's "wall time does not increase" holds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Gate amendment**       | `0d65d84`, `83bb8e6`, `abb4258`                                                        | 2026-07-30 | **PR #33.** The owner's lens-selection rule lives in `review-gate.md` now rather than only in session notes, which is why it kept not being followed. R1's floor of three reviewers plus the claims auditor is withdrawn, R4 requires the posted result to name both the lenses that ran and the ones selected against, fail-closed keys on a selected lens that did not run, and the sprint exit gate gains the full-catalogue deep run as a fifth condition. Ten measured prompt rules moved in alongside it. The follow-up had been deferred across three PRs behind a defensible reason, that amending the gate deserves its own gate, which is how a deferral turns into an omission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Gate on #33**          | `98fffa1`, `4b0fda5`, `f7c1bc0`, `13e8874`, `ca52502`, `5e7aa7f`, `fbe9e75`, `82a26ca` | 2026-07-30 | Three lenses, selected by surface: claims audit, config consistency, protocol correctness. **The last of those was not in the catalogue, and having to invent it was the round's most useful finding**, so it is a row now. Seven findings, all confirmed, none refuted, so the rejected-findings tables are unchanged. The one that mattered: adding the deep run updated the handoff's copy of the sprint exit gate and left the register's copy saying "all four", and the condition missing from it was the deep run itself, the whole mechanism that makes narrow per-PR selection safe. That duplicate is gone rather than synced. Two clauses turned out to have no artifact behind them, the pre-launch selection and the new ban on lenses reading `docs/reviews/`, which R1 contradicts on exactly the pull requests that amend this document. Claims audit: 22 TRUE, 3 MISLEADING, 2 FALSE, 5 UNVERIFIABLE, every error in the description rather than in the diff, including the prompt-rules section asserting its own measurements as evidence.                                                                                                                                                                                                                                                                                                                                                          |
| **S2.2 uploader half**   | `a4c7149`, `a87230b`, `f0c0ee5`                                                        | 2026-07-30 | **Closes the uploader half of OBS-2.** All three puller calls route through one `fetchWithTimeout` with a fresh `AbortSignal.timeout`, settable with `OME_FETCH_TIMEOUT_MS` and defaulting to 10s, and an abort logs at error level where an ordinary failure stays at warn. The test that occupied this spot was inert: its fake ignored the abort signal handed to it, so it passed identically with and without a timeout. OBS-2's own site list was corrected in the same round, from four sites to six.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Gate on #34, round 1** | posted on the pull request                                                             | 2026-07-30 | Six lenses: claims audit, test integrity, silent failure, correctness, config consistency, concurrency. **Blocked the pull request.** One HIGH regression the change itself introduced, found independently by three lenses and measured against the real orchestrator and real `/health`: an aborted segment was dropped permanently while `lastSeq` advanced past it, so half a stream could be lost with `/health` never leaving 200. Concurrency proved the base behaviour hung instead and was caught at 503, so the branch traded a detected outage for undetected loss, and measured that the fix one lens proposed closed one door of four. Test integrity ran 30 mutations with 12 surviving. Two further findings became OBS-12 and TEST-15. Also a process finding against the gate itself, five lenses sharing one working tree with two of them mutating source, now a prompt rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **OBS-11 closed**        | `366e1e5`, `e1719df`                                                                   | 2026-07-30 | **Closes OBS-11**, both halves. Every failure ends the pass so the next tick re-pulls the same index, and `lastSeq` advances past an undelivered segment only inside `reportSegmentLoss`, which announces it through a new `handleSegmentLoss` seam. A segment is written off after three consecutive failed passes or when it disappears from the playlist, so one bad segment can neither be skipped silently nor park the live edge indefinitely. The loss is not counted as stream activity and is queued behind pending uploads, either of which would have re-opened the finding. Ten mutations, ten killed. Suite 145 to 155.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **OBS-11 follow-up**     | `5be1a72`                                                                              | 2026-07-30 | A defect in the OBS-11 fix, found before the second gate by asking what the origin controls rather than by review. The roll-out scan walked every missing index between the last delivered segment and the next one, and a restarted OME picks that number through `#EXT-X-MEDIA-SEQUENCE`. Measured: a gap of one million kills the test process, and 2^31 is reachable from one value. A gap is now one report carrying its size, and the failure counter moves once per gap rather than once per segment, which is the distinction that measures how often delivery broke. Four mutations, four killed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Gate on #34, round 2** | posted on the pull request                                                             | 2026-07-30 | Six lenses: claims audit, correctness, silent failure, concurrency, config consistency, test integrity. **Zero refutations, every finding confirmed.** Three lenses independently found the round 1 fix incomplete, and the claims auditor found ten defects in the description plus one in the author's method. The blocking one: a lost segment was counted on a consecutive counter that clears on the next success, and the puller writes a segment off and downloads the next one in the same pass, so the clearing success always landed first. Measured on the real puller, 108 samples all read zero, and 3623 polls over a socket all answered 200 ok. The test meant to prove it called the seam directly, which is why it passed. Test integrity ran 95 mutations with 36 surviving, 11 closed and the rest recorded as TEST-16.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Round 2 fixes**        | `7bd32b9`, `6e704e1`, `e701146`, `505d830`, `6103ae3`                                  | 2026-07-30 | A loss now has its own reason `segment_loss` reported as an age, since nothing later makes a loss untrue and there is no consecutive run to measure. `handleSegmentLoss` answers whether anything recorded the gap, so the puller holds rather than stepping over indexes nobody saw. The roll-out floor is the first index a puller ever saw rather than `lastSeq`, which is -1 until the first delivery, so cold-start and crash-recovery gaps were exactly the ones excluded. A loss after a stop is not reported, so it cannot land on the next session. And the logger renders an error by its message: every handler passes errors straight through and `JSON.stringify` renders one as `{}`, so OBS-12's named startup error read `Failed to start: {}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **S1.1 done**            | `a776563`, `704e4aa`                                                                   | 2026-07-31 | **Closes the `/stream/*` half of SEC-1**, the last unclosed CRITICAL. A bearer gate on the router, not in the handlers, so a later route is covered by construction. The tests spy on the orchestrator rather than reading status codes, because a 401 returned after a segment was already uploaded and paid for satisfies a code assertion and none of the point. Constant-time comparison, case-insensitive scheme per RFC 7235, nothing echoed back. `API_AUTH_TOKEN` required with a 32 character floor, sample empty so a first deploy stops at a named error. Eight mutations, seven killed. **This breaks every existing deployment until an operator sets the variable**, which is the intended direction. S1.2, the `/engines/*` half, is blocked on an owner decision rather than on work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Gate on #35**          | posted on the pull request                                                             | 2026-07-31 | Five lenses: claims audit, security, correctness, config consistency, test integrity. **No auth bypass**, established over 30 raw-socket request-targets covering encodings, traversal, double slashes, absolute-form targets and matrix parameters, all 401 with the orchestrator spy at zero. Everything else was found and fixed. Correctness: a non-ASCII token passed validation and then locked every caller out permanently, because a header arrives latin1-decoded and the comparison re-encoded it as UTF-8, with a split-brain variant where Node fetch authenticated and curl did not, so a green e2e suite would have hidden it. Security: 50MB was buffered per anonymous connection before the gate, 583MB of RSS for eight of them, so the gate moved ahead of the parsers. Config consistency: the paragraph added to the README turned the `GET /health` row into prose and prettier could not see it. Claims audit: the justification for leaving `/health` open named compose healthchecks, which do not exist anywhere in the repo and which the handoff had already recorded as not existing.                                                                                                                                                                                                                                                                                                    |
| **S1.2 done**            | `1f9f34e`, `fdd2fe3`                                                                   | 2026-07-31 | **Closes SEC-1 entirely.** Owner took the URL-secret mechanism on 2026-07-31. `SRS_WEBHOOK_TOKEN` rides in the hook URL because SRS 6 offers no HMAC and no custom header, so the register's "correctly signed" criterion is unachievable and this is the nearest achievable thing. `requestLogger` redacts it, tested against four shapes rather than the one produced today. Router-mounted, constant-time, empty rejects rather than disables, unreserved URL characters enforced at construction. `entrypoint.sh` refuses to start on an empty value. Suite 222 to 237. **Not yet gated: PR not opened.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **OBS-12 closed**        | `59e261e`                                                                              | 2026-07-30 | **Closes OBS-12.** `optionalInt` checks the whole string rather than a prefix and a per-variable range, and throws where it is read. `0`, `-1`, `2147483648` and `10s` now stop startup with a named error instead of disabling the puller once a stream begins. Ranges are per call site because the constraints differ: `API_PORT` allows zero for an ephemeral port, everything else has a floor of 1, and the default ceiling is `setTimeout`'s 32-bit limit. Covers every `optionalInt` variable, not only the one that exposed it. Seven mutations, seven killed. Suite 155 to 167.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **TEST-15 closed**       | `e00210b`                                                                              | 2026-07-30 | **Closes TEST-15.** `OmeEngineSeams` gives the environment path an injectable fetcher, which is what makes the abort window observable from outside the module, and it deliberately carries no configuration so a test cannot prove a plumbing path a deployment lacks. The test drives one real admission lifecycle, opening to closing, so the file gains no timer of its own. Also closed: the media playlist call site, the fresh-signal-per-call rationale, the `AbortError` arm and the ordinary-failure half of the abort distinction at both log sites. All twelve surviving mutations killed. Suite 167 to 179.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **S2.2 uploader half**   | `a4c7149`, `a87230b`, `f0c0ee5`                                                        | 2026-07-30 | **Closes the uploader half of OBS-2.** All three puller calls route through one `fetchWithTimeout`, so a new call site cannot forget the window, each with a fresh `AbortSignal.timeout` rather than a shared signal that would abort later requests the instant the first window elapsed. An abort logs at error level where an ordinary failure stays at warn, since a cut-off request is otherwise indistinguishable from a healthy stream. `OME_FETCH_TIMEOUT_MS`, default 10s, and `a87230b` is there because `a4c7149` shipped it unreachable in a container, repeating the `SEGMENT_STALL_MS` miss the #30 gate caught. The test in this spot was **inert**: its fake ignored the abort signal, so it passed with and without a timeout. Replaced with fakes that reject with `signal.reason`, the real `TimeoutError`. Suite 142 to 145.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **SEC-7 closed**         | PR #39, merged as `976acec`                                                            | 2026-07-31 | **Closes SEC-7.** `pnpm audit` 63 findings to 3, including the one critical, through `pnpm.overrides` plus three allowlisted residuals that each carry a written reason. A new `packages/audit-gate` runs in CI on push, on pull requests and on a weekly cron, and fails on anything the allowlist does not cover, on an exception whose severity or patched range has drifted, and on a report whose finding counts do not reconcile with its advisory list, which is what catches a suppression added through `pnpm.auditConfig`. 38 tests. Two findings from its own gate round were fixed before merge. **Dependabot is not a substitute:** it scans the default branch only, and separately lagged the advisory data `pnpm audit` reads by 4 GHSAs to 7 on three packages at identical versions. See SEC-16 through SEC-19. PR #13 into `main` is superseded, and closing it is the owner's call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **CON-19 closed**        | `af9ef76`                                                                              | 2026-07-31 | **Closes CON-19, and CON-16 stands.** The flake was in the acceptance test, not the engine. It restarted its fake origin before posting the announce, an ordering OME cannot produce because the admission webhook gates the publish, and in that gap the replaced puller delivered the restarted origin into the session it replaced. Reproduced on demand by widening the gap to 120ms, and under 24 busy loops on 12 cores, where the old order fails 3 of 15 and the new one 0 of 15. That is the same fault reproduced, not the same rate: CI's own figure is 2 of 16, counted across every commit carrying the test. The window itself is unclosable, see CON-17 for why a puller-local restart detector cannot converge. Mutation-checked rather than assumed: the pre-CON-16 `startStream` fails the reordered test 20 of 20. Suite stays at 274.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **OPS-2 closed**         | `aed89cb`, `35b12b3`                                                                   | 2026-07-31 | **Closes OPS-2, on the second attempt.** `clean.sh <service>` destroyed the whole stack two different ways. First, the straggler sweep filtered on the compose project label alone, in three places rather than the one the row named: local, inside the ssh heredoc, and a post-loop sweep that fires when `config.json` no longer lists localhost. Second, and missed by the first fix, **`docker compose down` ignores `--profile`**, measured against real Compose v5.3.1 on this repo's own file, so the step before the sweep removed every co-located service anyway. A named service now tears down through `rm --stop --force <services>`, which honours an explicit list, and `down` is reserved for the unfiltered case where project networks and orphans are the actual request. `--volumes` with a service is refused rather than narrowed, since compose volumes carry no per-service label. New `deploy` workspace package: 12 tests driving the real script against a stubbed `docker` and `ssh`, the ssh stub executing what it is handed rather than matching its text. Eight mutations, each killed by the test that owns it.                                                                                                                                                                                                                                                                      |
| **OBS-2 closed**         | `64cefb6`, `fd0f11e`, `67e39c2`                                                        | 2026-07-31 | **Closes OBS-2's client half, also on the second attempt.** Three unbounded requests rather than the one the row named, `StreamPreview` carrying an unmount signal but no timeout. The first helper bounded only the wait for headers: `fetch` resolves there and the body is a separate stream, so a gateway answering 200 and withholding the body hung the caller with the timer already cleared and the caller's signal already unsubscribed. **A regression, not just a gap**, since `StreamPreview` previously passed its signal straight to `fetch` where it did abort the body, and worse than one preview because the thumbnail queue runs at concurrency 1. The body is now read inside the window. Built on `AbortController` and `setTimeout` rather than `AbortSignal.timeout`, which lands in Safari 16 against a declared target of Safari 14. A test asserts no call to the global `fetch` remains in `src`, including the `window.`, `globalThis.` and `self.` spellings its first version waved through. Suite 5 to 27.                                                                                                                                                                                                                                                                                                                                                                              |
| **CON-20 closed**        | `56d68ad`                                                                              | 2026-07-31 | **Closes CON-20, and it took a real OvenMediaEngine to close.** The row's open question was production reachability, and the suite could not settle it. A throwaway OME running this repo's own `Server.xml.template`, with a probe answering the admission webhook at the same point in the tick order the puller polls at, settled it: a reconnect 4.2s to 4.8s after an abrupt publisher drop read the outgoing broadcast's playlist **4 of 4**, at media sequence 5 with its five segments, and at 5.0s and beyond read 404 **0 of 4**. OME rejects the republish as a duplicate name 111ms after answering, so production gets a second VOD holding only the previous broadcast's tail, bought with postage. **The row's predicted consequence was refuted**: not a fabricated discontinuity but total silence, because both sessions restart the media sequence at zero, so the real broadcast lands below the high-water the stale tail leaves. Fixed with a floor taken from `#EXT-X-PROGRAM-DATE-TIME`, which the parser was discarding and which is the only field separating the two sessions: the media sequence restarts and the segment file names repeat byte for byte. Both sides of the comparison come from the origin's clock, and no counter crosses the session boundary, so neither CON-16 nor CON-17 is reopened. Mutation-checked at **10 of 10**, after two real survivors. Suite 274 to 282. |

### Sprint 0 remaining

`S0.3` and `S0.4` are not started. `S0.5`, `S0.6` and `S0.7` are done, in `1a0e47f`, `4f44e85` and
`63b0cda`. S0.6's fetcher seam did what this section predicted: it is what made S2.2's timeout provable
with no network. S0.4's FakeBee is largely built already in `test/helpers/fakes.ts`.

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
